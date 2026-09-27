import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import { DREAMER_REVIEWER_AGENT } from "../../../agents/dreamer";
import { _resetKeepSubagentsForTesting, setKeepSubagents } from "../../../shared/keep-subagents";
import * as logger from "../../../shared/logger";
import { Database } from "../../../shared/sqlite";
import { acquireLease } from "../dreamer/lease";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { reviewUserMemories } from "./review-user-memories";
import { insertUserMemoryCandidates } from "./storage-user-memory";

function freshDb(leaseKey: string): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    expect(acquireLease(db, "holder", leaseKey)).toBe(true);
    return db;
}

afterEach(() => {
    _resetKeepSubagentsForTesting();
    mock.restore();
});

describe("reviewUserMemories", () => {
    test("archives but does not delete an unsettled child and logs its sweep handoff", async () => {
        const db = freshDb("review-user-memories");
        insertUserMemoryCandidates(db, [
            { content: "User prefers concise updates", sessionId: "s1" },
        ]);
        const deleted: string[] = [];
        const archived: unknown[] = [];
        const logSpy = spyOn(logger, "log").mockImplementation(() => {});
        const prompt = mock(async () => {
            throw new Error("model unavailable");
        });
        const client = {
            session: {
                create: mock(async () => ({ id: "child-user-memories" })),
                prompt,
                update: mock(async (input: unknown) => {
                    archived.push(input);
                    return {};
                }),
                delete: mock(async ({ path }: { path: { id: string } }) => {
                    deleted.push(path.id);
                    return {};
                }),
            },
        } as never;

        await expect(
            reviewUserMemories({
                db,
                client,
                parentSessionId: undefined,
                sessionDirectory: "/repo/project",
                holderId: "holder",
                leaseKey: "review-user-memories",
                deadline: Date.now() + 60_000,
                promotionThreshold: 1,
            }),
        ).rejects.toThrow("model unavailable");

        expect(
            prompt.mock.calls.some(([input]) => {
                const body = (input as { body?: { agent?: string } }).body;
                return body?.agent === DREAMER_REVIEWER_AGENT;
            }),
        ).toBe(true);
        expect(deleted).toEqual([]);
        expect(archived).toEqual([
            {
                path: { id: "child-user-memories" },
                query: { directory: "/repo/project" },
                body: { time: { archived: expect.any(Number) } },
            },
        ]);
        expect(
            logSpy.mock.calls.some(
                ([message]) =>
                    message ===
                    "[dreamer] user-memories: prompt unsettled — session child-user-memories left to the age-gated sweep",
            ),
        ).toBe(true);
        db.close();
    });

    test("keeps a settled privacy child because keep_subagents covers the privacy class", async () => {
        setKeepSubagents(true);
        const db = freshDb("review-user-memories-settled");
        insertUserMemoryCandidates(db, [
            { content: "User prefers concise updates", sessionId: "s1" },
        ]);
        const deleted: string[] = [];
        const client = {
            session: {
                create: mock(async () => ({ id: "settled-user-memories" })),
                prompt: mock(async () => ({})),
                messages: mock(async () => ({
                    data: [
                        {
                            info: { role: "assistant", time: { created: Date.now() } },
                            parts: [
                                {
                                    type: "text",
                                    text: '{"promote":[],"update_existing":[],"dismiss_existing":[],"consume_candidate_ids":[1]}',
                                },
                            ],
                        },
                    ],
                })),
                update: mock(async () => ({})),
                delete: mock(async ({ path }: { path: { id: string } }) => {
                    deleted.push(path.id);
                    return {};
                }),
            },
        };

        await reviewUserMemories({
            db,
            client: client as never,
            parentSessionId: undefined,
            sessionDirectory: "/repo/project",
            holderId: "holder",
            leaseKey: "review-user-memories-settled",
            deadline: Date.now() + 60_000,
            promotionThreshold: 1,
        });

        expect(deleted).toEqual([]);
        expect(client.session.update).not.toHaveBeenCalled();
        db.close();
    });
});
