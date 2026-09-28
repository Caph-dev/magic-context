/// <reference types="bun-types" />

import { describe, expect, mock, test } from "bun:test";

import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createV1HiddenCompletionExecutor } from "./compartment-runner-historian";
import type { HiddenRunIdentity } from "./compartment-runner-types";

function freshDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

/** A host whose child finishes on the first status poll after a prompt_async send. */
function host() {
    const messages: unknown[] = [];
    const promptAsync = mock(async () => {
        messages.push(
            { info: { id: "msg_user", role: "user", time: { created: 1 } }, parts: [] },
            {
                info: {
                    id: "msg_final",
                    role: "assistant",
                    time: { created: 2, completed: 3 },
                    finish: "stop",
                },
                parts: [{ type: "text", text: "<classify/>" }],
            },
        );
        return { data: undefined };
    });
    const prompt = mock(async () => ({}));
    return {
        client: {
            session: {
                create: async () => ({ data: { id: "ses-child" } }),
                promptAsync,
                prompt,
                status: async () => ({ data: {} }),
                messages: async () => ({ data: [...messages] }),
                delete: async () => ({}),
            },
        } as never,
        promptAsync,
        prompt,
    };
}

function run(kind: HiddenRunIdentity["kind"]): HiddenRunIdentity {
    return {
        agent: "dreamer-classifier",
        kind,
        system: "system",
        timeoutMs: 60_000,
        title: "child",
        directory: "/repo",
    };
}

const request = {
    path: { id: "ses-child" },
    query: { directory: "/repo" },
    body: { parts: [{ type: "text", text: "go" }] },
};

describe("OpenCode 1 hidden executor transport", () => {
    test("a dreamer task child sends with prompt_async instead of a held request", async () => {
        const db = freshDb();
        try {
            const h = host();
            const executor = createV1HiddenCompletionExecutor(h.client, db, "/repo");
            const handle = await executor.open(run("dreamer-task"));

            await executor.attempt(handle, request);

            expect(h.promptAsync).toHaveBeenCalledTimes(1);
            expect(h.prompt).not.toHaveBeenCalled();
        } finally {
            closeQuietly(db);
        }
    });

    test("a historian child keeps the synchronous prompt", async () => {
        const db = freshDb();
        try {
            const h = host();
            const executor = createV1HiddenCompletionExecutor(h.client, db, "/repo");
            const handle = await executor.open(run("historian"));

            await executor.attempt(handle, request);

            expect(h.prompt).toHaveBeenCalledTimes(1);
            expect(h.promptAsync).not.toHaveBeenCalled();
        } finally {
            closeQuietly(db);
        }
    });
});
