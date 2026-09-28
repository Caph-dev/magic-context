/// <reference types="bun-types" />

/**
 * A verify batch that outlives Bun's fetch timer on a real OpenCode 1 host.
 *
 * Some OpenCode 1 builds hand plugins an SDK client whose fetch keeps Bun's
 * default request timer, which rejects after 300-360 s with
 * `TimeoutError: The operation timed out.` (see
 * docs/reports/dreamer-host-fetch-timeout.md). The dreamer used to hold one
 * synchronous `session.prompt` open for a whole batch, so on those builds any
 * batch longer than that timer failed with the host's error while the child kept
 * running.
 *
 * Here the model never answers and the batch's own slice is 420 s. The batch
 * must end on our slice, not the host timer: the ledger row says
 * `prompt timed out after …ms` and lasted longer than the host timer could
 * have allowed, the child's loop is stopped, and the run stops cleanly without
 * a hot retry.
 */

import { afterAll, beforeAll, expect, it } from "bun:test";
import { TestHarness } from "../src/harness";
import {
    assertIsolatedStores,
    busySessions,
    countBanked,
    dreamerConfig,
    isVerifyRequest,
    MOCK_USAGE,
    projectIdentity,
    readDreamerInvocations,
    readTaskState,
    seedMappedMemories,
    startDream,
    userMessagesContaining,
    VERIFY_BATCH_MARKER,
} from "./dreamer-timeout-support";

const TASK = "verify";
/** One 50-memory batch with a 7-minute budget: a 420 s slice. */
const TIMEOUT_MINUTES = 7;
/** Bun's default fetch timer fires by this point at the latest. */
const HOST_TIMER_CEILING_MS = 370_000;
const RUN_WAIT_MS = 10 * 60_000;

let h: TestHarness;

beforeAll(async () => {
    h = await TestHarness.create({
        magicContextConfig: { dreamer: dreamerConfig(TASK, TIMEOUT_MINUTES) },
    });
    assertIsolatedStores(h);
});

afterAll(async () => {
    await h?.dispose();
});

it(
    "a batch longer than the host fetch timer ends on its own slice and stops cleanly",
    async () => {
        h.mock.reset();
        h.mock.setDefault({ text: "ack", usage: MOCK_USAGE });
        const verifyPrompts: number[] = [];
        h.mock.addMatcher((body) => {
            if (!isVerifyRequest(body)) return null;
            verifyPrompts.push(userMessagesContaining(body, VERIFY_BATCH_MARKER));
            // Longer than the whole scenario: only a timer can end this batch.
            return { text: "never delivered", usage: MOCK_USAGE, delayMs: 30 * 60_000 };
        });

        const sessionId = await h.createSession();
        await h.sendPrompt(sessionId, "bootstrap turn for the verify slice scenario");
        const identity = projectIdentity(h);
        const ids = seedMappedMemories(h, identity, 50);

        const startedAt = Date.now();
        const dream = startDream(h, sessionId, TASK);
        await h.waitFor(() => readTaskState(h, identity, TASK)?.last_status ?? null, {
            timeoutMs: RUN_WAIT_MS,
            intervalMs: 2_000,
            label: "verify outcome recorded",
        });
        await dream;
        const finishedAt = Date.now();

        const state = readTaskState(h, identity, TASK);
        const rows = readDreamerInvocations(h, sessionId);
        const busy = await busySessions(h);
        console.log(
            JSON.stringify({ elapsedMs: finishedAt - startedAt, state, rows, busy, verifyPrompts }),
        );

        // One batch prompt. The host may re-send that step when its own 300 s
        // provider-request timer fires, but no second prompt enters the child.
        expect(verifyPrompts.length).toBeGreaterThanOrEqual(1);
        expect(Math.max(...verifyPrompts)).toBe(1);
        expect(rows).toHaveLength(1);
        const row = rows[0];
        // Our slice ended it, and it outlived the host fetch timer.
        expect(row?.status).toBe("timed_out");
        expect(row?.error ?? "").toContain("prompt timed out after");
        expect(row?.error ?? "").not.toContain("TimeoutError");
        expect((row?.ended_at ?? 0) - (row?.started_at ?? 0)).toBeGreaterThan(HOST_TIMER_CEILING_MS);
        // The failed row carries the model that was running, read back from the child.
        expect(row?.model_id).toBe("mock-sonnet");
        expect(countBanked(h, ids)).toBe(0);
        // A batch timeout waits for the next scheduled run instead of hot-retrying.
        expect(state?.last_status).toBe("failed");
        expect(state?.last_error ?? "").toContain("timed out within its time slice");
        expect(state?.retry_count).toBe(0);
        expect(state?.next_due_at ?? 0).toBeGreaterThan(finishedAt);
        // The child's server-side loop was aborted, not left calling the model.
        expect(busy).toEqual([]);
    },
    RUN_WAIT_MS + 120_000,
);
