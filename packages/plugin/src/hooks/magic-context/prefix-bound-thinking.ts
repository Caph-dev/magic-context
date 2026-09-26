import { createHash } from "node:crypto";

import { BoundedSessionMap } from "../../shared/bounded-session-map";
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
 * provider last saw, each served pass records one digest per served message,
 * and the next busting pass compares its own array against that record.
 *
 * The record is process memory only. After a restart (or for a session this
 * process never served) there is nothing to compare against, so no thinking is
 * removed proactively and the reactive binding recovery stays the backstop.
 */

const SERVED_DIGEST_SESSION_CAP = 200;

const servedDigestsBySession = new BoundedSessionMap<readonly string[]>(SERVED_DIGEST_SESSION_CAP);

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
        // unique token makes it compare as changed, which only ever removes
        // more thinking on a busting pass, never less.
        unserializableCounter += 1;
        return `unserializable:${unserializableCounter}`;
    }
    return createHash("sha256").update(json).digest("hex").slice(0, 32);
}

/**
 * One digest per OpenCode message, over the role and the parts only. Message
 * `info` carries host bookkeeping that is not sent to the provider (token
 * counts, timestamps, summaries) and can change without the wire changing.
 */
export function digestOpenCodeServedMessages(messages: readonly MessageLike[]): string[] {
    return messages.map((message) =>
        digestProjection({ role: message?.info?.role ?? null, parts: message?.parts ?? null }),
    );
}

/** One digest per Pi AgentMessage. Pi serves the message object as-is. */
export function digestPiServedMessages(messages: readonly unknown[]): string[] {
    return messages.map((message) => digestProjection(message));
}

/**
 * Index of the first served message that differs from the previous served
 * array, or -1 when the current array repeats every previously served message
 * in order (appending new messages is not a change). When messages were
 * removed from the end, the first missing index is returned.
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

/** Digests of the array most recently served for this session, if known. */
export function getLastServedDigests(sessionId: string): readonly string[] | undefined {
    return servedDigestsBySession.get(sessionId);
}

/** Record the array a pass actually handed to the host for the provider request. */
export function recordServedDigests(sessionId: string, digests: readonly string[]): void {
    servedDigestsBySession.set(sessionId, [...digests]);
}

export function forgetServedDigests(sessionId: string): void {
    servedDigestsBySession.delete(sessionId);
}

export function resetServedDigestsForTest(): void {
    servedDigestsBySession.clear();
    unserializableCounter = 0;
}
