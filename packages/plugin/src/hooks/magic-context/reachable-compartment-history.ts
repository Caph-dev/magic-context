import { randomUUID } from "node:crypto";
import {
    acquireCompartmentLease,
    isCompartmentLeaseHeld,
    releaseCompartmentLeaseBestEffort,
} from "../../features/magic-context/compartment-lease";
import {
    type Compartment,
    getCompartments,
} from "../../features/magic-context/compartment-storage";
import { clearPendingOps } from "../../features/magic-context/storage-ops";
import { BoundedSessionMap } from "../../shared/bounded-session-map";
import { sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";

/**
 * Find the first compartment whose start or end message ID is no longer on
 * this branch. A host may hide an entire prefix after compaction, so require
 * at least one stored endpoint ID to still occur in the visible messages.
 */
const ambiguousAncestryLogged = new BoundedSessionMap<boolean>(100);

function logAmbiguousAncestryOnce(sessionId: string, reason: string): void {
    if (ambiguousAncestryLogged.has(sessionId)) return;
    ambiguousAncestryLogged.set(sessionId, true);
    sessionLog(
        sessionId,
        `covered history ancestry unknown: ${reason}; leaving compartments unchanged`,
    );
}

function hasDivergentSuffix(
    rows: readonly { startMessageId: string; endMessageId: string }[],
    reachable: ReadonlySet<string>,
): boolean {
    const ids = Array.from(reachable);
    const storedEndpoints = new Set(rows.flatMap((row) => [row.startMessageId, row.endMessageId]));
    let lastAnchor = -1;
    for (let i = 0; i < ids.length; i++) {
        if (storedEndpoints.has(ids[i])) lastAnchor = i;
    }
    // A truncated input ending at an old anchor is not a new branch. Require
    // actual messages after the shared anchor before deleting stored history.
    return lastAnchor >= 0 && ids.slice(lastAnchor + 1).some((id) => !storedEndpoints.has(id));
}

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
function deleteCompartmentSuffixInTransaction(
    db: Database,
    sessionId: string,
    firstSequence: number,
): void {
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
    // Pending drops name numbered tags on messages from the old conversation.
    // Their targets cannot be trusted after those messages are removed.
    clearPendingOps(db, sessionId);
    db.prepare(`UPDATE session_meta SET cached_m0_bytes = NULL, cached_m1_bytes = NULL,
            cached_m0_last_baseline_end_message_id = NULL, memory_block_cache = '',
            cached_m0_max_compartment_seq = NULL, prior_boundary_ordinal = 1,
            compaction_marker_state = '', compaction_marker_target_end_message_id = NULL,
            pending_compaction_marker_state = NULL, compartment_in_progress = 0
            WHERE session_id = ?`).run(sessionId);
}

export class CompartmentTruncationLeaseBusyError extends Error {
    constructor() {
        super(
            "compartment_truncation_lease_busy: historian publication must finish before history is cut",
        );
        this.name = "CompartmentTruncationLeaseBusyError";
    }
}

function truncateWithLease(
    db: Database,
    sessionId: string,
    chooseFirst: (rows: Compartment[]) => number | null,
): boolean {
    // A historian holds this session's lease while generating compartments.
    // Once acquired, BEGIN IMMEDIATE re-reads the current rows and deletes them
    // under one write lock, so a second connection cannot publish between them.
    const holderId = randomUUID();
    if (!acquireCompartmentLease(db, sessionId, holderId)) {
        throw new CompartmentTruncationLeaseBusyError();
    }
    try {
        return db
            .transaction(() => {
                if (!isCompartmentLeaseHeld(db, sessionId, holderId)) {
                    throw new CompartmentTruncationLeaseBusyError();
                }
                const firstSequence = chooseFirst(getCompartments(db, sessionId));
                if (firstSequence === null) return false;
                deleteCompartmentSuffixInTransaction(db, sessionId, firstSequence);
                return true;
            })
            .immediate();
    } finally {
        releaseCompartmentLeaseBestEffort(db, sessionId, holderId);
    }
}

function firstRemovedCompartmentAnchor(
    db: Database,
    sessionId: string,
    removedMessageId: string,
    rows: Compartment[],
): number | null {
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
    return first?.sequence ?? null;
}

export function truncateRemovedCompartmentAnchor(
    db: Database,
    sessionId: string,
    removedMessageId: string,
): boolean {
    const chooseFirst = (rows: Compartment[]) =>
        firstRemovedCompartmentAnchor(db, sessionId, removedMessageId, rows);
    if (chooseFirst(getCompartments(db, sessionId)) === null) return false;
    return truncateWithLease(db, sessionId, chooseFirst);
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
        if (
            reachable.size > 0 &&
            !rows.some(
                (row) => reachable.has(row.startMessageId) || reachable.has(row.endMessageId),
            )
        ) {
            logAmbiguousAncestryOnce(
                sessionId,
                "no stored endpoint ID on visible branch; compaction or a pending summary may hide the prefix",
            );
        }
        return false;
    }
    if (!hasDivergentSuffix(rows, reachable)) {
        logAmbiguousAncestryOnce(
            sessionId,
            "the visible history ends at a stored anchor without a new branch suffix",
        );
        return false;
    }
    return truncateWithLease(db, sessionId, (currentRows) => {
        const current = firstUnreachableCompartment(currentRows, reachable);
        return current === null || !hasDivergentSuffix(currentRows, reachable)
            ? null
            : currentRows[current].sequence;
    });
}
