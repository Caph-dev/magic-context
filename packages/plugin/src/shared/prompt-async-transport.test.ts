import { describe, expect, mock, test } from "bun:test";

import { promptSyncWithValidatedOutputRetry } from "./model-suggestion-retry";
import {
    createPromptAsyncTransport,
    promptAsyncAndWaitForIdle,
    supportsPromptAsync,
} from "./prompt-async-transport";

type Message = {
    info: {
        id: string;
        role: string;
        time: { created: number; completed?: number };
        finish?: string;
        error?: unknown;
    };
    parts: Array<{ type: string; text?: string }>;
};

/**
 * A host double for one child session. `plan` describes what each status poll
 * after the prompt sees: a busy tick, or the moment the run settles with a
 * final assistant message.
 */
function asyncHost(options: {
    plan: Array<"busy" | "idle-pending" | "settle">;
    initialMessages?: Message[];
    answer?: string;
}) {
    const messages: Message[] = [...(options.initialMessages ?? [])];
    let polls = 0;
    let prompted = false;
    const promptAsync = mock(async (_request: unknown) => {
        prompted = true;
        messages.push({
            info: { id: `msg_user_${messages.length}`, role: "user", time: { created: 1 } },
            parts: [{ type: "text", text: "go" }],
        });
        return { data: undefined };
    });
    const prompt = mock(async () => ({}));
    const abort = mock(async () => ({ data: true }));
    const status = mock(async () => {
        if (!prompted) return { data: {} };
        const step = options.plan[Math.min(polls, options.plan.length - 1)];
        polls += 1;
        if (step === "busy") {
            // An intermediate tool-call step is already complete while the loop runs.
            messages.push({
                info: {
                    id: `msg_step_${messages.length}`,
                    role: "assistant",
                    time: { created: 2, completed: 3 },
                    finish: "tool-calls",
                },
                parts: [{ type: "tool" }],
            });
            return { data: { "ses-child": { type: "busy" } } };
        }
        if (step === "settle" && messages.at(-1)?.info.finish !== "stop") {
            messages.push({
                info: {
                    id: `msg_final_${messages.length}`,
                    role: "assistant",
                    time: { created: 4, completed: 5 },
                    finish: "stop",
                },
                parts: [{ type: "text", text: options.answer ?? "<done/>" }],
            });
        }
        return { data: {} };
    });
    const list = mock(async () => ({ data: [...messages] }));
    return {
        client: { session: { promptAsync, prompt, abort, status, messages: list } } as never,
        promptAsync,
        prompt,
        abort,
        status,
        list,
        polls: () => polls,
    };
}

function request(signal?: AbortSignal) {
    return {
        path: { id: "ses-child" },
        query: { directory: "/repo" },
        body: { parts: [{ type: "text", text: "go" }] },
        ...(signal ? { signal } : {}),
    };
}

describe("supportsPromptAsync", () => {
    test("requires both prompt_async and session status", () => {
        expect(supportsPromptAsync(asyncHost({ plan: ["settle"] }).client)).toBe(true);
        expect(supportsPromptAsync({ session: { prompt: async () => ({}) } } as never)).toBe(false);
        expect(supportsPromptAsync(undefined)).toBe(false);
        expect(createPromptAsyncTransport({ session: {} } as never, "ses-child")).toBeUndefined();
    });
});

describe("promptAsyncAndWaitForIdle", () => {
    test("returns only after the child is idle with a settled final assistant message", async () => {
        const host = asyncHost({ plan: ["busy", "busy", "busy", "settle"] });

        await promptAsyncAndWaitForIdle(host.client, request(), { pollIntervalMs: 1 });

        expect(host.promptAsync).toHaveBeenCalledTimes(1);
        expect(host.prompt).not.toHaveBeenCalled();
        // Completed tool-call steps during busy polls must not end the wait early.
        expect(host.polls()).toBe(4);
        expect(host.promptAsync.mock.calls[0]?.[0]).toMatchObject({
            path: { id: "ses-child" },
            query: { directory: "/repo" },
        });
    });

    test("keeps waiting through an idle gap before the run starts", async () => {
        const host = asyncHost({ plan: ["idle-pending", "idle-pending", "busy", "settle"] });

        await promptAsyncAndWaitForIdle(host.client, request(), {
            pollIntervalMs: 1,
            startGraceMs: 60_000,
        });

        expect(host.polls()).toBe(4);
    });

    test("ignores an assistant answer left by an earlier attempt in the same child", async () => {
        const earlier: Message = {
            info: {
                id: "msg_old",
                role: "assistant",
                time: { created: 0, completed: 0 },
                finish: "stop",
            },
            parts: [{ type: "text", text: "stale" }],
        };
        const host = asyncHost({
            plan: ["idle-pending", "busy", "settle"],
            initialMessages: [earlier],
        });

        await promptAsyncAndWaitForIdle(host.client, request(), {
            pollIntervalMs: 1,
            startGraceMs: 60_000,
        });

        expect(host.polls()).toBe(3);
    });

    test("fails when no run starts within the start grace", async () => {
        const host = asyncHost({ plan: ["idle-pending"] });
        host.promptAsync.mockImplementation(async () => ({ data: undefined }));

        await expect(
            promptAsyncAndWaitForIdle(host.client, request(), {
                pollIntervalMs: 1,
                startGraceMs: 20,
            }),
        ).rejects.toThrow("did not start a run");
    });

    test("surfaces a rejected prompt_async request", async () => {
        const host = asyncHost({ plan: ["settle"] });
        host.promptAsync.mockImplementation(async () => ({
            data: undefined,
            error: { name: "BadRequest", data: { message: "unknown agent" } },
        }));

        await expect(
            promptAsyncAndWaitForIdle(host.client, request(), { pollIntervalMs: 1 }),
        ).rejects.toThrow("prompt_async was rejected");
    });

    test("stops waiting as soon as the caller's signal aborts", async () => {
        const host = asyncHost({ plan: ["busy"] });
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 20);

        await expect(
            promptAsyncAndWaitForIdle(host.client, request(controller.signal), {
                pollIntervalMs: 5,
            }),
        ).rejects.toBeDefined();
    });
});

describe("prompt_async transport under the retry chain", () => {
    test("our slice stays the only timer and aborts the busy child when it expires", async () => {
        const host = asyncHost({ plan: ["busy"] });
        const transport = createPromptAsyncTransport(host.client, "ses-child", {
            pollIntervalMs: 5,
        });
        expect(transport).toBeDefined();

        let caught: unknown;
        try {
            await promptSyncWithValidatedOutputRetry(host.client, request(), {
                transport,
                timeoutMs: 60,
                fallbackModels: ["anthropic/claude-sonnet-4-6"],
                fetchOutput: async () => "unused",
                validateOutput: (output: string) => output,
            });
        } catch (error) {
            caught = error;
        }

        expect((caught as Error).message).toBe("prompt timed out after 60ms");
        expect(host.promptAsync).toHaveBeenCalledTimes(1);
        expect(host.prompt).not.toHaveBeenCalled();
        expect(host.abort).toHaveBeenCalledWith({ path: { id: "ses-child" } });
    });
});
