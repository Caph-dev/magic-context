import { createHash } from "node:crypto";

import { sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import type { LkgPersistenceBackend, LkgSlot } from "./lkg-slot";

/**
 * Durable persistence for last-known-good (LKG) transform snapshots.
 *
 * The in-memory slot map in lkg-slot.ts dies with the process. When the plugin
 * restarts while the Rust module is reconnecting, the recovery ladder used to
 * have nothing to replay and the turn fell all the way down to the raw-fallback
 * size gate. Persisting the slot an applied pass captured lets a fresh process
 * serve the same replay — subject to exactly the same validity fences a live
 * process applies (hydration only restores the slot; replay validation is
 * unchanged).
 *
 * Write discipline follows the single-stringify precedent: `jsonPrefix` is the
 * exact string captured by the applied pass and is stored as-is — never
 * re-serialized here. Only the small metadata arrays are serialized.
 */

interface LkgSlotRow {
    session_id?: unknown;
    json_prefix?: unknown;
    input_id_seq?: unknown;
    input_content_digests?: unknown;
    input_content_signatures?: unknown;
    last_input_message_id?: unknown;
    model_key?: unknown;
    provider_key?: unknown;
    captured_at?: unknown;
    row_version?: unknown;
    capture_sequence?: unknown;
}

function parseStringArray(value: unknown): string[] | null {
    if (typeof value !== "string") return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch {
        return null;
    }
    if (!Array.isArray(parsed)) return null;
    const result: string[] = [];
    for (const entry of parsed) {
        if (typeof entry !== "string" || entry.length === 0) return null;
        result.push(entry);
    }
    return result;
}

function parseNullableString(value: unknown): string | null | undefined {
    if (value === null || value === undefined) return null;
    return typeof value === "string" ? value : undefined;
}

function parseNullableInteger(value: unknown): number | undefined {
    if (value === null || value === undefined) return undefined;
    return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

/** Parse a stored row into a slot; returns undefined (and reasons to delete) on any malformation. */
export function parsePersistedLkgSlot(row: unknown): LkgSlot | undefined {
    if (!row || typeof row !== "object") return undefined;
    const record = row as LkgSlotRow;
    const jsonPrefix = record.json_prefix;
    const lastInputMessageId = record.last_input_message_id;
    const capturedAt = record.captured_at;
    // Legacy and OpenCode rows keep the plain ID array. Pi adds versioned
    // output ownership so a hydrated slot can prove a head-contraction splice.
    let inputIdsRaw = record.input_id_seq;
    let piOutputEntryIds: (string | null)[] | undefined;
    if (typeof inputIdsRaw === "string") {
        try {
            const metadata = JSON.parse(inputIdsRaw);
            if (
                metadata &&
                !Array.isArray(metadata) &&
                metadata.version === 1 &&
                Array.isArray(metadata.piOutputEntryIds)
            ) {
                if (
                    !metadata.piOutputEntryIds.every(
                        (id: unknown) => id === null || (typeof id === "string" && id.length > 0),
                    )
                )
                    return undefined;
                piOutputEntryIds = metadata.piOutputEntryIds;
                inputIdsRaw = JSON.stringify(metadata.inputIds);
            }
        } catch {
            return undefined;
        }
    }
    const inputIdSeq = parseStringArray(inputIdsRaw);
    const inputContentDigests = parseStringArray(record.input_content_digests);
    const modelKey = parseNullableString(record.model_key);
    const providerKey = parseNullableString(record.provider_key);
    if (
        typeof jsonPrefix !== "string" ||
        typeof lastInputMessageId !== "string" ||
        lastInputMessageId.length === 0 ||
        typeof capturedAt !== "number" ||
        !Number.isFinite(capturedAt) ||
        inputIdSeq === null ||
        inputContentDigests === null ||
        inputContentDigests.length !== inputIdSeq.length ||
        modelKey === undefined ||
        providerKey === undefined
    ) {
        return undefined;
    }
    if (piOutputEntryIds) {
        try {
            const output = JSON.parse(jsonPrefix);
            const inputs = new Set(inputIdSeq);
            if (
                !Array.isArray(output) ||
                output.length !== piOutputEntryIds.length ||
                piOutputEntryIds.some((id) => id !== null && !inputs.has(id))
            )
                return undefined;
        } catch {
            return undefined;
        }
    }
    let inputContentSignatures: string[] | undefined;
    if (record.input_content_signatures !== null && record.input_content_signatures !== undefined) {
        const parsed = parseStringArray(record.input_content_signatures);
        if (parsed === null || parsed.length !== inputIdSeq.length) return undefined;
        inputContentSignatures = parsed;
    }
    const slot: LkgSlot = {
        jsonPrefix,
        inputIdSeq,
        inputContentDigests,
        lastInputMessageId,
        modelKey,
        providerKey,
        capturedAt,
    };
    if (inputContentSignatures) slot.inputContentSignatures = inputContentSignatures;
    if (piOutputEntryIds) slot.piOutputEntryIds = piOutputEntryIds;
    const rowVersion = parseNullableInteger(record.row_version);
    if (rowVersion !== undefined) slot.rowVersion = rowVersion;
    const captureSequence = parseNullableInteger(record.capture_sequence);
    if (captureSequence !== undefined) slot.captureSequence = captureSequence;
    return slot;
}

/**
 * Persist a slot for the session, replacing any prior row. Best-effort: callers
 * treat a failure as "this process still has the in-memory slot" and log.
 */
const persistedFingerprints = new WeakMap<Database, Map<string, string>>();

export function saveLkgSlotToDb(db: Database, sessionId: string, slot: LkgSlot): boolean {
    // capturedAt is the time of this capture, not part of the served request.
    // Keep all replay fences and metadata in the fingerprint so a changed slot
    // always replaces the durable one. Hash without reading the existing row.
    const fingerprint = createHash("sha256")
        .update(
            JSON.stringify([
                slot.jsonPrefix,
                slot.inputIdSeq,
                slot.inputContentDigests,
                slot.inputContentSignatures,
                slot.piOutputEntryIds,
                slot.lastInputMessageId,
                slot.modelKey,
                slot.providerKey,
                slot.rowVersion,
                slot.captureSequence,
            ]),
        )
        .digest("hex");
    let saved = persistedFingerprints.get(db);
    if (saved?.get(sessionId) === fingerprint) return true;
    try {
        db.prepare(
            `INSERT INTO lkg_slots (
                session_id, json_prefix, input_id_seq, input_content_digests,
                input_content_signatures, last_input_message_id, model_key, provider_key,
                captured_at, row_version, capture_sequence
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
                json_prefix = excluded.json_prefix,
                input_id_seq = excluded.input_id_seq,
                input_content_digests = excluded.input_content_digests,
                input_content_signatures = excluded.input_content_signatures,
                last_input_message_id = excluded.last_input_message_id,
                model_key = excluded.model_key,
                provider_key = excluded.provider_key,
                captured_at = excluded.captured_at,
                row_version = excluded.row_version,
                capture_sequence = excluded.capture_sequence`,
        ).run(
            sessionId,
            slot.jsonPrefix,
            JSON.stringify(
                slot.piOutputEntryIds
                    ? {
                          version: 1,
                          inputIds: slot.inputIdSeq,
                          piOutputEntryIds: slot.piOutputEntryIds,
                      }
                    : slot.inputIdSeq,
            ),
            JSON.stringify(slot.inputContentDigests),
            slot.inputContentSignatures ? JSON.stringify(slot.inputContentSignatures) : null,
            slot.lastInputMessageId,
            slot.modelKey,
            slot.providerKey,
            slot.capturedAt,
            slot.rowVersion ?? null,
            slot.captureSequence ?? null,
        );
        if (!saved) {
            saved = new Map();
            persistedFingerprints.set(db, saved);
        }
        if (saved.size >= 1000) {
            const oldest = saved.keys().next().value;
            if (oldest !== undefined) saved.delete(oldest);
        }
        saved.set(sessionId, fingerprint);
        return true;
    } catch (error) {
        sessionLog(sessionId, "LKG snapshot persistence failed (in-memory slot retained):", error);
        return false;
    }
}

export function clearPersistedLkgSlot(db: Database, sessionId: string): void {
    try {
        db.prepare("DELETE FROM lkg_slots WHERE session_id = ?").run(sessionId);
        persistedFingerprints.get(db)?.delete(sessionId);
    } catch (error) {
        sessionLog(sessionId, "LKG snapshot durable clear failed:", error);
    }
}

export function loadPersistedLkgSlot(db: Database, sessionId: string): LkgSlot | undefined {
    let row: unknown;
    try {
        row = db.prepare("SELECT * FROM lkg_slots WHERE session_id = ?").get(sessionId);
    } catch (error) {
        sessionLog(sessionId, "LKG snapshot durable load failed:", error);
        return undefined;
    }
    if (!row) return undefined;
    const slot = parsePersistedLkgSlot(row);
    if (!slot) {
        // A malformed row can never become replayable; remove it so later
        // captures start clean instead of tripping the same parse failure.
        clearPersistedLkgSlot(db, sessionId);
        return undefined;
    }
    // Size admission is enforced by the slot store's own bound when the loaded
    // slot is installed; an oversized row simply declines to hydrate.
    return slot;
}

export function pruneStaleLkgSlots(db: Database, now = Date.now()): number {
    // A zero-wait write transaction lets this maintenance pass yield to active
    // writers. Sessions used within the last week retain their replay snapshots.
    const previousTimeout = db.prepare("PRAGMA busy_timeout").get() as { timeout: number };
    try {
        db.exec("PRAGMA busy_timeout = 0");
        const result = db
            .prepare(
                `DELETE FROM lkg_slots WHERE captured_at < ? AND NOT EXISTS (
                SELECT 1 FROM session_projects sp
                WHERE sp.session_id = lkg_slots.session_id AND sp.updated_at >= ?
            )`,
            )
            .run(now - 7 * 24 * 60 * 60 * 1000, now - 7 * 24 * 60 * 60 * 1000);
        if (result.changes) persistedFingerprints.delete(db);
        return result.changes;
    } finally {
        db.exec(`PRAGMA busy_timeout = ${Number(previousTimeout.timeout) || 0}`);
    }
}

/** Backend bound to one database handle, for registration with the slot store. */
export function createDbLkgPersistence(db: Database): LkgPersistenceBackend {
    return {
        load: (sessionId) => loadPersistedLkgSlot(db, sessionId),
        clear: (sessionId) => clearPersistedLkgSlot(db, sessionId),
    };
}
