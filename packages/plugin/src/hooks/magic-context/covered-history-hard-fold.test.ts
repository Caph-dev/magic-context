import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Scheduler } from "../../features/magic-context/scheduler";
import {
    closeDatabase,
    getOrCreateSessionMeta,
    openDatabase,
} from "../../features/magic-context/storage";
import { createTagger } from "../../features/magic-context/tagger";
import { createTransform } from "./transform";

type WireMessage = {
    info: {
        id: string;
        role: string;
        sessionID: string;
        providerID?: string;
        modelID?: string;
        model?: { providerID: string; modelID: string };
    };
    parts: Array<Record<string, unknown>>;
};
const SID = "ses-covered-fold";
let priorHome: string | undefined;
let home: string;
beforeEach(() => {
    priorHome = process.env.XDG_DATA_HOME;
    home = mkdtempSync(join(tmpdir(), "mc-covered-hard-"));
    process.env.XDG_DATA_HOME = home;
    mkdirSync(join(home, "cortexkit", "magic-context"), { recursive: true });
    closeDatabase();
});
afterEach(() => {
    closeDatabase();
    if (priorHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = priorHome;
    rmSync(home, { recursive: true, force: true });
});

const m = (id: string, role: string, text: string, model: string): WireMessage => ({
    info: {
        id,
        role,
        sessionID: SID,
        ...(role === "user"
            ? { model: { providerID: "anthropic", modelID: model } }
            : { providerID: "anthropic", modelID: model }),
    },
    parts: [{ type: "text", text }],
});

for (const model of ["claude-opus-5-5", "claude-fable-5-1"]) {
    describe(`covered history first hard fold on ${model}`, () => {
        test("rebuilds both prefix messages, strips signed thinking, and replays the shared prefix after append", async () => {
            const db = openDatabase();
            for (const [sequence, start, end, content] of [
                [1, "old-1", "old-2", "REACHABLE-OLD-01"],
                [2, "old-4", "old-5", "UNDONE-OLD-02"],
            ] as const) {
                db.prepare(`INSERT INTO compartments (session_id, sequence, start_message, end_message,
                    start_message_id, end_message_id, title, content, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, 'summary', ?, 1)`).run(
                    SID,
                    sequence,
                    sequence * 2 - 1,
                    sequence * 2,
                    start,
                    end,
                    content,
                );
            }
            getOrCreateSessionMeta(db, SID);
            db.prepare(
                "UPDATE session_meta SET cached_m0_bytes = ?, cached_m1_bytes = ? WHERE session_id = ?",
            ).run(Buffer.from("frozen old m0"), Buffer.from("frozen old m1"), SID);
            const scheduler: Scheduler = { shouldExecute: () => "defer" };
            const transform = createTransform({
                db,
                tagger: createTagger(),
                scheduler,
                directory: home,
                liveModelBySession: new Map([[SID, { providerID: "anthropic", modelID: model }]]),
                contextUsageMap: new Map(),
                historyRefreshSessions: new Set(),
                pendingMaterializationSessions: new Set(),
                lastHeuristicsTurnId: new Map(),
                clearReasoningAge: 50,
                protectedTokens: 0,
                memoryConfig: { enabled: false, injectionBudgetTokens: 500, autoPromote: false },
            });
            const branch = () => {
                const messages = [
                    m("old-1", "user", "original question", model),
                    m("old-2", "assistant", "old answer", model),
                    m("old-3", "assistant", "still reachable", model),
                    m("new-1", "user", "NEW-01", model),
                ];
                messages[2].parts.unshift({
                    type: "thinking",
                    thinking: "signed thought",
                    signature: "sig-old-3",
                });
                return messages;
            };
            const first = branch();
            await transform({}, { messages: first });
            const stored = db
                .prepare(
                    "SELECT cached_m0_bytes, cached_m1_bytes FROM session_meta WHERE session_id = ?",
                )
                .get(SID) as { cached_m0_bytes: Buffer | null; cached_m1_bytes: Buffer | null };
            expect(
                db.prepare("SELECT sequence FROM compartments WHERE session_id = ?").all(SID),
            ).toEqual([{ sequence: 1 }]);
            expect(stored.cached_m0_bytes?.length).toBeGreaterThan(0);
            expect(stored.cached_m1_bytes?.length).toBeGreaterThan(0);
            expect(stored.cached_m0_bytes?.toString()).not.toBe("frozen old m0");
            expect(stored.cached_m1_bytes?.toString()).not.toBe("frozen old m1");
            const firstWire = JSON.stringify(first);
            expect(firstWire).toContain("REACHABLE-OLD-01");
            expect(firstWire).not.toContain("UNDONE-OLD-02");
            expect(firstWire).not.toContain("signed thought");
            expect(firstWire).not.toContain("sig-old-3");
            const replay = [...branch(), m("new-2", "user", "NEW-02", model)];
            await transform({}, { messages: replay });
            expect(JSON.stringify(replay.slice(0, first.length))).toBe(firstWire);
        });
    });
}

test("priced pass followed by append/defer retains the normal shared wire prefix", async () => {
    const db = openDatabase();
    let pass = 0;
    const scheduler: Scheduler = { shouldExecute: () => (++pass === 1 ? "execute" : "defer") };
    const model = "claude-opus-5-5";
    const transform = createTransform({
        db,
        tagger: createTagger(),
        scheduler,
        directory: home,
        liveModelBySession: new Map([[SID, { providerID: "anthropic", modelID: model }]]),
        contextUsageMap: new Map(),
        historyRefreshSessions: new Set(),
        pendingMaterializationSessions: new Set(),
        lastHeuristicsTurnId: new Map(),
        clearReasoningAge: 50,
        protectedTokens: 0,
        memoryConfig: { enabled: false, injectionBudgetTokens: 500, autoPromote: false },
    });
    const first = [m("user-1", "user", "NEW-01", model)];
    await transform({}, { messages: first });
    const prefix = JSON.stringify(first);
    const defer = [m("user-1", "user", "NEW-01", model), m("user-2", "user", "NEW-02", model)];
    await transform({}, { messages: defer });
    expect(pass).toBe(2);
    expect(JSON.stringify(defer.slice(0, first.length))).toBe(prefix);
});
