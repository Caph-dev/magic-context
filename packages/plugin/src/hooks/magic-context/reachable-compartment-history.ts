import { getCompartments } from "../../features/magic-context/compartment-storage";
import type { Database } from "../../shared/sqlite";

/**
 * Find the first compartment whose start or end message ID is no longer on
 * this branch. A host may hide an entire prefix after compaction, so require
 * at least one stored endpoint ID to still occur in the visible messages.
 */
export function firstUnreachableCompartment(
    compartments: readonly { startMessageId: string; endMessageId: string }[],
    reachable: ReadonlySet<string>,
): number | null {
    let precedingAnchor = false;
    for (let i = 0; i < compartments.length; i++) {
        const { startMessageId, endMessageId } = compartments[i];
        const start = !!startMessageId && reachable.has(startMessageId);
        const end = !!endMessageId && reachable.has(endMessageId);
        if (precedingAnchor && (!start || !end)) return i;
        if (start !== end) return i;
        if (end) precedingAnchor = true;
    }
    return null;
}

/**
 * Delete obsolete compartment, event, embedding, and session-fact rows in one
 * transaction so readers never see a partial deletion. Project-wide memories
 * previously extracted from these compartments remain untouched.
 */
export function truncateCompartmentHistory(
    db: Database,
    sessionId: string,
    firstSequence: number,
): void {
    db.transaction(() => {
        const first = db
            .prepare("SELECT id FROM compartments WHERE session_id = ? AND sequence >= ? LIMIT 1")
            .get(sessionId, firstSequence);
        if (!first) return;
        db.prepare(
            "DELETE FROM compartment_events WHERE session_id = ? AND (compartment_id IN (SELECT id FROM compartments WHERE session_id = ? AND sequence >= ?) OR at_compartment >= ?)",
        ).run(sessionId, sessionId, firstSequence, firstSequence);
        db.prepare(
            "DELETE FROM compartment_chunk_embeddings WHERE session_id = ? AND compartment_id IN (SELECT id FROM compartments WHERE session_id = ? AND sequence >= ?)",
        ).run(sessionId, sessionId, firstSequence);
        db.prepare("DELETE FROM compartments WHERE session_id = ? AND sequence >= ?").run(
            sessionId,
            firstSequence,
        );
        db.prepare("DELETE FROM session_facts WHERE session_id = ?").run(sessionId);
        db.prepare(`UPDATE session_meta SET cached_m0_bytes = NULL, cached_m1_bytes = NULL,
            cached_m0_last_baseline_end_message_id = NULL, memory_block_cache = '',
            cached_m0_max_compartment_seq = NULL, prior_boundary_ordinal = 1,
            compaction_marker_state = '', compaction_marker_target_end_message_id = NULL,
            pending_compaction_marker_state = NULL, compartment_in_progress = 0
            WHERE session_id = ?`).run(sessionId);
    }).immediate();
}

export function truncateRemovedCompartmentAnchor(
    db: Database,
    sessionId: string,
    removedMessageId: string,
): boolean {
    const rows = getCompartments(db, sessionId);
    const endpoint = rows.find(
        (row) => row.startMessageId === removedMessageId || row.endMessageId === removedMessageId,
    );
    // An interior message's index position only identifies its compartment
    // if that same index also contains both of the compartment's endpoint IDs.
    const indexed = db
        .prepare(
            "SELECT message_ordinal FROM message_history_source WHERE session_id = ? AND message_id = ?",
        )
        .get(sessionId, removedMessageId) as { message_ordinal: number } | undefined;
    const first =
        endpoint ??
        (indexed
            ? rows.find((row) => {
                  const start = db
                      .prepare(
                          "SELECT message_ordinal FROM message_history_source WHERE session_id = ? AND message_id = ?",
                      )
                      .get(sessionId, row.startMessageId) as
                      | { message_ordinal: number }
                      | undefined;
                  const end = db
                      .prepare(
                          "SELECT message_ordinal FROM message_history_source WHERE session_id = ? AND message_id = ?",
                      )
                      .get(sessionId, row.endMessageId) as { message_ordinal: number } | undefined;
                  return (
                      start &&
                      end &&
                      start.message_ordinal <= indexed.message_ordinal &&
                      indexed.message_ordinal <= end.message_ordinal
                  );
              })
            : undefined);
    if (!first) return false;
    truncateCompartmentHistory(db, sessionId, first.sequence);
    return true;
}

export function truncateUnreachableCompartmentHistory(
    db: Database,
    sessionId: string,
    reachable: ReadonlySet<string>,
): boolean {
    const rows = getCompartments(db, sessionId);
    if (!rows.length || rows.some((row) => !row.startMessageId || !row.endMessageId)) return false;
    const first = firstUnreachableCompartment(rows, reachable);
    if (first === null) {
        // Compaction or a pending summary may hide every stored endpoint from
        // this array without deleting its messages. There is no shared ID to
        // establish which stored range was removed.
        return false;
    }
    truncateCompartmentHistory(db, sessionId, rows[first].sequence);
    return true;
}
