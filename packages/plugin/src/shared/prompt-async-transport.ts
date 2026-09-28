import type { createOpencodeClient } from "@opencode-ai/sdk";

import type { PromptArgs, PromptTransport } from "./model-suggestion-retry";

type Client = ReturnType<typeof createOpencodeClient> | undefined;

/**
 * Why this exists: a synchronous `session.prompt` keeps one HTTP request open
 * for a child's whole agent loop, which for a dreamer batch is many minutes.
 * Some OpenCode 1 builds give plugins an SDK client whose fetch keeps Bun's
 * default request timer, which rejects with `TimeoutError` after five to six
 * minutes while the host keeps running the child. Sending with `prompt_async`
 * and polling for idle keeps every request short, so the caller's own slice
 * timer is the only thing that can end the run.
 */

const DEFAULT_POLL_INTERVAL_MS = 1_000;
/** How long an idle child may show no started run before the send is treated as
 * lost. The host creates the user message and marks the session busy right after
 * accepting `prompt_async`, so this only has to cover a slow or contended host. */
const DEFAULT_START_GRACE_MS = 30_000;

export interface PromptAsyncWaitOptions {
    pollIntervalMs?: number;
    startGraceMs?: number;
}

type SessionApi = {
    promptAsync?: (options: unknown) => Promise<unknown>;
    status?: (options?: unknown) => Promise<unknown>;
    messages?: (options: unknown) => Promise<unknown>;
};

function sessionApi(client: Client): SessionApi | undefined {
    return (client as { session?: SessionApi } | undefined)?.session;
}

/** True when the host client can send without waiting and report session status. */
export function supportsPromptAsync(client: Client): boolean {
    const session = sessionApi(client);
    return (
        typeof session?.promptAsync === "function" &&
        typeof session?.status === "function" &&
        typeof session?.messages === "function"
    );
}

/**
 * Build a retry-chain transport that sends with `prompt_async` and waits for the
 * child to go idle. Returns undefined for a client without those endpoints, so
 * the caller falls back to the synchronous prompt.
 */
export function createPromptAsyncTransport(
    client: Client,
    childSessionId: string,
    options: PromptAsyncWaitOptions = {},
): PromptTransport | undefined {
    if (!supportsPromptAsync(client)) return undefined;
    return Object.assign(
        (request: PromptArgs) => promptAsyncAndWaitForIdle(client, request, options),
        { childSessionId },
    );
}

type MessageInfo = {
    id?: unknown;
    role?: unknown;
    time?: { completed?: unknown };
    finish?: unknown;
    error?: unknown;
};

function infoOf(message: unknown): MessageInfo {
    const info = (message as { info?: unknown } | null)?.info;
    return info && typeof info === "object" ? (info as MessageInfo) : {};
}

function messageId(message: unknown): string | null {
    const id = infoOf(message).id;
    return typeof id === "string" ? id : null;
}

/** An assistant message the host has finished writing, successfully or not. */
function isSettledAssistant(message: unknown): boolean {
    const info = infoOf(message);
    if (info.role !== "assistant") return false;
    return info.time?.completed != null || info.error != null || info.finish != null;
}

function unwrapData(response: unknown): unknown {
    if (response && typeof response === "object" && "data" in response) {
        return (response as { data?: unknown }).data;
    }
    return response;
}

function describeRejection(error: unknown): string {
    if (error instanceof Error) return error.message;
    try {
        return JSON.stringify(error);
    } catch {
        return String(error);
    }
}

function abortError(signal: AbortSignal): unknown {
    return signal.reason ?? new Error("prompt_async wait aborted");
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(abortError(signal));
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            reject(abortError(signal as AbortSignal));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

async function readMessages(
    session: SessionApi,
    sessionId: string,
    directory: string | undefined,
    signal: AbortSignal | undefined,
): Promise<unknown[]> {
    const response = await session.messages?.({
        path: { id: sessionId },
        ...(directory ? { query: { directory } } : {}),
        ...(signal ? { signal } : {}),
    });
    const data = unwrapData(response);
    return Array.isArray(data) ? data : [];
}

/** "busy"/"retry" while the loop runs, "idle" when absent or idle, null when unreadable. */
async function readStatus(
    session: SessionApi,
    sessionId: string,
    directory: string | undefined,
    signal: AbortSignal | undefined,
): Promise<string | null> {
    try {
        const response = await session.status?.({
            ...(directory ? { query: { directory } } : {}),
            ...(signal ? { signal } : {}),
        });
        if (response && typeof response === "object" && "error" in response) {
            if ((response as { error?: unknown }).error) return null;
        }
        const data = unwrapData(response);
        if (!data || typeof data !== "object") return null;
        const entry = (data as Record<string, unknown>)[sessionId];
        const type = (entry as { type?: unknown } | undefined)?.type;
        return typeof type === "string" ? type : "idle";
    } catch (error) {
        if (signal?.aborted) throw error;
        return null;
    }
}

/**
 * Send one prompt with `prompt_async`, then poll until the child session is idle
 * and its newest message is a finished assistant reply from this send. Returns
 * without judging that reply: the caller's output validation reads it. Rejects
 * when the caller's signal aborts, and when the host accepted the send but never
 * started a run within the start grace.
 */
export async function promptAsyncAndWaitForIdle(
    client: Client,
    request: PromptArgs,
    options: PromptAsyncWaitOptions = {},
): Promise<void> {
    const session = sessionApi(client);
    if (!session || !supportsPromptAsync(client)) {
        throw new Error("prompt_async transport is unavailable on this client");
    }
    const sessionId = request.path.id;
    const directory = (request.query as { directory?: unknown } | undefined)?.directory;
    const dir = typeof directory === "string" ? directory : undefined;
    const signal = request.signal;
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const startGraceMs = options.startGraceMs ?? DEFAULT_START_GRACE_MS;

    // A fallback attempt reuses the child session, so an earlier attempt's final
    // reply must not be mistaken for this send's reply.
    const baseline = new Set(
        (await readMessages(session, sessionId, dir, signal))
            .map(messageId)
            .filter((id): id is string => id !== null),
    );

    const sent = await session.promptAsync?.(request);
    if (sent && typeof sent === "object" && "error" in sent) {
        const rejection = (sent as { error?: unknown }).error;
        if (rejection) throw new Error(`prompt_async was rejected: ${describeRejection(rejection)}`);
    }
    const sentAt = Date.now();
    let sawBusy = false;

    for (;;) {
        await sleep(pollIntervalMs, signal);
        const status = await readStatus(session, sessionId, dir, signal);
        if (status === "busy" || status === "retry") {
            sawBusy = true;
            continue;
        }
        // An unreadable status says nothing about the run; keep waiting under the
        // caller's timer rather than guessing.
        if (status === null) continue;

        const messages = await readMessages(session, sessionId, dir, signal);
        const last = messages.at(-1);
        const lastId = messageId(last);
        if (last && lastId !== null && !baseline.has(lastId) && isSettledAssistant(last)) return;

        const fresh = messages.some((message) => {
            const id = messageId(message);
            return id !== null && !baseline.has(id);
        });
        // The loop ran and ended without a final reply (for example it failed
        // before writing one). Output validation reports what is missing.
        if (sawBusy && fresh) return;
        if (Date.now() - sentAt >= startGraceMs) {
            if (fresh) return;
            throw new Error(
                `prompt_async did not start a run in child session ${sessionId} within ${startGraceMs}ms`,
            );
        }
    }
}
