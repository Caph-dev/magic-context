//! Measures what the single-store read seam costs per call on a real-sized store pair.
//!
//! Since the first cutover step, each store read of a session-keyed table asks two
//! questions before it reads any row: which projects `store.db` binds the session to
//! (through its transform roots), and whether any of those projects, or the projects
//! `context.db` records for the session, carries a single-store marker. This example
//! times those questions separately and together, on sessions of moved (marked)
//! projects and on sessions of projects that did not move, so the cost of answering
//! them on every call can be compared with the cost of the read itself.
//!
//! It only runs on a copy of a store pair under the system temp directory, never on the
//! live files. It reads rows and writes none; opening the store copy does take that
//! copy's writer lease, as any store open does.
//!
//! ```text
//! MC_ATTRIBUTION_DRILL_DIR=$TMPDIR/magic-context/<task>/drill \
//!     cargo run --release -p mc-module --example single_store_attribution_cost
//! ```
//!
//! The directory holds `context.db` and `store.db` after a real move. The output is one
//! JSON object per measurement with microsecond percentiles.

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use mc_module::single_store_reads::ContextDomainReader;
use mc_store::{McStore, SingleStoreDomain};
use rusqlite::{params, Connection, OpenFlags};

/// How many sessions of each kind are sampled, and how often each is read.
const SAMPLE_SESSIONS: usize = 300;
const ROUNDS: usize = 5;

fn percentiles(label: &str, kind: &str, samples: &mut [u128]) {
    samples.sort_unstable();
    let at = |pct: usize| samples[(samples.len() * pct / 100).min(samples.len() - 1)];
    let mean = samples.iter().sum::<u128>() as f64 / samples.len() as f64;
    println!(
        "{}",
        serde_json::json!({
            "measure": label,
            "sessions": kind,
            "calls": samples.len(),
            "mean_us": (mean * 10.0).round() / 10.0,
            "p50_us": at(50),
            "p90_us": at(90),
            "p99_us": at(99),
            "max_us": samples[samples.len() - 1],
        })
    );
}

fn time<T>(samples: &mut Vec<u128>, call: impl FnOnce() -> T) -> T {
    let started = Instant::now();
    let value = call();
    samples.push(started.elapsed().as_micros());
    value
}

fn main() {
    let Ok(dir) = std::env::var("MC_ATTRIBUTION_DRILL_DIR") else {
        eprintln!("set MC_ATTRIBUTION_DRILL_DIR to a copied store pair under the temp directory");
        std::process::exit(2);
    };
    let dir = PathBuf::from(dir).canonicalize().expect("drill dir exists");
    let temp_root = std::env::temp_dir()
        .canonicalize()
        .expect("temp dir exists");
    assert!(
        dir.starts_with(&temp_root),
        "this measurement runs only on copies under {}",
        temp_root.display()
    );
    let context_path = dir.join("context.db");
    let store_path = dir.join("store.db");

    let descriptor = cortexkit_store_types::StorageDescriptor {
        module_id: "magic-context-measure".to_string(),
        storage_namespace: "mc_cache".to_string(),
        isolation: cortexkit_store_types::Isolation::Module,
        backend: cortexkit_store_types::StorageBackend::Sqlite {
            path: store_path.to_string_lossy().into_owned(),
        },
    };
    // The copy has already been moved, so its store.db carries the single-store marker;
    // only a build that can serve moved projects may open it.
    let store = McStore::open_with_capability_for_test(&descriptor, true).expect("open store copy");
    let reader = Arc::new(ContextDomainReader::new(context_path.clone()));
    store.set_single_store_domain(reader.clone());

    // Side connections used only to pick sessions and to time the store half of the
    // attribution with the exact statement the store runs.
    let context = Connection::open_with_flags(&context_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .expect("open context copy");
    let side_store = Connection::open_with_flags(&store_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .expect("open store copy");

    let marked_projects: Vec<String> = context
        .prepare("SELECT project_path FROM single_store_projects ORDER BY project_path")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    // Marked sessions: the ones with the most compartments first, so the sample includes
    // the heavy sessions a real pass would read.
    let marked_sessions: Vec<String> = context
        .prepare(
            "SELECT sp.session_id
               FROM session_projects sp
               JOIN single_store_projects m ON m.project_path = sp.project_path
               LEFT JOIN compartments c ON c.session_id = sp.session_id
              GROUP BY sp.session_id
              ORDER BY COUNT(c.id) DESC, sp.session_id
              LIMIT ?1",
        )
        .unwrap()
        .query_map(params![SAMPLE_SESSIONS as i64], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    let marked_set: BTreeSet<String> = context
        .prepare(
            "SELECT DISTINCT sp.session_id FROM session_projects sp
               JOIN single_store_projects m ON m.project_path = sp.project_path",
        )
        .unwrap()
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    // Unmarked sessions: sessions the store keeps cache state for that no marked project
    // claims, which read store.db after the attribution answers "not moved".
    let mut unmarked_sessions = Vec::new();
    for session in side_store
        .prepare("SELECT session_id FROM mc_cache_state ORDER BY last_activity_at DESC")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
    {
        let session = session.unwrap();
        if marked_set.contains(&session) {
            continue;
        }
        if reader
            .marked_project_for_session(&session, &store_projects(&side_store, &session))
            .unwrap()
            .is_none()
        {
            unmarked_sessions.push(session);
        }
        if unmarked_sessions.len() >= SAMPLE_SESSIONS {
            break;
        }
    }
    println!(
        "{}",
        serde_json::json!({
            "marked_projects": marked_projects.len(),
            "marked_sessions_total": marked_set.len(),
            "marked_sessions_sampled": marked_sessions.len(),
            "unmarked_sessions_sampled": unmarked_sessions.len(),
        })
    );

    for (kind, sessions) in [
        ("marked", &marked_sessions),
        ("unmarked", &unmarked_sessions),
    ] {
        if sessions.is_empty() {
            continue;
        }
        let mut store_half = Vec::new();
        let mut context_half = Vec::new();
        let mut attribution = Vec::new();
        let mut seam_read = Vec::new();
        let mut raw_store_read = Vec::new();
        for _ in 0..ROUNDS {
            for session in sessions.iter() {
                let bound = time(&mut store_half, || store_projects(&side_store, session));
                time(&mut context_half, || {
                    reader.marked_project_for_session(session, &bound).unwrap()
                });
                time(&mut attribution, || {
                    let bound = store_projects(&side_store, session);
                    reader.marked_project_for_session(session, &bound).unwrap()
                });
                // The whole seam as a caller sees it: attribution, then the read from
                // whichever file owns the session.
                time(&mut seam_read, || {
                    store.load_compartment_events(session).unwrap()
                });
                // The same read straight from store.db with no seam, for scale.
                time(&mut raw_store_read, || raw_events(&side_store, session));
            }
        }
        percentiles("store_half_transform_root_bindings", kind, &mut store_half);
        percentiles(
            "context_half_session_projects_and_marker",
            kind,
            &mut context_half,
        );
        percentiles("attribution_total", kind, &mut attribution);
        percentiles("seam_load_compartment_events", kind, &mut seam_read);
        percentiles(
            "raw_store_compartment_events_no_seam",
            kind,
            &mut raw_store_read,
        );
    }

    // The per-pass revision read for a moved session, once against context.db (where it
    // is served after the move) and once against the same project's retained rows in
    // store.db (where it was served before), with the pool filter the store uses for a
    // project outside any workspace.
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let mut context_heads = Vec::new();
    let mut store_heads = Vec::new();
    let mut project_of = context
        .prepare("SELECT project_path FROM session_projects WHERE session_id = ?1 LIMIT 1")
        .unwrap();
    let sampled: Vec<(String, String)> = marked_sessions
        .iter()
        .map(|session| {
            let project: String = project_of
                .query_row(params![session], |row| row.get(0))
                .unwrap();
            (session.clone(), project)
        })
        .collect();
    for _ in 0..ROUNDS {
        for (session, project) in &sampled {
            time(&mut context_heads, || {
                revision_heads(
                    &context,
                    "memories",
                    "memory_mutation_log",
                    "compartments",
                    project,
                    session,
                    now_ms,
                )
            });
            time(&mut store_heads, || {
                revision_heads(
                    &side_store,
                    "mc_memories",
                    "mc_memory_mutation_log",
                    "mc_compartments",
                    project,
                    session,
                    now_ms,
                )
            });
        }
    }
    percentiles("revision_heads_context_db", "marked", &mut context_heads);
    percentiles(
        "revision_heads_store_db_same_rows",
        "marked",
        &mut store_heads,
    );

    let mut marker = Vec::new();
    for _ in 0..ROUNDS * 20 {
        for project in &marked_projects {
            time(&mut marker, || reader.is_marked(project).unwrap());
        }
        time(&mut marker, || {
            reader.is_marked("/not/a/moved/project").unwrap()
        });
    }
    percentiles("is_marked", "projects", &mut marker);
}

/// The store half of a session's attribution, with the statement the store runs.
fn store_projects(conn: &Connection, session: &str) -> Vec<String> {
    conn.prepare_cached(
        "SELECT DISTINCT binding.project
           FROM mc_transform_session_roots AS roots
           JOIN mc_authority_route_bindings AS binding
             ON binding.route_project_root = roots.project_root
          WHERE roots.session_id = ?1
          ORDER BY binding.project",
    )
    .unwrap()
    .query_map(params![session], |row| row.get(0))
    .unwrap()
    .collect::<Result<_, _>>()
    .unwrap()
}

/// The three watermarks of the per-pass revision read, in one read transaction: the
/// highest render-eligible memory id, the highest mutation-log id and the session's
/// highest compartment sequence.
fn revision_heads(
    conn: &Connection,
    memories: &str,
    log: &str,
    compartments: &str,
    project: &str,
    session: &str,
    now_ms: i64,
) -> (i64, i64, i64) {
    let tx = conn.unchecked_transaction().unwrap();
    let memory: i64 = tx
        .prepare_cached(&format!(
            "SELECT COALESCE(MAX(id), 0) FROM {memories}
              WHERE (project_path = ?1) AND status IN ('active', 'permanent')
                AND (expires_at IS NULL OR expires_at > ?2)"
        ))
        .unwrap()
        .query_row(params![project, now_ms], |row| row.get(0))
        .unwrap();
    let mutation: i64 = tx
        .prepare_cached(&format!(
            "SELECT COALESCE(MAX(id), 0) FROM {log} WHERE project_path IN (?1)"
        ))
        .unwrap()
        .query_row(params![project], |row| row.get(0))
        .unwrap();
    let sequence: i64 = tx
        .prepare_cached(&format!(
            "SELECT COALESCE(MAX(sequence), 0) FROM {compartments} WHERE session_id = ?1"
        ))
        .unwrap()
        .query_row(params![session], |row| row.get(0))
        .unwrap();
    tx.finish().unwrap();
    (memory, mutation, sequence)
}

/// A session's historian events read straight from store.db.
fn raw_events(conn: &Connection, session: &str) -> usize {
    conn.prepare_cached(
        "SELECT kind, at_compartment, compartment_id, fields_json, created_at, harness
           FROM mc_compartment_events WHERE session_id = ?1 ORDER BY id",
    )
    .unwrap()
    .query_map(params![session], |_| Ok(()))
    .unwrap()
    .count()
}
