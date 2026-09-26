import { createHash, randomUUID } from "node:crypto";

import { addMergedReasoningStrippedIds } from "../../features/magic-context/storage-meta-persisted";
import { ensureSessionMetaRow } from "../../features/magic-context/storage-meta-shared";
import { BoundedSessionMap } from "../../shared/bounded-session-map";
import { sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import type { MessageLike } from "./transform-operations";

/**
 * Served-array ledger for models whose signed thinking is bound to every byte
 * before it (Anthropic Claude Fable 5.1 and Claude Opus 5.5, see
 * isPrefixBoundThinkingModel).
 *
 * On those models a thinking block stays valid only while everything sent
 * before it is unchanged. When a cache-busting pass changes a served message,
 * every thinking block after that message is invalid: older accounts drop it
 * silently, `drop_block` drops it, and accounts created on or after
 * 2026-08-31 reject the request with a 400. The busting pass therefore removes
 * that thinking itself. To find where this pass first differs from what the
 * provider last saw, each served pass records one digest per message that
 * reaches the wire, and the next busting pass compares its own array against
 * that record.
 *
 * The record is kept in process memory, so it can only be trusted while no
 * other serve happened in between. Two guards make an untrusted record read
 * as unknown (and an unknown record strips nothing, leaving the reactive
 * binding recovery as the fallback):
 *
 * - A durable serve stamp in `session_meta.deferred_execute_state`. Every pass
 *   whose served bytes differ from the trusted record, and every pass that had
 *   no trusted record, writes a fresh stamp before it serves; the record keeps
 *   the stamp it was served under. Another process that serves anything other
 *   than an append therefore invalidates this process's record.
 * - A pass that starts but never commits its serve (it threw, or a
 *   last-known-good or raw fallback served instead) leaves no record.
 *
 * Thinking a busting pass decides to remove is persisted only once that pass
 * has been served (see `recordServedDigests` / `commitServedPass`), so a pass
 * that fails after the decision leaves the persisted set untouched.
 */

const SERVED_DIGEST_SESSION_CAP = 200;
const SERVE_STAMP_KEY = "prefixBoundServeStamp";
const SERVE_STAMP_CAS_ATTEMPTS = 4;

/** Digests of the messages of one served array that reach the provider. */
export interface ServedDigests {
    readonly digests: readonly string[];
    /** Index in the served array of the message each digest belongs to. */
    readonly indices: readonly number[];
}

/** A committed serve, with the durable stamp it was served under. */
export interface ServedRecord {
    readonly digests: readonly string[];
    /** Null when the serve could not be stamped; such a record is never trusted. */
    readonly stamp: string | null;
}

interface SessionServeState {
    record?: ServedRecord;
    /** A pass began and has not committed its serve yet. */
    inFlight: boolean;
    staged?: { db: Database; served: ServedDigests; stamp: string | null };
    stagedFreeze?: { db: Database; entries: readonly string[] };
    /** Ledger entries of served strips whose persistence failed; retried and replayed. */
    unpersisted: Set<string>;
}

const serveStateBySession = new BoundedSessionMap<SessionServeState>(SERVED_DIGEST_SESSION_CAP);

function stateFor(sessionId: string): SessionServeState {
    let state = serveStateBySession.get(sessionId);
    if (!state) {
        state = { inFlight: false, unpersisted: new Set() };
        serveStateBySession.set(sessionId, state);
    }
    return state;
}

let unserializableCounter = 0;

function digestProjection(projection: unknown): string {
    let json: string | undefined;
    try {
        json = JSON.stringify(projection);
    } catch {
        json = undefined;
    }
    if (typeof json !== "string") {
        // A message that cannot be serialized cannot be proven unchanged. A
        // unique token makes it compare as changed.
        unserializableCounter += 1;
        return `unserializable:${unserializableCounter}`;
    }
    return createHash("sha256").update(json).digest("hex").slice(0, 32);
}

// OpenCode part types that are bookkeeping and never become provider content.
const NON_WIRE_PART_TYPES = new Set(["step-start", "step-finish", "snapshot", "patch"]);

function partReachesWire(part: unknown): boolean {
    if (part === null || typeof part !== "object") return true;
    const record = part as { type?: unknown; text?: unknown };
    if (typeof record.type === "string" && NON_WIRE_PART_TYPES.has(record.type)) return false;
    // Empty text parts (the sentinels that stand in for stripped parts) are
    // removed by the Anthropic adapter before the request is built.
    return !(record.type === "text" && record.text === "");
}

/**
 * One digest per OpenCode message that reaches the wire, over its role and the
 * parts that reach the wire. Message `info` carries host bookkeeping that is
 * not sent (token counts, timestamps, summaries), and a message left with no
 * wire parts is dropped before the request is built.
 */
export function digestOpenCodeServedMessages(messages: readonly MessageLike[]): ServedDigests {
    const digests: string[] = [];
    const indices: number[] = [];
    messages.forEach((message, index) => {
        const parts = Array.isArray(message?.parts) ? message.parts.filter(partReachesWire) : [];
        if (parts.length === 0) return;
        digests.push(digestProjection({ role: message?.info?.role ?? null, parts }));
        indices.push(index);
    });
    return { digests, indices };
}

/** One digest per Pi AgentMessage. Pi serves the message object as-is. */
export function digestPiServedMessages(messages: readonly unknown[]): ServedDigests {
    return {
        digests: messages.map((message) => digestProjection(message)),
        indices: messages.map((_message, index) => index),
    };
}

/**
 * Index of the first served digest that differs from the previous served
 * digests, or -1 when the current list repeats every previous digest in order
 * (appending is not a change). When digests were removed from the end, the
 * first missing position is returned.
 */
export function firstServedDivergence(
    previous: readonly string[],
    current: readonly string[],
): number {
    const shared = Math.min(previous.length, current.length);
    for (let index = 0; index < shared; index += 1) {
        if (previous[index] !== current[index]) return index;
    }
    return current.length < previous.length ? current.length : -1;
}

/**
 * Index in the current served array of the first message that differs from
 * the previous serve, or -1 for none. `arrayLength` is returned when only
 * trailing messages were removed.
 */
export function firstChangedServedIndex(
    previous: readonly string[],
    current: ServedDigests,
    arrayLength: number,
): number {
    const position = firstServedDivergence(previous, current.digests);
    if (position < 0) return -1;
    return current.indices[position] ?? arrayLength;
}

function readStateRoot(
    db: Database,
    sessionId: string,
): { raw: string | null; root: Record<string, unknown> } | null {
    const row = db
        .prepare("SELECT deferred_execute_state FROM session_meta WHERE session_id = ?")
        .get(sessionId) as { deferred_execute_state?: string | null } | undefined | null;
    if (!row) return null;
    const raw = row.deferred_execute_state ?? null;
    if (!raw) return { raw, root: {} };
    try {
        const parsed = JSON.parse(raw) as unknown;
        return {
            raw,
            root:
                typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
                    ? { ...(parsed as Record<string, unknown>) }
                    : {},
        };
    } catch {
        return { raw, root: {} };
    }
}

/** The durable stamp of the latest serve that changed bytes, if any. */
export function readServeStamp(db: Database, sessionId: string): string | null {
    try {
        const value = readStateRoot(db, sessionId)?.root[SERVE_STAMP_KEY];
        return typeof value === "string" && value.length > 0 ? value : null;
    } catch {
        return null;
    }
}

/** Write a fresh durable stamp; null when it could not be written. */
function writeFreshServeStamp(db: Database, sessionId: string): string | null {
    const stamp = randomUUID();
    try {
        ensureSessionMetaRow(db, sessionId);
        for (let attempt = 0; attempt < SERVE_STAMP_CAS_ATTEMPTS; attempt += 1) {
            const current = readStateRoot(db, sessionId);
            if (!current) return null;
            current.root[SERVE_STAMP_KEY] = stamp;
            const result = db
                .prepare(
                    "UPDATE session_meta SET deferred_execute_state = ? WHERE session_id = ? AND deferred_execute_state IS ?",
                )
                .run(JSON.stringify(current.root), sessionId, current.raw);
            if (result.changes > 0) return stamp;
        }
    } catch (error) {
        sessionLog(sessionId, "prefix-bound serve stamp write failed:", error);
    }
    return null;
}

/**
 * Start a pass. A previous pass that never committed its serve served
 * something this process did not record, so its record is dropped. Strips
 * whose persistence failed earlier are retried here.
 */
export function beginServedPass(sessionId: string, db?: Database): void {
    const state = serveStateBySession.get(sessionId);
    if (!state) return;
    if (state.inFlight) state.record = undefined;
    state.staged = undefined;
    state.stagedFreeze = undefined;
    state.inFlight = true;
    if (db && state.unpersisted.size > 0) {
        try {
            if (addMergedReasoningStrippedIds(db, sessionId, state.unpersisted)) {
                state.unpersisted.clear();
            }
        } catch (error) {
            sessionLog(sessionId, "prefix-bound strip persistence retry failed:", error);
        }
    }
}

/**
 * The previous serve's digests, only when they can be trusted: recorded by this
 * process and not superseded by another serve (the durable stamp still matches).
 */
export function getTrustedServedDigests(
    db: Database,
    sessionId: string,
): readonly string[] | undefined {
    const record = serveStateBySession.get(sessionId)?.record;
    if (!record || record.stamp === null) return undefined;
    return readServeStamp(db, sessionId) === record.stamp ? record.digests : undefined;
}

/** The record last committed by this process, trusted or not (tests and diagnostics). */
export function getLastServedDigests(sessionId: string): ServedRecord | undefined {
    return serveStateBySession.get(sessionId)?.record;
}

/**
 * Stage the array this pass is about to serve. When it differs from the
 * trusted record, or there is no trusted record, a fresh durable stamp is
 * written now, before the bytes go out, so every other record becomes stale.
 */
export function stageServedArray(db: Database, sessionId: string, served: ServedDigests): void {
    const state = stateFor(sessionId);
    const trusted = getTrustedServedDigests(db, sessionId);
    const stamp =
        trusted && firstServedDivergence(trusted, served.digests) < 0
            ? (state.record?.stamp ?? null)
            : writeFreshServeStamp(db, sessionId);
    state.staged = { db, served, stamp };
}

/** Stage ledger entries that this pass strips; they are persisted when the serve commits. */
export function stageProactiveFreeze(
    db: Database,
    sessionId: string,
    entries: readonly string[],
): void {
    if (entries.length === 0) return;
    const state = stateFor(sessionId);
    const previous = state.stagedFreeze?.entries ?? [];
    state.stagedFreeze = { db, entries: [...previous, ...entries] };
}

/** Ledger entries of served strips not yet persisted; replay must apply them too. */
export function unpersistedFrozenEntries(sessionId: string): ReadonlySet<string> {
    return serveStateBySession.get(sessionId)?.unpersisted ?? new Set();
}

function sameDigests(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((digest, index) => digest === right[index]);
}

function commit(sessionId: string, served: ServedDigests | undefined): void {
    // Sessions that never staged a serve (other models) keep no ledger state.
    const state = served ? stateFor(sessionId) : serveStateBySession.get(sessionId);
    if (!state) return;
    const freeze = state.stagedFreeze;
    if (freeze) {
        let persisted = false;
        try {
            persisted = addMergedReasoningStrippedIds(freeze.db, sessionId, freeze.entries);
        } catch (error) {
            sessionLog(sessionId, "prefix-bound strip persistence failed:", error);
        }
        if (!persisted) {
            // The bytes already went out, so later passes must keep serving the
            // strip: replay it from memory and retry persistence next pass.
            for (const entry of freeze.entries) state.unpersisted.add(entry);
            sessionLog(
                sessionId,
                "prefix-bound strip persistence failed after serve; replaying from memory",
            );
        }
    }
    const staged = state.staged;
    const digests = served ?? staged?.served;
    // A serve that staged nothing is unknown to the ledger, so no record survives it.
    state.record = digests
        ? {
              digests: [...digests.digests],
              stamp:
                  staged && sameDigests(staged.served.digests, digests.digests)
                      ? staged.stamp
                      : null,
          }
        : undefined;
    state.staged = undefined;
    state.stagedFreeze = undefined;
    state.inFlight = false;
}

/** Commit the staged serve after the host received the array. */
export function commitServedPass(sessionId: string): void {
    commit(sessionId, undefined);
}

/**
 * Commit a serve with the digests of the array actually handed to the host. A
 * stored record may be passed back to restore it (tests); digests that differ
 * from the staged array are recorded unstamped, which is never trusted.
 */
export function recordServedDigests(sessionId: string, value: ServedDigests | ServedRecord): void {
    if ("stamp" in value) {
        const state = stateFor(sessionId);
        state.record = { digests: [...value.digests], stamp: value.stamp };
        state.staged = undefined;
        state.stagedFreeze = undefined;
        state.inFlight = false;
        return;
    }
    commit(sessionId, value);
}

/**
 * A pass served something other than its staged array (a last-known-good
 * replay or the raw input). Drop the local record and, when the store is
 * reachable, write a fresh stamp so other processes stop trusting theirs.
 */
export function abandonServedPass(sessionId: string, db?: Database | null): void {
    const state = serveStateBySession.get(sessionId);
    if (state) {
        state.record = undefined;
        state.staged = undefined;
        state.stagedFreeze = undefined;
        state.inFlight = false;
    }
    // Only sessions that take part in the ledger carry a stamp worth replacing.
    if (db && (state || readServeStamp(db, sessionId) !== null)) {
        writeFreshServeStamp(db, sessionId);
    }
}

export function resetServedDigestsForTest(): void {
    serveStateBySession.clear();
    unserializableCounter = 0;
}
