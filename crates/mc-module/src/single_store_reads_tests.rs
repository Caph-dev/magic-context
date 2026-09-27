//! A moved project's domain reads come from context.db; everyone else's from store.db.
//!
//! Fixtures are the move's own (`single_store_migrate::tests`): P is moved with the real
//! executor, Q stays an unmarked sibling on the same two files.

use super::*;
use crate::single_store_migrate::tests::{
    fixture, marker_present, privileged, request, Fixture, P, Q,
};
use crate::single_store_migrate::{run, NoObserver};
use mc_store::McStore;
use std::sync::Arc;

pub(crate) fn moved_fixture() -> Fixture {
    let fixture = fixture();
    let store = fixture.open_store();
    run(&store, &request(P), &fixture.options(), &mut NoObserver).expect("move P");
    assert!(marker_present(&fixture.context(), P));
    fixture
}

/// The fixture's store, reading moved projects from its context.db.
pub(crate) fn serving_store(fixture: &Fixture) -> McStore {
    let store = fixture.open_store();
    store.set_single_store_domain(Arc::new(ContextDomainReader::new(fixture.context())));
    store
}

fn context_exec(fixture: &Fixture, sql: &str) {
    privileged(&fixture.context_conn(), |conn| {
        conn.execute_batch(sql).unwrap();
    });
}

fn store_exec(fixture: &Fixture, sql: &str) {
    fixture.store_conn().execute_batch(sql).unwrap();
}

/// Right after the move the two files say the same thing, so a context.db answer and a
/// store.db answer for the same session must be equal: the conversion back into the
/// store's shape (compartment sequence for an event, not the context row id) is exact.
#[test]
fn a_moved_sessions_history_rows_read_the_same_right_after_the_move() {
    let fixture = moved_fixture();
    // One store may be open per process at a time, so each side is read in turn.
    let read = |store: &McStore| {
        let mut out = Vec::new();
        for session in ["ses-p1", "ses-p2"] {
            // The move stamps the session's harness on each event (store.db wrote the
            // literal 'module'), so the harness is compared separately below.
            let events: Vec<_> = store
                .load_compartment_events(session)
                .unwrap()
                .into_iter()
                .map(|event| mc_store::HistorianEventCandidate {
                    harness: String::new(),
                    ..event
                })
                .collect();
            out.push(format!("{events:?}"));
            out.push(format!(
                "{:?}",
                store.load_primer_candidates(session).unwrap()
            ));
            out.push(format!(
                "{:?}",
                store.load_user_memory_candidates(session).unwrap()
            ));
        }
        // Ids differ between the files (the move inserts a superseding memory before the
        // one it supersedes), and ties in importance are broken by id, so the set is
        // compared here and the order is each file's own.
        let mut memories: Vec<_> = store
            .load_active_memories(P, 0)
            .unwrap()
            .into_iter()
            .map(|m| (m.category, m.content, m.importance, m.status, m.expires_at))
            .collect();
        memories.sort();
        out.push(format!("{memories:?}"));
        out
    };
    let plain = read(&fixture.open_store());
    let serving = read(&serving_store(&fixture));
    assert_eq!(serving, plain);
    assert!(plain[0].contains("decision"));
    let store = serving_store(&fixture);
    assert!(store
        .load_compartment_events("ses-p1")
        .unwrap()
        .iter()
        .all(|event| event.harness == "opencode"));
}

/// After the move, a P row given different values in context.db than in store.db is read
/// with the context.db values, per table; Q, unmarked, keeps reading store.db.
#[test]
fn a_moved_project_reads_its_history_inputs_from_context_db_and_the_sibling_from_store_db() {
    let fixture = moved_fixture();
    context_exec(
        &fixture,
        "UPDATE compartment_events SET fields_json = '{\"from\":\"context\"}' WHERE session_id = 'ses-p1';
         UPDATE primer_candidates SET question = 'context question' WHERE session_id = 'ses-p1';
         UPDATE user_memory_candidates SET content = 'context candidate' WHERE session_id = 'ses-p2';
         UPDATE memories SET content = 'context wording ' || id WHERE project_path = 'git:project-p';
         UPDATE memories SET content = 'q context wording' WHERE project_path = 'git:project-q';",
    );
    store_exec(
        &fixture,
        "UPDATE mc_memories SET content = 'q store wording' WHERE project_path = 'git:project-q';",
    );
    let store = serving_store(&fixture);

    let events = store.load_compartment_events("ses-p1").unwrap();
    assert!(!events.is_empty());
    assert!(events
        .iter()
        .all(|event| event.fields_json == "{\"from\":\"context\"}"));
    // The event still names its compartment by sequence, as store.db does.
    let sequences: Vec<Option<u64>> = events.iter().map(|event| event.compartment_id).collect();
    assert_eq!(sequences, vec![Some(1), Some(2), Some(3), Some(4)]);

    let primers = store.load_primer_candidates("ses-p1").unwrap();
    assert_eq!(primers.len(), 3);
    assert!(primers
        .iter()
        .all(|primer| primer.question == "context question"));

    let candidates = store.load_user_memory_candidates("ses-p2").unwrap();
    assert_eq!(candidates.len(), 2);
    assert!(candidates
        .iter()
        .all(|candidate| candidate.content == "context candidate"));

    let memories = store.load_active_memories(P, 0).unwrap();
    assert!(!memories.is_empty());
    for memory in &memories {
        assert_eq!(memory.content, format!("context wording {}", memory.id));
        assert_eq!(memory.host_row_id, Some(memory.id));
    }

    let sibling = store.load_active_memories(Q, 0).unwrap();
    assert_eq!(sibling.len(), 3);
    assert!(sibling
        .iter()
        .all(|memory| memory.content == "q store wording"));
}

/// A session store.db binds to P through its transform root, with no session_projects row
/// in context.db, still belongs to P.
#[test]
fn a_session_known_only_through_the_stores_route_binding_is_read_from_context_db() {
    let fixture = moved_fixture();
    store_exec(
        &fixture,
        "INSERT INTO mc_transform_session_roots(session_id, project_root, observed_at)
         VALUES ('ses-p-late', '/work/project-p', 9999999999999);
         INSERT INTO mc_user_memory_candidates(content, session_id, created_at)
         VALUES ('retained store row', 'ses-p-late', 1);",
    );
    context_exec(
        &fixture,
        "INSERT INTO user_memory_candidates(content, session_id, created_at)
         VALUES ('current context row', 'ses-p-late', 2);",
    );
    let store = serving_store(&fixture);
    let rows = store.load_user_memory_candidates("ses-p-late").unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].content, "current context row");
}

/// Before the marker is committed nothing changes, even with the reader installed.
#[test]
fn an_unmarked_project_reads_store_db_even_with_the_reader_installed() {
    let fixture = fixture();
    context_exec(
        &fixture,
        "INSERT INTO user_memory_candidates(content, session_id, created_at)
         VALUES ('context only', 'ses-p2', 2);",
    );
    let read = |store: &McStore| {
        (
            store.load_user_memory_candidates("ses-p2").unwrap(),
            store.load_active_memories(P, 0).unwrap(),
        )
    };
    let plain = read(&fixture.open_store());
    let serving = read(&serving_store(&fixture));
    assert_eq!(serving, plain);
    assert!(plain.0.iter().all(|row| row.content != "context only"));
}

/// A marker table this build cannot trust refuses the read instead of falling back to
/// store.db, whose copy of a possibly-moved project is not current.
#[test]
fn an_untrusted_marker_table_refuses_the_read() {
    let fixture = moved_fixture();
    fixture
        .context_conn()
        .execute_batch("ALTER TABLE single_store_projects ADD COLUMN extra TEXT;")
        .unwrap();
    let store = serving_store(&fixture);
    let error = store.load_user_memory_candidates("ses-p2").unwrap_err();
    assert!(
        matches!(&error, mc_store::McStoreError::SingleStoreDomain { code, .. } if code == crate::host_store::SINGLE_STORE_TRIPWIRE_CODE),
        "{error}"
    );
}
