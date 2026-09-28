//! Compartment writes that change both files: the cache state in `store.db` and the
//! session's history rows in `context.db`.
//!
//! The two files never commit together. Each such write therefore runs in three steps:
//!
//! 1. one `store.db` transaction does the checks (row version, historian phase, revert
//!    epoch), the cache changes, and records the `context.db` half as a pending row in
//!    `mc_single_store_pending_publish`;
//! 2. one `context.db` transaction applies that half;
//! 3. the pending row is deleted.
//!
//! A process that stops between steps leaves the pending row behind. The next write for
//! the session, the next transform pass for it, and the module's start all re-run step 2
//! from the row and then step 3, and no new write for the session starts while it exists.
//! Every `context.db` half is written so a second application finds nothing left to do:
//! compartments are compared with what is already stored, updated in place (keeping their
//! ids, so chunk embeddings survive) or inserted, and only rows that really changed count.
//!
//! Any rewrite of a compartment the session already had appends an `m0_mutation_log` row
//! in the same `context.db` transaction. That row is how every reader of the session
//! (TypeScript mode and this module alike) notices an in-place rewrite that the highest
//! compartment sequence alone would not reveal.

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::{
    append_compartments_tx, current_time_ms, insert_compartment_tx, insert_historian_events_tx,
    insert_historian_primer_tx, promote_facts_tx, session_harness_tx, FactCandidate,
    HistorianEventCandidate, HistorianPrimerCandidate, HistorianUserMemoryCandidate, McStore,
    McStoreError, PromotedRef, StoredCompartment,
};

/// The `context.db` tables a pending write may touch, for the module's per-table fence.
pub(crate) const HISTORY_TABLES: &[&str] = &[
    "compartment_events",
    "compartments",
    "memories",
    "memory_embedding_watermarks",
    "notes",
    "primer_candidates",
    "user_memory_candidates",
];

/// The `context.db` half of a write, as recorded in `store.db` before it is applied.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum PendingContextWrite {
    /// A historian fold: new compartments at the session's tail and the rows derived
    /// from them.
    Fold(FoldWrite),
    /// The session's whole compartment set, replaced.
    ReplaceCompartments {
        compartments: Vec<StoredCompartment>,
        now_ms: i64,
    },
    /// Every compartment and history row of the session removed (native recomp reset).
    ClearSession { now_ms: i64 },
    /// Every compartment after `keep_through_seq` removed (revert re-cut).
    TruncateAfter { keep_through_seq: i64, now_ms: i64 },
    /// A fake-compaction lineage descent: the target key adopts the source key's
    /// compartments and session notes, plus a boundary placeholder.
    LineageCopy {
        source_key: String,
        placeholder: StoredCompartment,
    },
}

/// The `context.db` rows one historian fold writes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct FoldWrite {
    pub project_path: String,
    /// The harness label for the fold's rows; `None` falls back to the session's own.
    #[serde(default)]
    pub harness: Option<String>,
    /// The fold's compartments with their durable sequences already assigned.
    pub compartments: Vec<StoredCompartment>,
    pub facts: Vec<FactCandidate>,
    pub promote_facts: bool,
    pub published_at_ms: i64,
    pub events: Vec<HistorianEventCandidate>,
    pub primer_candidates: Vec<HistorianPrimerCandidate>,
    pub user_memory_candidates: Vec<HistorianUserMemoryCandidate>,
}

/// Why a stored compartment and a desired one are the same row: every column the renderer,
/// the historian or a host reads, except the id and the harness label.
fn same_compartment(stored: &StoredCompartment, desired: &StoredCompartment) -> bool {
    stored.sequence == desired.sequence
        && stored.start_message == desired.start_message
        && stored.end_message == desired.end_message
        && stored.start_message_id == desired.start_message_id
        && stored.end_message_id == desired.end_message_id
        && stored.title == desired.title
        && stored.content == desired.content
        && stored.p1 == desired.p1
        && stored.p2 == desired.p2
        && stored.p3 == desired.p3
        && stored.p4 == desired.p4
        && stored.importance == desired.importance
        && stored.episode_type == desired.episode_type
        && stored.legacy == desired.legacy
        && stored.created_at == desired.created_at
}

fn read_session_compartments(
    tx: &rusqlite::Connection,
    session_id: &str,
) -> rusqlite::Result<Vec<(i64, StoredCompartment)>> {
    let mut statement = tx.prepare(&format!(
        "SELECT id, {} FROM compartments WHERE session_id = ?1 ORDER BY sequence ASC",
        crate::COMPARTMENT_SELECT_COLUMNS
    ))?;
    let rows = statement
        .query_map(params![session_id], |row| {
            let id: i64 = row.get(0)?;
            Ok((
                id,
                StoredCompartment {
                    sequence: row.get(1)?,
                    start_message: row.get(2)?,
                    end_message: row.get(3)?,
                    start_message_id: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                    end_message_id: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                    start_date: None,
                    end_date: None,
                    title: row.get(8)?,
                    content: row.get(9)?,
                    p1: row.get(10)?,
                    p2: row.get(11)?,
                    p3: row.get(12)?,
                    p4: row.get(13)?,
                    importance: row.get::<_, Option<i64>>(14)?.unwrap_or(50) as i32,
                    episode_type: row.get(15)?,
                    legacy: row.get::<_, Option<i64>>(16)?.unwrap_or(0) as i32,
                    created_at: row.get(17)?,
                },
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// What [`upsert_compartments_tx`] changed.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct UpsertOutcome {
    inserted: usize,
    updated: usize,
}

/// Write `desired` at their own sequences: a row already equal is left alone, a different
/// row at the same sequence is updated in place (its id, and so its chunk embeddings,
/// survive), a missing sequence is inserted.
fn upsert_compartments_tx(
    tx: &rusqlite::Connection,
    session_id: &str,
    desired: &[StoredCompartment],
    harness: &str,
) -> rusqlite::Result<UpsertOutcome> {
    let stored = read_session_compartments(tx, session_id)?;
    let mut outcome = UpsertOutcome::default();
    for compartment in desired {
        match stored
            .iter()
            .find(|(_, row)| row.sequence == compartment.sequence)
        {
            Some((_, row)) if same_compartment(row, compartment) => {}
            Some((id, _)) => {
                tx.execute(
                    "UPDATE compartments
                        SET start_message = ?2, end_message = ?3, start_message_id = ?4,
                            end_message_id = ?5, title = ?6, content = ?7, p1 = ?8, p2 = ?9,
                            p3 = ?10, p4 = ?11, importance = ?12, episode_type = ?13,
                            legacy = ?14, created_at = ?15, p1_embedding = NULL,
                            p1_embedding_model_id = NULL
                      WHERE id = ?1",
                    params![
                        id,
                        compartment.start_message,
                        compartment.end_message,
                        compartment.start_message_id,
                        compartment.end_message_id,
                        compartment.title,
                        compartment.content,
                        compartment.p1,
                        compartment.p2,
                        compartment.p3,
                        compartment.p4,
                        compartment.importance as i64,
                        compartment.episode_type,
                        compartment.legacy as i64,
                        compartment.created_at,
                    ],
                )?;
                outcome.updated += 1;
            }
            None => {
                insert_compartment_tx(
                    tx,
                    session_id,
                    compartment.sequence,
                    compartment,
                    harness,
                )?;
                outcome.inserted += 1;
            }
        }
    }
    Ok(outcome)
}

/// Delete the session's compartments matching `predicate` (a SQL condition over the
/// `compartments` row) together with the events that point at them. Returns how many
/// compartments went.
fn delete_compartments_where_tx(
    tx: &rusqlite::Connection,
    session_id: &str,
    predicate: &str,
    value: i64,
) -> rusqlite::Result<usize> {
    tx.execute(
        &format!(
            "DELETE FROM compartment_events
              WHERE session_id = ?1
                AND compartment_id IN (
                    SELECT id FROM compartments WHERE session_id = ?1 AND {predicate}
                )"
        ),
        params![session_id, value],
    )?;
    tx.execute(
        &format!("DELETE FROM compartments WHERE session_id = ?1 AND {predicate}"),
        params![session_id, value],
    )
}

/// The `target_id` the module stamps on the `m0_mutation_log` rows it writes itself.
///
/// No reader uses `target_id` as a row reference (the host compares only `MAX(id)`), so
/// the value is free to say who wrote the row. The module skips its own rows when it reads
/// the head: it already knows about its own rewrites and handles them through its own
/// boundary machinery, and treating them as another writer's change would force a HARD
/// on the next pass that the module's cache protection is there to avoid.
pub const MODULE_M0_MUTATION_TARGET: i64 = -1;

/// Record that the session's existing compartments were rewritten, so readers that key
/// their cache on the highest sequence also notice an in-place change.
pub(crate) fn append_m0_mutation_tx(
    tx: &rusqlite::Connection,
    session_id: &str,
    mutation_type: &str,
    now_ms: i64,
) -> rusqlite::Result<()> {
    tx.execute(
        "INSERT INTO m0_mutation_log (session_id, mutation_type, target_id, queued_at)
         VALUES (?1, ?2, ?3, ?4)",
        params![session_id, mutation_type, MODULE_M0_MUTATION_TARGET, now_ms],
    )?;
    Ok(())
}

/// Candidates whose source range starts past the session's last remaining compartment
/// were derived from compartments that no longer exist.
fn delete_candidates_past_tail_tx(tx: &rusqlite::Connection, session_id: &str) -> rusqlite::Result<()> {
    for table in ["primer_candidates", "user_memory_candidates"] {
        tx.execute(
            &format!(
                "DELETE FROM {table}
                  WHERE session_id = ?1
                    AND source_compartment_start > COALESCE(
                        (SELECT MAX(end_message) FROM compartments WHERE session_id = ?1), -1)"
            ),
            params![session_id],
        )?;
    }
    Ok(())
}

fn apply_fold_tx(
    tx: &rusqlite::Connection,
    session_id: &str,
    fold: &FoldWrite,
) -> rusqlite::Result<Vec<PromotedRef>> {
    let harness = match &fold.harness {
        Some(harness) => harness.clone(),
        None => session_harness_tx(tx, session_id)?,
    };
    let upsert = upsert_compartments_tx(tx, session_id, &fold.compartments, &harness)?;
    if upsert.updated > 0 {
        // A fold normally only appends. Sequences it found occupied by different rows
        // belong to a stale tail it replaced.
        append_m0_mutation_tx(tx, session_id, "compartment_delete", fold.published_at_ms)?;
    }
    let promoted = if fold.promote_facts {
        promote_facts_tx(tx, &fold.project_path, &fold.facts, fold.published_at_ms)?
    } else {
        Vec::new()
    };
    // Events, primers and observations belong to the fold's first application. When
    // every compartment was already in place the fold has been applied before (a resume
    // after a crash), and writing them again would duplicate them.
    if upsert.inserted + upsert.updated == 0 && !fold.compartments.is_empty() {
        return Ok(promoted);
    }
    // Side channels are best effort, as they always were: a failure here must not
    // abort the fold's compartments.
    let _ = insert_historian_events_tx(tx, session_id, &fold.events, &harness);
    for candidate in &fold.primer_candidates {
        if insert_historian_primer_tx(tx, candidate, &harness).is_err() {
            break;
        }
    }
    for candidate in &fold.user_memory_candidates {
        if crate::insert_historian_user_observation_tx(tx, candidate).is_err() {
            break;
        }
    }
    Ok(promoted)
}

fn apply_lineage_copy_tx(
    tx: &rusqlite::Connection,
    target_key: &str,
    source_key: &str,
    placeholder: &StoredCompartment,
) -> rusqlite::Result<()> {
    delete_compartments_where_tx(tx, target_key, "sequence >= ?2", i64::MIN)?;
    tx.execute(
        "DELETE FROM notes WHERE session_id = ?1 AND type = 'session'",
        params![target_key],
    )?;
    // Session notes follow the descended conversation key. Smart notes are not copied:
    // their project-wide visibility is independent of one lineage's retained history.
    tx.execute(
        "INSERT INTO notes (type, project_path, session_id, content, status, surface_condition,
                            compiled_provider, compiled_config, compiled_at, compile_status,
                            ready_at, ready_reason, manifest_json, compiled_check, check_hash,
                            check_cron, check_failure_count, check_network_failure_count,
                            check_quarantined_until, check_next_due_at, check_compiled_at,
                            check_false_since_at, check_last_liveness_at, last_checked_at,
                            check_status, check_version, policy_version, harness,
                            anchor_block_id, anchor_ordinal, created_at, updated_at)
         SELECT type, project_path, ?1, content, status, surface_condition,
                compiled_provider, compiled_config, compiled_at, compile_status,
                ready_at, ready_reason, manifest_json, compiled_check, check_hash,
                check_cron, check_failure_count, check_network_failure_count,
                check_quarantined_until, check_next_due_at, check_compiled_at,
                check_false_since_at, check_last_liveness_at, last_checked_at,
                check_status, check_version, policy_version, harness,
                anchor_block_id, anchor_ordinal, created_at, updated_at
           FROM notes WHERE session_id = ?2 AND type = 'session'",
        params![target_key, source_key],
    )?;
    tx.execute(
        "INSERT INTO compartments (
             session_id, sequence, start_message, end_message, start_message_id,
             end_message_id, title, content, p1, p2, p3, p4, importance, episode_type,
             legacy, created_at, harness
         )
         SELECT ?1, sequence, start_message, end_message, start_message_id,
                end_message_id, title, content, p1, p2, p3, p4, importance, episode_type,
                legacy, created_at, harness
           FROM compartments WHERE session_id = ?2",
        params![target_key, source_key],
    )?;
    let harness = session_harness_tx(tx, target_key)?;
    insert_compartment_tx(
        tx,
        target_key,
        placeholder.sequence,
        placeholder,
        &harness,
    )?;
    Ok(())
}

fn apply_pending_tx(
    tx: &rusqlite::Connection,
    session_id: &str,
    write: &PendingContextWrite,
) -> rusqlite::Result<Vec<PromotedRef>> {
    match write {
        PendingContextWrite::Fold(fold) => apply_fold_tx(tx, session_id, fold),
        PendingContextWrite::ReplaceCompartments {
            compartments,
            now_ms,
        } => {
            let harness = session_harness_tx(tx, session_id)?;
            let upsert = upsert_compartments_tx(tx, session_id, compartments, &harness)?;
            let keep: std::collections::BTreeSet<i64> =
                compartments.iter().map(|row| row.sequence).collect();
            let mut deleted = 0;
            for (_, stored) in read_session_compartments(tx, session_id)? {
                if !keep.contains(&stored.sequence) {
                    deleted +=
                        delete_compartments_where_tx(tx, session_id, "sequence = ?2", stored.sequence)?;
                }
            }
            if upsert.updated + deleted > 0 {
                append_m0_mutation_tx(tx, session_id, "recomp_boundary_change", *now_ms)?;
            }
            Ok(Vec::new())
        }
        PendingContextWrite::ClearSession { now_ms } => {
            let deleted = delete_compartments_where_tx(tx, session_id, "sequence >= ?2", i64::MIN)?;
            for table in ["compartment_events", "primer_candidates", "user_memory_candidates"] {
                tx.execute(
                    &format!("DELETE FROM {table} WHERE session_id = ?1"),
                    params![session_id],
                )?;
            }
            if deleted > 0 {
                append_m0_mutation_tx(tx, session_id, "compartment_delete", *now_ms)?;
            }
            Ok(Vec::new())
        }
        PendingContextWrite::TruncateAfter {
            keep_through_seq,
            now_ms,
        } => {
            let deleted =
                delete_compartments_where_tx(tx, session_id, "sequence > ?2", *keep_through_seq)?;
            delete_candidates_past_tail_tx(tx, session_id)?;
            if deleted > 0 {
                append_m0_mutation_tx(tx, session_id, "compartment_delete", *now_ms)?;
            }
            Ok(Vec::new())
        }
        PendingContextWrite::LineageCopy {
            source_key,
            placeholder,
        } => {
            apply_lineage_copy_tx(tx, session_id, source_key, placeholder)?;
            Ok(Vec::new())
        }
    }
}

/// Record `write` as the session's pending `context.db` half, inside the caller's
/// `store.db` transaction. Fails when one is already pending: the caller resumes that one
/// before starting a new write, so a second one here means a concurrent writer.
pub(crate) fn record_pending_context_write_tx(
    tx: &rusqlite::Connection,
    session_id: &str,
    write: &PendingContextWrite,
) -> rusqlite::Result<()> {
    let json = serde_json::to_string(write)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
    tx.execute(
        "INSERT INTO mc_single_store_pending_publish (session_id, publish_json, created_at)
         VALUES (?1, ?2, ?3)",
        params![session_id, json, current_time_ms()],
    )?;
    Ok(())
}

impl McStore {
    /// Apply a pending `context.db` half, then delete its row. Returns the memories a
    /// fold promoted.
    pub(crate) fn complete_pending_context_write(
        &self,
        session_id: &str,
        write: &PendingContextWrite,
    ) -> Result<Vec<PromotedRef>, McStoreError> {
        let promoted =
            self.context_write(HISTORY_TABLES, |tx| apply_pending_tx(tx, session_id, write))?;
        self.inner.with_conn_fenced(|tx| {
            tx.execute(
                "DELETE FROM mc_single_store_pending_publish WHERE session_id = ?1",
                params![session_id],
            )?;
            Ok(())
        })?;
        Ok(promoted)
    }

    /// Finish the session's pending `context.db` write, if a crash or a busy `context.db`
    /// left one. Returns whether there was one.
    pub fn resume_pending_context_write(&self, session_id: &str) -> Result<bool, McStoreError> {
        let pending: Option<String> = self.inner.with_conn(|conn| {
            conn.query_row(
                "SELECT publish_json FROM mc_single_store_pending_publish WHERE session_id = ?1",
                params![session_id],
                |row| row.get(0),
            )
            .optional()
        })?;
        let Some(json) = pending else {
            return Ok(false);
        };
        let write: PendingContextWrite =
            serde_json::from_str(&json).map_err(|error| McStoreError::Serde(error.to_string()))?;
        self.complete_pending_context_write(session_id, &write)?;
        Ok(true)
    }

    /// Finish every session's pending `context.db` write. The module runs this once at
    /// start, so a write interrupted by the previous process lands before any pass reads.
    pub fn resume_all_pending_context_writes(&self) -> Result<usize, McStoreError> {
        let sessions: Vec<String> = self.inner.with_conn(|conn| {
            let mut statement = conn.prepare(
                "SELECT session_id FROM mc_single_store_pending_publish ORDER BY created_at",
            )?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })?;
        let mut resumed = 0;
        for session_id in sessions {
            if self.resume_pending_context_write(&session_id)? {
                resumed += 1;
            }
        }
        Ok(resumed)
    }

    /// Whether the session has a `context.db` write that has not landed yet.
    pub fn has_pending_context_write(&self, session_id: &str) -> Result<bool, McStoreError> {
        let exists: i64 = self.inner.with_conn(|conn| {
            conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM mc_single_store_pending_publish WHERE session_id = ?1)",
                params![session_id],
                |row| row.get(0),
            )
        })?;
        Ok(exists != 0)
    }

    /// Append compartments at the session's tail in one `context.db` transaction. There
    /// is no cache half, so nothing is recorded as pending.
    pub(crate) fn append_compartments_now(
        &self,
        session_id: &str,
        compartments: &[StoredCompartment],
    ) -> Result<crate::AppendCompartmentsTxnOutcome, McStoreError> {
        self.context_write(HISTORY_TABLES, |tx| {
            append_compartments_tx(tx, session_id, compartments)
        })
    }
}
