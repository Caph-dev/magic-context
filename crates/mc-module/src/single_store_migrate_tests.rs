//! Tests for the one-time move of a project's rows into context.db.
//!
//! Every fixture lives in a temp directory: a store.db opened through `McStore` and a
//! context.db built from the committed schema snapshot at lane 93.

use super::*;
use rusqlite::Connection;
use serde_json::json;
use std::path::Path;

const SCHEMA_SNAPSHOT: &str = include_str!("../tests/fixtures/context-db-schema.sql");

const P: &str = "git:project-p";
const Q: &str = "git:project-q";
const UUID: &str = "uuid-fixture";
const P_ROOT: &str = "/work/project-p";
const LARGE_SESSION: &str = "ses-p3-large";
const LARGE_SESSION_COMPARTMENTS: i64 = 300;

pub(super) struct Fixture {
    pub dir: tempfile::TempDir,
}

impl Fixture {
    pub fn context(&self) -> PathBuf {
        self.dir.path().join("context.db")
    }

    pub fn store_path(&self) -> PathBuf {
        self.dir.path().join("store.db")
    }

    pub fn open_store(&self) -> McStore {
        let store = McStore::open_with_capability_for_test(
            &crate::test_support::descriptor(self.dir.path()),
            true,
        )
        .expect("open fixture store");
        store.set_project_write_gate(std::sync::Arc::new(CopyWriteGate::for_store(&store)));
        store
    }

    pub fn options(&self) -> MigrateOptions {
        let mut options = MigrateOptions::new(self.context());
        options.assume_cutover = true;
        options
    }

    pub fn context_conn(&self) -> Connection {
        Connection::open(self.context()).expect("open fixture context.db")
    }

    pub fn store_conn(&self) -> Connection {
        Connection::open(self.store_path()).expect("open fixture store.db")
    }
}

pub(super) fn request(project: &str) -> MigrateRequest {
    MigrateRequest {
        project: project.to_string(),
        dry_run: false,
        retry: false,
    }
}

fn hash(content: &str) -> String {
    mc_store::compute_normalized_memory_hash(content)
}

/// Run `body` with the context.db privilege bracket set, the way a host writes rows of a
/// managed project.
fn privileged(conn: &Connection, body: impl FnOnce(&Connection)) {
    conn.execute(
        "UPDATE context_privilege_state SET enabled = 1 WHERE id = 1",
        [],
    )
    .unwrap();
    body(conn);
    conn.execute(
        "UPDATE context_privilege_state SET enabled = 0 WHERE id = 1",
        [],
    )
    .unwrap();
}

fn build_context(path: &Path) {
    let conn = Connection::open(path).unwrap();
    // Hosts keep context.db in WAL mode; a seat writing beside the move depends on it.
    conn.pragma_update(None, "journal_mode", "WAL").unwrap();
    conn.execute_batch(SCHEMA_SNAPSHOT).unwrap();
    conn.execute(
        "INSERT OR IGNORE INTO context_privilege_state(id, enabled) VALUES (1, 0)",
        [],
    )
    .unwrap();
    for version in 1..=MARKER_LANE_VERSION {
        conn.execute(
            "INSERT OR IGNORE INTO schema_migrations(version, description, applied_at)
             VALUES (?1, 'fixture', 0)",
            params![version],
        )
        .unwrap();
    }
    conn.execute(
        "INSERT INTO context_store_meta(key, value) VALUES ('store_uuid', ?1)",
        params![UUID],
    )
    .unwrap();
}

fn store_memory(conn: &Connection, id: i64, project: &str, content: &str, superseded: Option<i64>) {
    conn.execute(
        "INSERT INTO mc_memories
           (id, project_path, category, content, normalized_hash, importance, scope, shareable,
            source_session_id, status, first_seen_at, created_at, updated_at, last_seen_at,
            superseded_by_memory_id)
         VALUES (?1, ?2, 'ARCHITECTURE', ?3, ?4, 50, 'project', 0, 'ses-p1', 'active',
                 ?5, ?5, ?5, ?5, ?6)",
        params![id, project, content, hash(content), 1_000 + id, superseded],
    )
    .unwrap();
}

/// Put a memory into context.db as the mirror would have: same values, identity row.
fn mirror_memory(context: &Connection, store: &Connection, store_id: i64) -> i64 {
    let (project, content, stamp): (String, String, i64) = store
        .query_row(
            "SELECT project_path, content, created_at FROM mc_memories WHERE id = ?1",
            params![store_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    let mut id = 0;
    privileged(context, |conn| {
        conn.execute(
            "INSERT INTO memories
               (project_path, category, content, normalized_hash, importance, scope, shareable,
                source_session_id, source_type, seen_count, retrieval_count, status,
                verification_status, first_seen_at, created_at, updated_at, last_seen_at)
             VALUES (?1, 'ARCHITECTURE', ?2, ?3, 50, 'project', 0, 'ses-p1', 'historian', 1, 0,
                     'active', 'unverified', ?4, ?4, ?4, ?4)",
            params![project, content, hash(&content), stamp],
        )
        .unwrap();
        id = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO mirror_identity(domain, module_project, module_row_id, context_row_id)
             VALUES ('memories', ?1, ?2, ?3)",
            params![project, store_id, id],
        )
        .unwrap();
    });
    id
}

fn store_note(
    conn: &Connection,
    project: &str,
    kind: &str,
    session: Option<&str>,
    content: &str,
    status: &str,
    seeded_from: Option<i64>,
) -> i64 {
    conn.execute(
        "UPDATE mc_privilege_state SET note_caller_project = ?1 WHERE id = 1",
        params![project],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO mc_notes(type, project_path, session_id, content, status, created_at_ms,
                              updated_at_ms, context_store_uuid, context_row_id)
         VALUES (?1, ?2, ?3, ?4, ?5, 2000, 2001, ?6, ?7)",
        params![
            kind,
            project,
            session,
            content,
            status,
            seeded_from.map(|_| UUID),
            seeded_from
        ],
    )
    .unwrap();
    let id = conn.last_insert_rowid();
    conn.execute(
        "UPDATE mc_privilege_state SET note_caller_project = '' WHERE id = 1",
        [],
    )
    .unwrap();
    id
}

fn store_compartment(conn: &Connection, session: &str, sequence: i64, title: &str) {
    conn.execute(
        "INSERT INTO mc_compartments(session_id, sequence, start_message, end_message,
                                     start_message_id, end_message_id, title, content, p1,
                                     importance, legacy, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, 50, 0, ?9)",
        params![
            session,
            sequence,
            sequence * 10,
            sequence * 10 + 9,
            format!("m{}", sequence * 10),
            format!("m{}", sequence * 10 + 9),
            title,
            format!("{title} body"),
            3_000 + sequence
        ],
    )
    .unwrap();
}

fn store_event(conn: &Connection, session: &str, sequence: i64, kind: &str) {
    conn.execute(
        "INSERT INTO mc_compartment_events(session_id, compartment_id, at_compartment, kind,
                                           fields_json, created_at)
         VALUES (?1, ?2, ?2, ?3, '{}', ?4)",
        params![session, sequence, kind, 4_000 + sequence],
    )
    .unwrap();
}

fn store_primer(conn: &Connection, project: &str, session: &str, index: i64) {
    conn.execute(
        "INSERT INTO mc_primer_candidates(project_path, session_id, question, normalized_question,
                                          source_compartment_start, source_compartment_end,
                                          source_start_message_id, source_end_message_id,
                                          source_message_time, created_at)
         VALUES (?1, ?2, ?3, ?3, 1, 2, ?4, ?5, 5000, 5001)",
        params![
            project,
            session,
            format!("question {index}"),
            format!("s{index}"),
            format!("e{index}")
        ],
    )
    .unwrap();
}

fn store_candidate(conn: &Connection, session: &str, content: &str, start: i64, end: i64) {
    conn.execute(
        "INSERT INTO mc_user_memory_candidates(content, session_id, source_compartment_start,
                                               source_compartment_end, created_at)
         VALUES (?1, ?2, ?3, ?4, 6000)",
        params![content, session, start, end],
    )
    .unwrap();
}

fn session_project(context: &Connection, session: &str, project: &str, harness: &str) {
    context
        .execute(
            "INSERT INTO session_projects(session_id, harness, project_path, updated_at)
             VALUES (?1, ?2, ?3, 1)",
            params![session, harness, project],
        )
        .unwrap();
}

/// P: memories (some already mirrored, one stale, one superseded by a later one), notes
/// (smart, a surfaced one, and a session note seeded from a project-less context note
/// with no identity row), three sessions of compartments (one over the 256-row chunk),
/// events, primers and user-memory candidates. Q: a small sibling already mirrored.
pub(super) fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let fixture = Fixture { dir };
    build_context(&fixture.context());
    drop(fixture.open_store());
    let store = fixture.store_conn();
    let context = fixture.context_conn();

    for (project, root) in [(P, P_ROOT), (Q, "/work/project-q")] {
        for domain in ["memories", "notes"] {
            store
                .execute(
                    "INSERT INTO mc_authority(context_store_uuid, project, domain, state, generation)
                     VALUES (?1, ?2, ?3, 'MODULE', 3)",
                    params![UUID, project, domain],
                )
                .unwrap();
        }
        store
            .execute(
                "INSERT INTO mc_authority_route_bindings(route_project_root, context_store_uuid, project)
                 VALUES (?1, ?2, ?3)",
                params![root, UUID, project],
            )
            .unwrap();
        context
            .execute(
                "INSERT INTO authority_managed(project_path, context_store_uuid, marked_at)
                 VALUES (?1, ?2, 1)",
                params![project, UUID],
            )
            .unwrap();
    }
    // ses-p1 is known to the store through its route root; every P session is also in
    // session_projects, as a host-backed project's sessions are.
    store
        .execute(
            "INSERT INTO mc_transform_session_roots(session_id, project_root, observed_at)
             VALUES ('ses-p1', ?1, 9999999999999)",
            params![P_ROOT],
        )
        .unwrap();
    for session in ["ses-p1", "ses-p2", LARGE_SESSION] {
        session_project(&context, session, P, "opencode");
    }
    session_project(&context, "ses-q1", Q, "opencode");

    for id in 1..=40 {
        let superseded = (id == 5).then_some(30);
        store_memory(&store, id, P, &format!("p memory {id}"), superseded);
    }
    for id in 1..=10 {
        mirror_memory(&context, &store, id);
    }
    // A stale mirror: the context row says something the store no longer says.
    let stale = mirror_memory(&context, &store, 11);
    privileged(&context, |conn| {
        conn.execute(
            "UPDATE memories SET content = 'an older wording' WHERE id = ?1",
            params![stale],
        )
        .unwrap();
    });
    for id in 101..=103 {
        store_memory(&store, id, Q, &format!("q memory {id}"), None);
        mirror_memory(&context, &store, id);
    }

    store_note(&store, P, "smart", None, "smart note one", "active", None);
    store_note(
        &store,
        P,
        "smart",
        Some("ses-p1"),
        "smart note two",
        "surfaced",
        None,
    );
    // The host wrote this session note with no project; the seed copied it to the store
    // and recorded where it came from, but no identity row exists for it.
    let mut seeded = 0;
    privileged(&context, |conn| {
        conn.execute(
            "INSERT INTO notes(type, status, content, session_id, project_path, created_at, updated_at)
             VALUES ('session', 'active', 'a session note', 'ses-p2', NULL, 2000, 2001)",
            [],
        )
        .unwrap();
        seeded = conn.last_insert_rowid();
    });
    store_note(
        &store,
        P,
        "session",
        Some("ses-p2"),
        "a session note",
        "active",
        Some(seeded),
    );
    store_note(&store, Q, "smart", None, "q note", "active", None);

    for sequence in 1..=5 {
        store_compartment(&store, "ses-p1", sequence, &format!("p1 c{sequence}"));
    }
    for sequence in 1..=3 {
        store_compartment(&store, "ses-p2", sequence, &format!("p2 c{sequence}"));
    }
    for sequence in 1..=LARGE_SESSION_COMPARTMENTS {
        store_compartment(
            &store,
            LARGE_SESSION,
            sequence,
            &format!("large c{sequence}"),
        );
    }
    for sequence in 1..=2 {
        store_compartment(&store, "ses-q1", sequence, &format!("q c{sequence}"));
    }
    for sequence in 1..=4 {
        store_event(&store, "ses-p1", sequence, "decision");
    }
    for index in 1..=3 {
        store_primer(&store, P, "ses-p1", index);
    }
    store_candidate(&store, "ses-p2", "likes short answers", 1, 2);
    store_candidate(&store, "ses-p2", "uses vim", 2, 3);
    fixture
}

/// Every row of `table` matching `filter` (bound to `args`), all columns, ordered by id,
/// as one string per row.
pub(super) fn dump(conn: &Connection, table: &str, filter: &str, args: &[SqlValue]) -> Vec<String> {
    let sql = format!("SELECT * FROM {table} WHERE {filter} ORDER BY 1");
    let mut statement = conn.prepare(&sql).unwrap();
    let width = statement.column_count();
    statement
        .query_map(params_from_iter(args.iter()), |row| {
            let mut values = Vec::new();
            for index in 0..width {
                values.push(format!("{:?}", row.get::<_, SqlValue>(index)?));
            }
            Ok(values.join("|"))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
}

/// Everything in context.db that belongs to `project` or its `sessions`.
pub(super) fn project_state(conn: &Connection, project: &str, sessions: &[&str]) -> Vec<String> {
    let p = [text(project)];
    let mut state = Vec::new();
    for (table, filter) in [
        ("memories", "project_path = ?1"),
        ("notes", "project_path = ?1"),
        ("primer_candidates", "project_path = ?1"),
        ("memory_embedding_watermarks", "project_path = ?1"),
        ("mirror_identity", "module_project = ?1"),
        ("single_store_projects", "project_path = ?1"),
        ("authority_managed", "project_path = ?1"),
    ] {
        state.push(format!("-- {table}"));
        state.extend(dump(conn, table, filter, &p));
    }
    for session in sessions {
        let s = [text(session)];
        for table in [
            "compartments",
            "compartment_events",
            "user_memory_candidates",
            "notes",
        ] {
            state.push(format!("-- {table} {session}"));
            state.extend(dump(
                conn,
                table,
                "session_id = ?1 AND (?1 IS NOT NULL)",
                &s,
            ));
        }
    }
    state
}

pub(super) fn authority_states(store: &Connection, project: &str) -> Vec<(String, String)> {
    let mut statement = store
        .prepare("SELECT domain, state FROM mc_authority WHERE project = ?1 ORDER BY domain")
        .unwrap();
    statement
        .query_map(params![project], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
}

fn marker_rows(conn: &Connection) -> Vec<(String, String)> {
    let mut statement = conn
        .prepare("SELECT project_path, marked_by_version FROM single_store_projects ORDER BY 1")
        .unwrap();
    statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
}

fn context_memory_for(context: &Connection, store_id: i64) -> i64 {
    context
        .query_row(
            "SELECT context_row_id FROM mirror_identity
              WHERE domain = 'memories' AND module_project = ?1 AND module_row_id = ?2",
            params![P, store_id],
            |row| row.get(0),
        )
        .unwrap()
}

#[test]
fn a_move_copies_every_project_row_and_leaves_the_sibling_untouched() {
    let fixture = fresh();
    let q_before = project_state(&fixture.context_conn(), Q, &["ses-q1"]);
    let store = fixture.open_store();
    let report = run(&store, &request(P), &fixture.options(), &mut NoObserver).unwrap();
    assert_eq!(report.status, "migrated");
    assert!(report.marker_committed && report.neutralized);

    let context = fixture.context_conn();
    let store_conn = fixture.store_conn();

    // Memories: every store row has a context twin with the same fields, the stale mirror
    // was brought up to date, and the supersession points at the context id of its target.
    let p_memories: i64 = context
        .query_row(
            "SELECT COUNT(*) FROM memories WHERE project_path = ?1",
            params![P],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(p_memories, 40);
    for store_id in 1..=40 {
        let (content, hash_value, created, superseded): (String, String, i64, Option<i64>) =
            store_conn
                .query_row(
                    "SELECT content, normalized_hash, created_at, superseded_by_memory_id
                   FROM mc_memories WHERE id = ?1",
                    params![store_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .unwrap();
        let context_id = context_memory_for(&context, store_id);
        let copied: (String, String, i64, String, Option<i64>) = context
            .query_row(
                "SELECT content, normalized_hash, created_at, project_path, superseded_by_memory_id
                   FROM memories WHERE id = ?1",
                params![context_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .unwrap();
        let expected_superseded = superseded.map(|target| context_memory_for(&context, target));
        assert_eq!(
            copied,
            (
                content,
                hash_value,
                created,
                P.to_string(),
                expected_superseded
            ),
            "memory {store_id}"
        );
    }
    let superseded_5: Option<i64> = context
        .query_row(
            "SELECT superseded_by_memory_id FROM memories WHERE id = ?1",
            params![context_memory_for(&context, 5)],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(superseded_5, Some(context_memory_for(&context, 30)));

    // Notes: status vocabulary collapsed, timestamps renamed, and the seeded session note
    // is the one row it was, not a second copy.
    let notes = dump(
        &context,
        "notes",
        "project_path = ?1 OR (project_path IS NULL AND session_id IN ('ses-p1','ses-p2'))",
        &[text(P)],
    );
    assert_eq!(notes.len(), 3, "{notes:#?}");
    let session_notes: i64 = context
        .query_row(
            "SELECT COUNT(*) FROM notes WHERE content = 'a session note'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(session_notes, 1);
    let surfaced: (String, i64, i64) = context
        .query_row(
            "SELECT status, created_at, updated_at FROM notes WHERE content = 'smart note two'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(surfaced, ("ready".to_string(), 2000, 2001));

    // Compartments, per session, in order, including the session larger than one chunk.
    for (session, count) in [
        ("ses-p1", 5),
        ("ses-p2", 3),
        (LARGE_SESSION, LARGE_SESSION_COMPARTMENTS),
    ] {
        let rows: Vec<(i64, String, String, String)> = context
            .prepare(
                "SELECT sequence, title, harness, rebase_status FROM compartments
                  WHERE session_id = ?1 ORDER BY sequence",
            )
            .unwrap()
            .query_map(params![session], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(rows.len() as i64, count, "{session}");
        let store_titles: Vec<String> = store_conn
            .prepare("SELECT title FROM mc_compartments WHERE session_id = ?1 ORDER BY sequence")
            .unwrap()
            .query_map(params![session], |row| row.get(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            rows.iter().map(|row| row.1.clone()).collect::<Vec<_>>(),
            store_titles
        );
        assert!(rows.iter().all(|row| row.2 == "opencode" && row.3 == "ok"));
    }
    // Events point at the context compartment of the same sequence.
    let events: Vec<(i64, i64)> = context
        .prepare(
            "SELECT e.at_compartment, c.sequence FROM compartment_events e
               JOIN compartments c ON c.id = e.compartment_id
              WHERE e.session_id = 'ses-p1' ORDER BY e.id",
        )
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(events, vec![(1, 1), (2, 2), (3, 3), (4, 4)]);
    let primers: Vec<String> = context
        .prepare("SELECT harness FROM primer_candidates WHERE project_path = ?1")
        .unwrap()
        .query_map(params![P], |row| row.get(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(primers, vec!["opencode"; 3]);
    let candidates = dump(
        &context,
        "user_memory_candidates",
        "session_id = ?1",
        &[text("ses-p2")],
    );
    assert_eq!(candidates.len(), 2);

    // The watermark covers every memory the copy inserted.
    let (written, max_id): (i64, i64) = context
        .query_row(
            "SELECT (SELECT written_memory_id FROM memory_embedding_watermarks WHERE project_path = ?1),
                    (SELECT MAX(id) FROM memories WHERE project_path = ?1)",
            params![P],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(written, max_id);

    assert_eq!(
        marker_rows(&context),
        vec![(P.to_string(), build_version())]
    );
    assert_eq!(
        authority_states(&store_conn, P),
        vec![
            ("memories".into(), "TS".into()),
            ("notes".into(), "TS".into())
        ]
    );
    assert_eq!(
        authority_states(&store_conn, Q),
        vec![
            ("memories".into(), "MODULE".into()),
            ("notes".into(), "MODULE".into())
        ]
    );
    assert_eq!(project_state(&context, Q, &["ses-q1"]), q_before);

    assert_eq!(report.tables["memories"].source, 40);
    // Ten were mirrored already; one of them (5) lacked its supersession, and one (11) was
    // stale, so nine are left alone.
    assert_eq!(report.tables["memories"].skipped, 9);
    assert_eq!(report.tables["memories"].copied, 31);
    assert!(report.transaction_holds_us.len() > 3);
    println!(
        "largest transaction hold: {} us over {} transactions",
        report.max_hold_us,
        report.transaction_holds_us.len()
    );
    assert!(
        report.max_hold_us <= PUBLISH_CHUNK_BUDGET_US,
        "{:?}",
        report.transaction_holds_us
    );
    let phase = store.single_store_migration(P).unwrap().unwrap();
    assert_eq!(phase.phase, "neutralized");
}

type BetweenHook<'a> = Box<dyn FnMut(&Path, usize) + 'a>;
type InsideHook<'a> = Box<dyn FnMut(&Transaction<'_>, usize, bool) + 'a>;

/// An observer assembled from closures.
#[derive(Default)]
pub(super) struct Hooks<'a> {
    pub before_first_chunk: Option<Box<dyn FnMut() + 'a>>,
    pub between: Option<BetweenHook<'a>>,
    pub inside: Option<InsideHook<'a>>,
    pub before_final: Option<Box<dyn FnMut() + 'a>>,
    pub after_context_commit: Option<Box<dyn FnMut() + 'a>>,
}

impl MigrateObserver for Hooks<'_> {
    fn before_first_chunk(&mut self) {
        if let Some(hook) = self.before_first_chunk.as_mut() {
            hook();
        }
    }
    fn between_transactions(&mut self, context_db: &Path, committed: usize) {
        if let Some(hook) = self.between.as_mut() {
            hook(context_db, committed);
        }
    }
    fn inside_transaction(&mut self, tx: &Transaction<'_>, index: usize, is_final: bool) {
        if let Some(hook) = self.inside.as_mut() {
            hook(tx, index, is_final);
        }
    }
    fn before_final(&mut self) {
        if let Some(hook) = self.before_final.as_mut() {
            hook();
        }
    }
    fn after_context_commit(&mut self) {
        if let Some(hook) = self.after_context_commit.as_mut() {
            hook();
        }
    }
}

fn marker_present(context: &Path, project: &str) -> bool {
    Connection::open(context)
        .unwrap()
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM single_store_projects WHERE project_path = ?1)",
            params![project],
            |row| row.get(0),
        )
        .unwrap()
}

fn large_session_rows(context: &Path) -> i64 {
    Connection::open(context)
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM compartments WHERE session_id = ?1",
            params![LARGE_SESSION],
            |row| row.get(0),
        )
        .unwrap()
}

#[test]
fn the_marker_becomes_visible_only_together_with_the_final_rows() {
    let fixture = fresh();
    let store = fixture.open_store();
    let context_path = fixture.context();
    let between_checks = std::cell::Cell::new(0);
    let final_checked = std::cell::Cell::new(false);
    let mut hooks = Hooks {
        between: Some(Box::new(|context: &Path, _| {
            // A second connection between transactions: no marker yet.
            assert!(!marker_present(context, P));
            between_checks.set(between_checks.get() + 1);
        })),
        inside: Some(Box::new(|tx: &Transaction<'_>, _, is_final| {
            if !is_final {
                return;
            }
            // Inside the final transaction the writer sees its marker and the held-back
            // rows; another connection sees neither until the commit.
            let own: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM single_store_projects WHERE project_path = ?1)",
                    params![P],
                    |row| row.get(0),
                )
                .unwrap();
            assert!(own);
            assert!(!marker_present(&context_path, P));
            assert!(large_session_rows(&context_path) < LARGE_SESSION_COMPARTMENTS);
            final_checked.set(true);
        })),
        ..Hooks::default()
    };
    run(&store, &request(P), &fixture.options(), &mut hooks).unwrap();
    drop(hooks);
    assert!(between_checks.get() >= 3);
    assert!(final_checked.get());
    assert!(marker_present(&context_path, P));
    assert_eq!(
        large_session_rows(&context_path),
        LARGE_SESSION_COMPARTMENTS
    );
}

/// Every statement that inserts a single-store marker, in non-test source: there must be
/// exactly one, the final copy transaction's.
#[test]
fn only_the_final_copy_transaction_inserts_a_marker() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let pattern = regex::Regex::new(r"(?i)into\s+single_store_projects").unwrap();
    let mut found = Vec::new();
    let mut stack = vec![root.join("crates"), root.join("packages")];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("");
            if path.is_dir() {
                if !matches!(
                    name,
                    "node_modules" | "target" | "tests" | "dist" | "fixtures"
                ) {
                    stack.push(path);
                }
                continue;
            }
            let is_rust = name.ends_with(".rs");
            let is_ts = name.ends_with(".ts") && !name.ends_with(".test.ts");
            if !(is_rust || is_ts) || name.ends_with("_tests.rs") {
                continue;
            }
            let source = std::fs::read_to_string(&path).unwrap_or_default();
            // Inline Rust test modules start at the crate's conventional test marker.
            let production = if is_rust {
                source
                    .split("#[cfg(test)]\nmod tests")
                    .next()
                    .unwrap_or("")
                    .to_string()
            } else {
                source
            };
            for found_match in pattern.find_iter(&production) {
                let line = production[..found_match.start()].lines().count();
                found.push(format!("{}:{line}", path.display()));
            }
        }
    }
    assert_eq!(found.len(), 1, "{found:#?}");
    assert!(found[0].contains("single_store_migrate.rs"), "{found:#?}");
    assert!(MARKER_INSERT_SQL.contains("INSERT INTO single_store_projects"));
}

#[test]
fn a_copied_row_changed_between_chunks_is_refused_and_only_a_retry_repairs_it() {
    let fixture = fresh();
    let store = fixture.open_store();
    let corrupted = std::cell::Cell::new(false);
    let mut hooks = Hooks {
        between: Some(Box::new(|context: &Path, committed| {
            if committed != 1 {
                return;
            }
            // The first chunk wrote memory 12; something else changes one of its fields.
            let conn = Connection::open(context).unwrap();
            let id: i64 = conn
                .query_row(
                    "SELECT context_row_id FROM mirror_identity
                      WHERE domain = 'memories' AND module_project = ?1 AND module_row_id = 12",
                    params![P],
                    |row| row.get(0),
                )
                .unwrap();
            privileged(&conn, |conn| {
                conn.execute(
                    "UPDATE memories SET importance = 1 WHERE id = ?1",
                    params![id],
                )
                .unwrap();
            });
            corrupted.set(true);
        })),
        ..Hooks::default()
    };
    let before_served = project_state(&fixture.context_conn(), Q, &["ses-q1"]);
    let refusal = run(&store, &request(P), &fixture.options(), &mut hooks).unwrap_err();
    drop(hooks);
    assert!(corrupted.get());
    assert_eq!(refusal.code, VERIFY_MISMATCH, "{refusal}");
    assert!(!marker_present(&fixture.context(), P));
    let states = authority_states(&fixture.store_conn(), P);
    assert_eq!(
        states,
        vec![
            ("memories".into(), "MODULE".into()),
            ("notes".into(), "MODULE".into())
        ]
    );
    assert_eq!(
        project_state(&fixture.context_conn(), Q, &["ses-q1"]),
        before_served
    );

    // Without --retry the stored refusal is repeated and nothing is copied.
    let context_before = project_state(
        &fixture.context_conn(),
        P,
        &["ses-p1", "ses-p2", LARGE_SESSION],
    );
    let again = run(&store, &request(P), &fixture.options(), &mut NoObserver).unwrap_err();
    assert_eq!(again.code, VERIFY_MISMATCH);
    assert_eq!(
        project_state(
            &fixture.context_conn(),
            P,
            &["ses-p1", "ses-p2", LARGE_SESSION]
        ),
        context_before
    );

    // With --retry the changed row is written back and the move completes.
    let mut retry = request(P);
    retry.retry = true;
    let report = run(&store, &retry, &fixture.options(), &mut NoObserver).unwrap();
    assert_eq!(report.status, "migrated");
    let importance: i64 = fixture
        .context_conn()
        .query_row(
            "SELECT importance FROM memories WHERE id = (
                 SELECT context_row_id FROM mirror_identity
                  WHERE domain = 'memories' AND module_project = ?1 AND module_row_id = 12)",
            params![P],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(importance, 50);
}

#[test]
fn a_write_outside_the_declared_sessions_or_to_user_memories_rolls_back() {
    let fixture = fresh();
    let mut host = HostStore::open(&fixture.context()).unwrap();
    let sessions: BTreeSet<String> = ["ses-p1".to_string()].into();
    let mut attempt = |sql: &str| {
        let (conn, fence) = host.connection_and_fence();
        let fence = fence.clone();
        host_store::with_scoped_privileged_transaction(
            conn,
            &fence,
            &["compartments"],
            P,
            Some(&sessions),
            |tx| {
                tx.execute_batch(sql)?;
                Ok(())
            },
        )
    };
    let inside = attempt(
        "INSERT INTO compartments(session_id, sequence, start_message, end_message, title, content, created_at)
         VALUES ('ses-p1', 900, 1, 2, 't', 'c', 1)",
    );
    assert!(inside.is_ok(), "{inside:?}");
    for sql in [
        "INSERT INTO compartments(session_id, sequence, start_message, end_message, title, content, created_at)
         VALUES ('ses-q1', 900, 1, 2, 't', 'c', 1)",
        "INSERT INTO compartment_events(session_id, kind, created_at) VALUES ('ses-q1', 'k', 1)",
        "INSERT INTO user_memory_candidates(content, session_id, created_at) VALUES ('c', 'ses-q1', 1)",
        "UPDATE compartments SET session_id = 'ses-q1' WHERE session_id = 'ses-p1' AND sequence = 900",
        "INSERT INTO user_memories(content, promoted_at, created_at, updated_at) VALUES ('u', 1, 1, 1)",
    ] {
        let error = attempt(sql).unwrap_err();
        assert_eq!(error.code(), host_store::SCOPE_VIOLATION_CODE, "{sql}: {error}");
    }
    let conn = fixture.context_conn();
    let foreign: i64 = conn
        .query_row(
            "SELECT (SELECT COUNT(*) FROM compartments WHERE session_id = 'ses-q1')
                  + (SELECT COUNT(*) FROM compartment_events WHERE session_id = 'ses-q1')
                  + (SELECT COUNT(*) FROM user_memory_candidates WHERE session_id = 'ses-q1')
                  + (SELECT COUNT(*) FROM user_memories)",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(foreign, 0);
    let leftovers: i64 = conn
        .query_row("SELECT COUNT(*) FROM sqlite_temp_master", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(leftovers, 0);
}

fn assert_refused_without_writes(fixture: &Fixture, code: &str) {
    let before = project_state(
        &fixture.context_conn(),
        P,
        &["ses-p1", "ses-p2", LARGE_SESSION],
    );
    let store = fixture.open_store();
    let refusal = run(&store, &request(P), &fixture.options(), &mut NoObserver).unwrap_err();
    assert_eq!(refusal.code, code, "{refusal}");
    assert_eq!(
        project_state(
            &fixture.context_conn(),
            P,
            &["ses-p1", "ses-p2", LARGE_SESSION]
        ),
        before
    );
    assert!(!marker_present(&fixture.context(), P));
    assert_eq!(store.single_store_migration(P).unwrap(), None);
}

#[test]
fn a_project_without_a_host_is_refused_before_anything_is_written() {
    // No authority_managed row: no host has ever managed the project.
    let fixture = fresh();
    fixture
        .context_conn()
        .execute(
            "DELETE FROM authority_managed WHERE project_path = ?1",
            params![P],
        )
        .unwrap();
    assert_refused_without_writes(&fixture, HOST_LESS);

    // A session the store knows through its route root, missing from session_projects.
    let fixture = fresh();
    fixture
        .context_conn()
        .execute(
            "DELETE FROM session_projects WHERE session_id = 'ses-p1'",
            [],
        )
        .unwrap();
    assert_refused_without_writes(&fixture, HOST_LESS);

    // A session under a harness with no embedding host.
    let fixture = fresh();
    session_project(&fixture.context_conn(), "ses-p-pi", P, "pi");
    assert_refused_without_writes(&fixture, HOST_LESS);
}

#[test]
fn a_project_the_store_does_not_own_is_refused() {
    let fixture = fresh();
    fixture
        .store_conn()
        .execute(
            "UPDATE mc_authority SET state = 'TS' WHERE project = ?1 AND domain = 'notes'",
            params![P],
        )
        .unwrap();
    assert_refused_without_writes(&fixture, AUTHORITY_NOT_MODULE);
}

#[test]
fn the_move_is_refused_in_a_build_that_cannot_serve_a_moved_project() {
    let fixture = fresh();
    let store = fixture.open_store();
    let mut options = fixture.options();
    options.assume_cutover = false;
    let refusal = run(&store, &request(P), &options, &mut NoObserver).unwrap_err();
    assert_eq!(refusal.code, CUTOVER_ABSENT);
    assert!(!marker_present(&fixture.context(), P));
}

#[test]
fn the_marker_write_gate_refuses_a_low_fence_and_a_changed_table() {
    let fixture = fresh();
    let store = fixture.open_store();
    let mut options = fixture.options();
    options.built_fence = MARKER_LANE_VERSION - 1;
    let refusal = run(&store, &request(P), &options, &mut NoObserver).unwrap_err();
    assert_eq!(refusal.code, MARKER_WRITE_REFUSED);

    fixture
        .context_conn()
        .execute(
            "DELETE FROM schema_migrations WHERE version = ?1",
            params![MARKER_LANE_VERSION],
        )
        .unwrap();
    let refusal = run(&store, &request(P), &fixture.options(), &mut NoObserver).unwrap_err();
    assert_eq!(refusal.code, MARKER_WRITE_REFUSED);

    let fixture = fresh();
    let store = fixture.open_store();
    fixture
        .context_conn()
        .execute_batch("CREATE INDEX extra_identity_index ON mirror_identity(context_row_id);")
        .unwrap();
    let refusal = run(&store, &request(P), &fixture.options(), &mut NoObserver).unwrap_err();
    assert_eq!(refusal.code, FINGERPRINT_MISMATCH, "{refusal}");
    assert!(!marker_present(&fixture.context(), P));
}

#[test]
fn a_dry_run_reports_the_work_and_writes_nothing() {
    let fixture = fresh();
    let before = project_state(
        &fixture.context_conn(),
        P,
        &["ses-p1", "ses-p2", LARGE_SESSION],
    );
    let store = fixture.open_store();
    let mut dry = request(P);
    dry.dry_run = true;
    let report = run(&store, &dry, &fixture.options(), &mut NoObserver).unwrap();
    assert_eq!(report.status, "dry_run");
    assert_eq!(report.tables["compartments"].copied, 308);
    assert!(report.transaction_holds_us.is_empty());
    assert_eq!(
        project_state(
            &fixture.context_conn(),
            P,
            &["ses-p1", "ses-p2", LARGE_SESSION]
        ),
        before
    );
    assert_eq!(store.single_store_migration(P).unwrap(), None);
}

#[test]
fn a_session_note_seeded_without_an_identity_row_is_not_copied_twice() {
    let fixture = fresh();
    let seeded: i64 = fixture
        .context_conn()
        .query_row(
            "SELECT id FROM notes WHERE content = 'a session note'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let store = fixture.open_store();
    run(&store, &request(P), &fixture.options(), &mut NoObserver).unwrap();
    let rows: Vec<(i64, Option<String>)> = fixture
        .context_conn()
        .prepare("SELECT id, project_path FROM notes WHERE content = 'a session note'")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(rows, vec![(seeded, Some(P.to_string()))]);
    // The resolution is now durable, so a later mirror or copy finds the same row.
    let identity: i64 = fixture
        .context_conn()
        .query_row(
            "SELECT context_row_id FROM mirror_identity
              WHERE domain = 'notes' AND module_project = ?1
                AND module_row_id = (SELECT MAX(module_row_id) FROM mirror_identity
                                      WHERE domain = 'notes' AND context_row_id = ?2)",
            params![P, seeded],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(identity, seeded);
}

/// A session that ran in TypeScript mode before rust mode took over: context.db holds
/// TS-era events and candidates the store never had. Those tied to compartments the store
/// still has unchanged stay; those tied to a compartment the module rewrote go; one that
/// cannot be tied to any compartment stops the move.
#[test]
fn a_mixed_history_session_keeps_its_current_ts_rows_and_drops_only_superseded_ones() {
    let fixture = fresh();
    let context = fixture.context_conn();
    // The host already has ses-p2's compartments as the TS historian wrote them, except
    // compartment 3, which the module later rewrote. The host recorded the boundaries on
    // its own scale (message ids, ordinals one higher), so even the unchanged ones differ
    // from the store's rows in their coordinates.
    let mut ids = BTreeMap::new();
    for sequence in 1..=3i64 {
        let title = if sequence == 3 {
            "p2 c3 before the recomp".to_string()
        } else {
            format!("p2 c{sequence}")
        };
        context
            .execute(
                "INSERT INTO compartments(session_id, sequence, start_message, end_message,
                                          start_message_id, end_message_id, title, content, p1,
                                          importance, legacy, created_at, harness)
                 VALUES ('ses-p2', ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, 50, 0, ?8, 'opencode')",
                params![
                    sequence,
                    sequence * 10 + 1,
                    sequence * 10 + 10,
                    format!("host-msg-{}", sequence * 10),
                    format!("host-msg-{}", sequence * 10 + 9),
                    title,
                    format!("{title} body"),
                    3_000 + sequence
                ],
            )
            .unwrap();
        ids.insert(sequence, context.last_insert_rowid());
    }
    let ts_event = |compartment: i64, kind: &str| {
        context
            .execute(
                "INSERT INTO compartment_events(session_id, compartment_id, kind, at_compartment,
                                                fields_json, created_at)
                 VALUES ('ses-p2', ?1, ?2, NULL, '{}', 1)",
                params![compartment, kind],
            )
            .unwrap();
    };
    ts_event(ids[&1], "ts-era kept");
    ts_event(ids[&3], "ts-era superseded");
    // A TS-era candidate drawn from compartments 1-2 (unchanged) and one from 2-3 (3 was
    // rewritten).
    context
        .execute_batch(
            "INSERT INTO user_memory_candidates(content, session_id, source_compartment_start,
                                                source_compartment_end, created_at)
             VALUES ('ts-era kept candidate', 'ses-p2', 1, 2, 7),
                    ('ts-era superseded candidate', 'ses-p2', 2, 3, 7);",
        )
        .unwrap();
    // The store copy of ses-p2 also has an event, so the session's events are copied.
    store_event(&fixture.store_conn(), "ses-p2", 2, "module-era");

    let store = fixture.open_store();
    let report = run(&store, &request(P), &fixture.options(), &mut NoObserver).unwrap();
    let kinds: Vec<String> = fixture
        .context_conn()
        .prepare("SELECT kind FROM compartment_events WHERE session_id = 'ses-p2' ORDER BY kind")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(kinds, vec!["module-era", "ts-era kept"]);
    let candidates: Vec<String> = fixture
        .context_conn()
        .prepare("SELECT content FROM user_memory_candidates WHERE session_id = 'ses-p2' ORDER BY content")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(
        candidates,
        vec!["likes short answers", "ts-era kept candidate", "uses vim"]
    );
    assert_eq!(report.tables["compartment_events"].kept, 1);
    assert_eq!(report.tables["compartment_events"].deleted, 1);
    assert_eq!(report.tables["user_memory_candidates"].kept, 1);
    assert_eq!(report.tables["user_memory_candidates"].deleted, 1);
    // Compartment ids were kept: the kept event still points at compartment 1.
    let still: i64 = fixture
        .context_conn()
        .query_row(
            "SELECT COUNT(*) FROM compartment_events e JOIN compartments c ON c.id = e.compartment_id
              WHERE e.kind = 'ts-era kept' AND c.sequence = 1 AND c.id = ?1",
            params![ids[&1]],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(still, 1);
}

#[test]
fn a_history_row_that_cannot_be_classified_stops_the_move() {
    let fixture = fresh();
    fixture
        .context_conn()
        .execute(
            "INSERT INTO compartment_events(session_id, compartment_id, kind, fields_json, created_at)
             VALUES ('ses-p1', NULL, 'unanchored', '{}', 1)",
            [],
        )
        .unwrap();
    let before = project_state(
        &fixture.context_conn(),
        P,
        &["ses-p1", "ses-p2", LARGE_SESSION],
    );
    let store = fixture.open_store();
    let refusal = run(&store, &request(P), &fixture.options(), &mut NoObserver).unwrap_err();
    assert_eq!(refusal.code, UNCLASSIFIED_ROWS);
    assert!(refusal.detail.contains("ses-p1") && refusal.detail.contains("compartment_events"));
    assert_eq!(
        project_state(
            &fixture.context_conn(),
            P,
            &["ses-p1", "ses-p2", LARGE_SESSION]
        ),
        before
    );
    assert!(!marker_present(&fixture.context(), P));
}

/// An event pointing at a compartment id that exists in neither store (the host deleted
/// the compartment long ago) is an orphan: the move keeps it where it is, counts it, and
/// completes. An event pointing at a live compartment of another session could still be
/// misattributed, so that one keeps refusing.
#[test]
fn an_event_whose_compartment_exists_in_neither_store_is_kept_as_an_orphan() {
    let fixture = fresh();
    let context = fixture.context_conn();
    let dangling: i64 = context
        .query_row(
            "SELECT COALESCE(MAX(id), 0) + 1000 FROM compartments",
            [],
            |row| row.get(0),
        )
        .unwrap();
    context
        .execute(
            "INSERT INTO compartment_events(session_id, compartment_id, kind, fields_json, created_at)
             VALUES ('ses-p1', ?1, 'orphaned', '{\"a\":1}', 5)",
            params![dangling],
        )
        .unwrap();
    let orphan_id = context.last_insert_rowid();
    let orphan_row = |conn: &Connection| -> Option<(String, i64, String, String, i64)> {
        conn.query_row(
            "SELECT session_id, compartment_id, kind, fields_json, created_at
               FROM compartment_events WHERE id = ?1",
            params![orphan_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .optional()
        .unwrap()
    };
    let before = orphan_row(&context);
    assert!(before.is_some());

    let store = fixture.open_store();
    let report = run(&store, &request(P), &fixture.options(), &mut NoObserver).unwrap();
    assert_eq!(report.status, "migrated");
    assert_eq!(report.tables["compartment_events"].orphans_kept, 1);
    assert!(marker_present(&fixture.context(), P));
    assert_eq!(orphan_row(&fixture.context_conn()), before);
    // No compartment ever takes the dangling id, so the orphan stays unattached.
    let attached: i64 = fixture
        .context_conn()
        .query_row(
            "SELECT COUNT(*) FROM compartments WHERE id = ?1",
            params![dangling],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(attached, 0);

    let again = run(&store, &request(P), &fixture.options(), &mut NoObserver).unwrap();
    assert_eq!(again.status, "already_marked");
    assert_eq!(orphan_row(&fixture.context_conn()), before);
}

#[test]
fn an_event_pointing_at_another_sessions_live_compartment_still_stops_the_move() {
    let fixture = fresh();
    let context = fixture.context_conn();
    context
        .execute(
            "INSERT INTO compartments(session_id, sequence, start_message, end_message, title,
                                      content, importance, legacy, created_at, harness)
             VALUES ('ses-elsewhere', 1, 1, 2, 't', 'c', 50, 0, 1, 'opencode')",
            [],
        )
        .unwrap();
    let foreign = context.last_insert_rowid();
    context
        .execute(
            "INSERT INTO compartment_events(session_id, compartment_id, kind, fields_json, created_at)
             VALUES ('ses-p1', ?1, 'misfiled', '{}', 1)",
            params![foreign],
        )
        .unwrap();
    let store = fixture.open_store();
    let refusal = run(&store, &request(P), &fixture.options(), &mut NoObserver).unwrap_err();
    assert_eq!(refusal.code, UNCLASSIFIED_ROWS);
    assert!(!marker_present(&fixture.context(), P));
}

fn fresh() -> Fixture {
    fixture()
}

// ── Crash matrix: the executor process is killed and the move re-run ───────

const CRASH_DIR_ENV: &str = "MC_SINGLE_STORE_CRASH_DIR";
const CRASH_AT_ENV: &str = "MC_SINGLE_STORE_CRASH_AT";
const CHILD_TEST: &str = "single_store_migrate::tests::crash_matrix_child";

/// Context state the move converges to, without the columns that record when it ran.
fn converged_state(fixture: &Fixture) -> Vec<String> {
    let conn = fixture.context_conn();
    let mut state: Vec<String> = project_state(&conn, P, &["ses-p1", "ses-p2", LARGE_SESSION])
        .into_iter()
        .collect();
    // Drop the time-stamped tables from the generic dump and record their stable parts.
    let mut filtered = Vec::new();
    let mut skipping = false;
    for line in state.drain(..) {
        if line.starts_with("-- ") {
            skipping = line.starts_with("-- single_store_projects")
                || line.starts_with("-- memory_embedding_watermarks");
        }
        if !skipping {
            filtered.push(line);
        }
    }
    filtered.push(format!("marker {:?}", marker_rows(&conn)));
    let written: Option<i64> = conn
        .query_row(
            "SELECT written_memory_id FROM memory_embedding_watermarks WHERE project_path = ?1",
            params![P],
            |row| row.get(0),
        )
        .optional()
        .unwrap();
    filtered.push(format!("watermark {written:?}"));
    filtered
}

fn assert_domains_agree(fixture: &Fixture) {
    let states = authority_states(&fixture.store_conn(), P);
    assert_eq!(states.len(), 2);
    assert_eq!(
        states[0].1, states[1].1,
        "one domain must never be TS while the other is MODULE: {states:?}"
    );
}

/// Spawn this test binary as the executor, let it reach `point`, and kill it there.
fn kill_executor_at(fixture: &Fixture, point: &str) {
    let ready = fixture.dir.path().join("ready");
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            CHILD_TEST,
            "--exact",
            "--ignored",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(CRASH_DIR_ENV, fixture.dir.path())
        .env(CRASH_AT_ENV, point)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(120);
    while !ready.exists() {
        if let Some(status) = child.try_wait().unwrap() {
            panic!("the executor exited ({status}) before reaching {point}");
        }
        assert!(
            Instant::now() < deadline,
            "the executor never reached {point}"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    // SIGKILL: no destructor, no rollback handler, no chance to finish the transaction.
    child.kill().unwrap();
    child.wait().unwrap();
    std::fs::remove_file(ready).unwrap();
}

/// The executor half of the crash matrix. Does nothing unless the parent test spawned it.
#[test]
#[ignore = "spawned by the crash matrix as the process it kills"]
fn crash_matrix_child() {
    let Ok(dir) = std::env::var(CRASH_DIR_ENV) else {
        return;
    };
    let point = std::env::var(CRASH_AT_ENV).unwrap();
    let dir = PathBuf::from(dir);
    let fixture_dir = dir.clone();
    let park = |dir: &Path| -> ! {
        std::fs::write(dir.join("ready"), b"ready").unwrap();
        loop {
            std::thread::sleep(Duration::from_secs(1));
        }
    };
    let store =
        McStore::open_with_capability_for_test(&crate::test_support::descriptor(&dir), true)
            .unwrap();
    let mut options = MigrateOptions::new(dir.join("context.db"));
    options.assume_cutover = true;
    let mut hooks = Hooks::default();
    match point.as_str() {
        "before_first_chunk" => hooks.before_first_chunk = Some(Box::new(|| park(&fixture_dir))),
        "mid_chunk" => {
            hooks.between = Some(Box::new(|context: &Path, committed| {
                if committed == 1 {
                    let conn = Connection::open(context).unwrap();
                    let state =
                        project_state(&conn, P, &["ses-p1", "ses-p2", LARGE_SESSION]).join("\n");
                    std::fs::write(fixture_dir.join("committed"), state).unwrap();
                }
            }));
            hooks.inside = Some(Box::new(|_tx: &Transaction<'_>, index, is_final| {
                if index == 1 && !is_final {
                    park(&fixture_dir);
                }
            }));
        }
        "before_final" => hooks.before_final = Some(Box::new(|| park(&fixture_dir))),
        "after_context_commit" => {
            hooks.after_context_commit = Some(Box::new(|| park(&fixture_dir)))
        }
        other => panic!("unknown crash point {other}"),
    }
    let _ = run(&store, &request(P), &options, &mut hooks);
    panic!("the executor finished without reaching {point}");
}

fn reference_state() -> Vec<String> {
    let fixture = fixture();
    let store = fixture.open_store();
    run(&store, &request(P), &fixture.options(), &mut NoObserver).unwrap();
    converged_state(&fixture)
}

fn rerun_converges(fixture: &Fixture, reference: &[String]) {
    let store = fixture.open_store();
    let report = run(&store, &request(P), &fixture.options(), &mut NoObserver).unwrap();
    assert_eq!(report.status, "migrated");
    drop(store);
    assert_eq!(converged_state(fixture), reference);
    assert_eq!(
        authority_states(&fixture.store_conn(), P),
        vec![
            ("memories".into(), "TS".into()),
            ("notes".into(), "TS".into())
        ]
    );
}

#[test]
fn a_killed_executor_converges_on_re_run_from_every_crash_point() {
    let reference = reference_state();
    let module_owned = vec![
        ("memories".to_string(), "MODULE".to_string()),
        ("notes".to_string(), "MODULE".to_string()),
    ];

    // (a) Killed before its first chunk: context.db holds nothing the executor wrote.
    let fixture = fresh();
    let initial = project_state(
        &fixture.context_conn(),
        P,
        &["ses-p1", "ses-p2", LARGE_SESSION],
    );
    kill_executor_at(&fixture, "before_first_chunk");
    assert_eq!(
        project_state(
            &fixture.context_conn(),
            P,
            &["ses-p1", "ses-p2", LARGE_SESSION]
        ),
        initial
    );
    assert_eq!(authority_states(&fixture.store_conn(), P), module_owned);
    rerun_converges(&fixture, &reference);

    // (b) Killed inside a chunk's transaction: that chunk is absent, the earlier one stays.
    let fixture = fresh();
    let initial = project_state(
        &fixture.context_conn(),
        P,
        &["ses-p1", "ses-p2", LARGE_SESSION],
    );
    kill_executor_at(&fixture, "mid_chunk");
    let committed = std::fs::read_to_string(fixture.dir.path().join("committed")).unwrap();
    let after_kill = project_state(
        &fixture.context_conn(),
        P,
        &["ses-p1", "ses-p2", LARGE_SESSION],
    );
    assert_eq!(after_kill.join("\n"), committed);
    assert_ne!(
        after_kill, initial,
        "the first chunk committed before the kill"
    );
    assert!(!marker_present(&fixture.context(), P));
    assert_domains_agree(&fixture);
    rerun_converges(&fixture, &reference);

    // (c) Killed after every chunk but the final one: no marker, the store still owns both
    // domains, the marker read answers as before for both projects, and Q is untouched.
    let fixture = fresh();
    let q_before = project_state(&fixture.context_conn(), Q, &["ses-q1"]);
    kill_executor_at(&fixture, "before_final");
    let markers = host_store::read_marker_snapshot(&fixture.context()).unwrap();
    assert!(!markers.is_marked(P) && !markers.is_marked(Q));
    assert_eq!(authority_states(&fixture.store_conn(), P), module_owned);
    assert_eq!(
        project_state(&fixture.context_conn(), Q, &["ses-q1"]),
        q_before
    );
    rerun_converges(&fixture, &reference);

    // (d) Killed after the final context.db commit, before store.db was told: the marker is
    // there and both domains still read MODULE; the next start finishes the store half
    // without copying anything again.
    let fixture = fresh();
    kill_executor_at(&fixture, "after_context_commit");
    assert!(marker_present(&fixture.context(), P));
    assert_eq!(authority_states(&fixture.store_conn(), P), module_owned);
    let copied = converged_state(&fixture);
    assert_eq!(copied, reference);
    let store = fixture.open_store();
    let completed =
        complete_pending_neutralisations(&store, &fixture.context(), &build_version()).unwrap();
    assert_eq!(completed, vec![P.to_string()]);
    assert_eq!(
        complete_pending_neutralisations(&store, &fixture.context(), &build_version()).unwrap(),
        Vec::<String>::new(),
        "a second start has nothing left to do"
    );
    assert_eq!(
        store.single_store_migration(P).unwrap().unwrap().phase,
        "neutralized"
    );
    drop(store);
    assert_eq!(converged_state(&fixture), reference);
    assert_eq!(
        authority_states(&fixture.store_conn(), P),
        vec![
            ("memories".into(), "TS".into()),
            ("notes".into(), "TS".into())
        ]
    );

    // (e) After a completed move a re-run answers already_marked and writes nothing.
    let context_before = dump(&fixture.context_conn(), "single_store_projects", "1", &[]);
    let authority_before = dump(
        &fixture.store_conn(),
        "mc_authority",
        "project = ?1",
        &[text(P)],
    );
    let phase_before = dump(
        &fixture.store_conn(),
        "mc_single_store_migrations",
        "project = ?1",
        &[text(P)],
    );
    let store = fixture.open_store();
    let report = run(&store, &request(P), &fixture.options(), &mut NoObserver).unwrap();
    assert_eq!(report.status, "already_marked");
    assert!(!report.neutralized);
    drop(store);
    assert_eq!(converged_state(&fixture), reference);
    assert_eq!(
        dump(&fixture.context_conn(), "single_store_projects", "1", &[]),
        context_before
    );
    assert_eq!(
        dump(
            &fixture.store_conn(),
            "mc_authority",
            "project = ?1",
            &[text(P)]
        ),
        authority_before
    );
    assert_eq!(
        dump(
            &fixture.store_conn(),
            "mc_single_store_migrations",
            "project = ?1",
            &[text(P)]
        ),
        phase_before
    );
}

// ── Seats and the busy timeout ─────────────────────────────────────────────

/// The busy-refusal counter is process-wide; the two tests that read it take turns.
static BUSY_COUNTER: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// An OpenCode-seat-style writer on the sibling project runs for the whole move. It
/// never loses its busy timeout, and the move loses none either.
#[test]
fn a_seat_writing_the_sibling_throughout_the_move_is_never_refused() {
    let _counter = BUSY_COUNTER
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let fixture = fixture();
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let context = fixture.context();
    let seat_stop = std::sync::Arc::clone(&stop);
    let seat = std::thread::spawn(move || {
        let conn = Connection::open(&context).unwrap();
        conn.busy_timeout(Duration::from_millis(u64::from(
            host_store::CONTEXT_BUSY_TIMEOUT_MS,
        )))
        .unwrap();
        let (mut writes, mut busy) = (0u64, 0u64);
        let mut sequence = 100;
        while !seat_stop.load(std::sync::atomic::Ordering::Relaxed) {
            sequence += 1;
            let result = conn.execute(
                "INSERT INTO compartments(session_id, sequence, start_message, end_message, title,
                                          content, created_at)
                 VALUES ('ses-q1', ?1, 1, 2, 'seat', 'seat', 1)",
                params![sequence],
            );
            match result {
                Ok(_) => writes += 1,
                Err(error)
                    if error.sqlite_error_code() == Some(rusqlite::ErrorCode::DatabaseBusy) =>
                {
                    busy += 1
                }
                Err(error) => panic!("seat write failed: {error}"),
            }
            // A seat writes when its session does something, not in a tight loop; a
            // writer that never pauses would starve every other writer of the lock.
            std::thread::sleep(Duration::from_millis(2));
        }
        (writes, busy)
    });
    let busy_before = host_store::busy_refusal_count();
    let store = fixture.open_store();
    let report = run(&store, &request(P), &fixture.options(), &mut NoObserver).unwrap();
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    let (writes, busy) = seat.join().unwrap();
    assert_eq!(report.status, "migrated");
    assert!(writes > 0);
    assert_eq!(busy, 0, "the seat hit SQLITE_BUSY");
    assert_eq!(host_store::busy_refusal_count(), busy_before);
}

/// A writer that keeps context.db locked past the busy timeout makes the next chunk give
/// up with the retryable busy code; the chunks already committed stay and no marker is
/// written.
#[test]
fn a_chunk_that_cannot_get_the_lock_in_time_stops_the_run_and_keeps_earlier_chunks() {
    let _counter = BUSY_COUNTER
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let fixture = fixture();
    let store = fixture.open_store();
    let holder: std::cell::RefCell<Option<std::thread::JoinHandle<()>>> = Default::default();
    let committed_state = std::cell::RefCell::new(Vec::new());
    let mut hooks = Hooks {
        between: Some(Box::new(|context: &Path, committed| {
            if committed != 1 {
                return;
            }
            *committed_state.borrow_mut() = project_state(
                &Connection::open(context).unwrap(),
                P,
                &["ses-p1", "ses-p2", LARGE_SESSION],
            );
            let (locked_tx, locked_rx) = std::sync::mpsc::channel();
            let context = context.to_path_buf();
            *holder.borrow_mut() = Some(std::thread::spawn(move || {
                let conn = Connection::open(&context).unwrap();
                conn.execute_batch("BEGIN IMMEDIATE").unwrap();
                locked_tx.send(()).unwrap();
                std::thread::sleep(Duration::from_millis(
                    u64::from(host_store::CONTEXT_BUSY_TIMEOUT_MS) + 1_500,
                ));
                conn.execute_batch("COMMIT").unwrap();
            }));
            locked_rx.recv().unwrap();
        })),
        ..Hooks::default()
    };
    let busy_before = host_store::busy_refusal_count();
    let refusal = run(&store, &request(P), &fixture.options(), &mut hooks).unwrap_err();
    drop(hooks);
    holder.into_inner().unwrap().join().unwrap();
    assert_eq!(refusal.code, "single_store_busy", "{refusal}");
    assert!(refusal.retryable);
    assert!(host_store::busy_refusal_count() > busy_before);
    assert!(!marker_present(&fixture.context(), P));
    assert_eq!(
        project_state(
            &fixture.context_conn(),
            P,
            &["ses-p1", "ses-p2", LARGE_SESSION]
        ),
        committed_state.into_inner()
    );
    // A busy refusal is not a data problem, so a plain re-run continues.
    assert_eq!(
        store.single_store_migration(P).unwrap().unwrap().phase,
        "copying"
    );
    let report = run(&store, &request(P), &fixture.options(), &mut NoObserver).unwrap();
    assert_eq!(report.status, "migrated");
}

// ── Real-store drill ───────────────────────────────────────────────────────

/// Run the move against a copied real store pair. Ignored by default; it needs a
/// directory holding writable copies of a `store.db` and a `context.db` at lane 93, and it
/// refuses any directory outside the temp root:
///
/// ```text
/// MC_SINGLE_STORE_DRILL_DIR=$TMPDIR/magic-context/b2/drill \
///   cargo test --locked -p mc-module --lib single_store_migrate::tests::real_store_drill \
///   -- --ignored --nocapture
/// ```
///
/// For every project with an `authority_managed` row it runs a dry run, then the move,
/// then the move again, printing one JSON line per step.
#[test]
#[ignore = "drill on copied real stores; needs MC_SINGLE_STORE_DRILL_DIR"]
fn real_store_drill() {
    let Ok(dir) = std::env::var("MC_SINGLE_STORE_DRILL_DIR") else {
        return;
    };
    let dir = PathBuf::from(dir).canonicalize().unwrap();
    let temp_root = std::env::temp_dir().canonicalize().unwrap();
    assert!(
        dir.starts_with(&temp_root),
        "the drill runs only on copies under {}",
        temp_root.display()
    );
    let context = dir.join("context.db");
    // Every table the marker-write gate checks carries the fingerprint this build expects
    // on the real, long-upgraded file.
    {
        let mut host = HostStore::open(&context).unwrap();
        let (conn, fence) = host.connection_and_fence();
        for table in [BRACKET_TABLE, MARKER_TABLE]
            .iter()
            .chain(COPY_DOMAIN_TABLES.iter())
        {
            fence
                .check_table(table)
                .unwrap_or_else(|error| panic!("{table}: {error}"));
            println!("DRILL-GATE {table} ok");
        }
        check_auxiliary_fingerprints(conn).unwrap();
        println!("DRILL-GATE authority_managed ok");
        println!("DRILL-GATE mirror_identity ok");
        check_marker_gate(conn, fence).unwrap();
    }
    let store =
        McStore::open_with_capability_for_test(&crate::test_support::descriptor(&dir), true)
            .unwrap();
    store.set_project_write_gate(std::sync::Arc::new(CopyWriteGate::for_store(&store)));
    let projects: Vec<String> = Connection::open(&context)
        .unwrap()
        .prepare("SELECT project_path FROM authority_managed ORDER BY project_path")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    let mut options = MigrateOptions::new(context.clone());
    options.assume_cutover = true;
    let step = |project: &str, name: &str, request: MigrateRequest| {
        let started = Instant::now();
        let outcome = run(&store, &request, &options, &mut NoObserver);
        let line = match outcome {
            Ok(report) => json!({
                "project": project, "step": name, "ok": true,
                "wall_ms": started.elapsed().as_millis() as u64,
                "report": report.to_value(),
            }),
            Err(refusal) => json!({
                "project": project, "step": name, "ok": false,
                "wall_ms": started.elapsed().as_millis() as u64,
                "code": refusal.code, "detail": refusal.detail,
            }),
        };
        println!("DRILL {line}");
        line
    };
    for project in &projects {
        let dry = step(
            project,
            "dry_run",
            MigrateRequest {
                project: project.clone(),
                dry_run: true,
                retry: false,
            },
        );
        if dry["ok"] != json!(true) {
            continue;
        }
        let first = step(project, "run", request(project));
        if first["ok"] != json!(true) {
            continue;
        }
        step(project, "rerun", request(project));
    }
}

#[test]
fn auxiliary_fingerprints_match_the_committed_schema_snapshot() {
    let fixture = fixture();
    let conn = fixture.context_conn();
    let mut drift = Vec::new();
    for (table, expected) in COPY_AUXILIARY_FINGERPRINTS {
        let found = host_store::read_table_fingerprint(&conn, table)
            .unwrap()
            .unwrap();
        if found != *expected {
            drift.push(format!("    (\"{table}\", \"{found}\"),"));
        }
    }
    assert!(
        drift.is_empty(),
        "COPY_AUXILIARY_FINGERPRINTS is stale. Replace the drifted entries with:\n{}",
        drift.join("\n")
    );
}

/// The store can hold two notes that read the same (one seeded twice). Each gets its own
/// context row; a context row already mapped to one of them is not claimed by the other.
#[test]
fn two_identical_store_notes_each_keep_their_own_context_row() {
    let fixture = fixture();
    let store_conn = fixture.store_conn();
    let first = store_note(
        &store_conn,
        P,
        "smart",
        Some("ses-p1"),
        "twice",
        "active",
        None,
    );
    let second = store_note(
        &store_conn,
        P,
        "smart",
        Some("ses-p1"),
        "twice",
        "active",
        None,
    );
    let context = fixture.context_conn();
    privileged(&context, |conn| {
        conn.execute(
            "INSERT INTO notes(type, status, content, session_id, project_path, created_at, updated_at)
             VALUES ('smart', 'active', 'twice', 'ses-p1', ?1, 2000, 2001)",
            params![P],
        )
        .unwrap();
        let id = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO mirror_identity(domain, module_project, module_row_id, context_row_id)
             VALUES ('notes', ?1, ?2, ?3)",
            params![P, second, id],
        )
        .unwrap();
    });
    let store = fixture.open_store();
    let report = run(&store, &request(P), &fixture.options(), &mut NoObserver).unwrap();
    assert_eq!(report.status, "migrated");
    let mapped: Vec<i64> = fixture
        .context_conn()
        .prepare(
            "SELECT i.module_row_id FROM notes n JOIN mirror_identity i
                ON i.domain = 'notes' AND i.context_row_id = n.id
              WHERE n.content = 'twice' ORDER BY i.module_row_id",
        )
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(mapped, vec![first, second]);
}
