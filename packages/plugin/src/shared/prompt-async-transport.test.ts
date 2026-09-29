import { describe, expect, mock, test } from "bun:test";
import { refuseBudgetedToolCall } from "../features/magic-context/dreamer/token-budget";
import { createDroppedInputToolExecuteBeforeHook } from "../hooks/magic-context/dropped-input-guard";
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

describe("dreamer budget on an async child", () => {
    test("returns the final manifest after a soft nudge without changing the child agent", async () => {
        const host = asyncHost({ plan: ["busy", "settle"] });
        const messages: Array<{
            info: {
                id: string;
                role: string;
                tokens?: unknown;
                time?: { completed: number };
                finish?: string;
            };
            parts: unknown[];
        }> = [];
        let sends = 0;
        const client = {
            session: {
                messages: async () => ({ data: [...messages] }),
                promptAsync: mock(async (_req: unknown) => {
                    sends++;
                    messages.push({ info: { id: `u${sends}`, role: "user" }, parts: [] });
                    return { data: undefined };
                }),
                abort: host.abort,
                status: async () => {
                    if (sends === 1 && !messages.some((m) => m.info.id === "a1")) {
                        messages.push({
                            info: {
                                id: "a1",
                                role: "assistant",
                                tokens: { input: 81 },
                                time: { completed: 1 },
                                finish: "tool-calls",
                            },
                            parts: [],
                        });
                    }
                    if (sends === 2 && !messages.some((m) => m.info.id === "a2")) {
                        messages.push({
                            info: {
                                id: "a2",
                                role: "assistant",
                                tokens: { input: 1 },
                                time: { completed: 2 },
                                finish: "stop",
                            },
                            parts: [{ type: "text", text: "<mappings/>" }],
                        });
                    }
                    return {
                        data:
                            sends === 1 && host.abort.mock.calls.length === 0
                                ? { "ses-child": { type: "busy" } }
                                : {},
                    };
                },
            },
        } as never;
        const body = {
            ...request(),
            body: {
                agent: "dreamer-memory-mapper",
                system: "same system",
                parts: [{ type: "text", text: "work" }],
            },
        };
        await promptAsyncAndWaitForIdle(client, body, { pollIntervalMs: 1, tokenBudget: 100 });
        const prompts = (client as { session: { promptAsync: ReturnType<typeof mock> } }).session
            .promptAsync.mock.calls;
        expect(prompts).toHaveLength(2);
        expect((prompts[1]?.[0] as typeof body).body.agent).toBe(
            (prompts[0]?.[0] as typeof body).body.agent,
        );
        expect(messages.at(-1)?.parts).toEqual([{ type: "text", text: "<mappings/>" }]);
        expect(host.abort).toHaveBeenCalledTimes(1);
    });
    test("finalizes once, refuses two tool calls, and keeps agent and tools unchanged", async () => {
        const messages: Array<{
            info: {
                id: string;
                role: string;
                tokens?: unknown;
                time?: { completed: number };
                finish?: string;
            };
            parts: unknown[];
        }> = [];
        const toolsByAgent: Record<string, unknown[]> = {
            "dreamer-memory-mapper": [{ name: "read", parameters: { type: "object" } }],
        };
        const capturedTools: string[] = [];
        const prompts: unknown[] = [];
        let stage = 0;
        const client = {
            session: {
                messages: async () => ({ data: [...messages] }),
                promptAsync: async (req: unknown) => {
                    prompts.push(req);
                    const agent = (req as { body: { agent: string } }).body.agent;
                    capturedTools.push(JSON.stringify(toolsByAgent[agent] ?? []));
                    if (prompts.length === 1)
                        messages.push({ info: { id: "u1", role: "user" }, parts: [] });
                    else messages.push({ info: { id: "u2", role: "user" }, parts: [] });
                    return { data: undefined };
                },
                abort: mock(async () => ({ data: true })),
                status: async () => {
                    stage++;
                    if (stage === 1)
                        messages.push({
                            info: {
                                id: "a1",
                                role: "assistant",
                                tokens: { input: 10, cache: { read: 71, write: 0 } },
                                time: { completed: 1 },
                                finish: "tool-calls",
                            },
                            parts: [],
                        });
                    if (prompts.length === 2 && !messages.some((m) => m.info.id === "a2"))
                        messages.push({
                            info: {
                                id: "a2",
                                role: "assistant",
                                tokens: { input: 1, cache: { read: 1, write: 0 } },
                                time: { completed: 2 },
                                finish: "stop",
                            },
                            parts: [{ type: "text", text: "<manifest/>" }],
                        });
                    return { data: stage === 1 ? { "ses-child": { type: "busy" } } : {} };
                },
            },
        } as never;
        const run = promptAsyncAndWaitForIdle(
            client,
            {
                ...request(),
                body: { agent: "dreamer-memory-mapper", parts: [{ type: "text", text: "go" }] },
            },
            { pollIntervalMs: 1, tokenBudget: 100 },
        );
        // Wait for the follow-up to be enqueued before simulating the tool hook.
        while (prompts.length < 2) await new Promise((resolve) => setTimeout(resolve, 1));
        const before = createDroppedInputToolExecuteBeforeHook();
        await expect(
            before({ sessionID: "ses-child", tool: "read" }, { args: { path: "a" } }),
        ).rejects.toThrow("Out of token budget");
        await expect(
            before({ sessionID: "ses-child", tool: "read" }, { args: { path: "b" } }),
        ).rejects.toThrow("Out of token budget");
        await expect(run).rejects.toThrow("token_budget");
        expect(prompts).toHaveLength(2);
        expect(capturedTools[0]).not.toBe("[]");
        expect(capturedTools[1]).toBe(capturedTools[0]);
        expect(
            (prompts[1] as { body: { parts: Array<{ text: string }> } }).body.parts[0]?.text,
        ).toContain("no more tool calls");
        expect(refuseBudgetedToolCall("ses-child")).toBeNull();
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
