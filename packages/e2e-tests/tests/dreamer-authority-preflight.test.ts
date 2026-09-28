/// <reference types="bun-types" />

import { afterAll, beforeAll, expect, it } from "bun:test";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { installAuthorityManagedMarker } from "../../plugin/src/features/magic-context/context-authority";
import { insertMemory } from "../../plugin/src/features/magic-context/memory";
import { resolveProjectIdentity } from "../../plugin/src/features/magic-context/memory/project-identity";
import { openDatabase } from "../../plugin/src/features/magic-context/storage";
import { closeQuietly } from "../../plugin/src/shared/sqlite-helpers";
import { createScenarioHarness, forEachHost, type ScenarioHarness } from "../src/scenario-hosts";
import { openTestDb } from "../src/test-db";

let h: ScenarioHarness;
const task = "classify-memories";

forEachHost(import.meta.url, "module-managed classify on a TypeScript OpenCode host", () => {
    beforeAll(async () => {
        h = await createScenarioHarness("opencode", {
            magicContextConfig: { dreamer: { disable: false, tasks: { [task]: { schedule: "0 3 * * *" } } } },
        });
    });
    afterAll(async () => { await h.dispose(); });

    it("advances the schedule without making a classify prompt or recording an error", async () => {
        h.mock.setDefault({ text: "ack", usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 0 } });
        const session = await h.createSession();
        await h.sendPrompt(session, "bootstrap dreamer");
        await h.waitFor(() => h.hasContextDb(), { label: "context store" });
        const project = resolveProjectIdentity(realpathSync(resolve(h.workdir)));
        const db = openDatabase({ dbPath: h.contextDbPath() });
        if (!db) throw new Error("throwaway context store unavailable");
        try {
            for (let i = 0; i < 10; i++) insertMemory(db, { projectPath: project, category: "ARCHITECTURE", content: `Authority fixture ${i}` });
            installAuthorityManagedMarker(db, project);
        } finally { closeQuietly(db); }
        const before = h.requests().length;
        const response = await fetch(`${h.serverUrl}/session/${session}/command`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ messageID: `msg_${crypto.randomUUID().replaceAll("-", "")}`, command: "ctx-dream", arguments: task, agent: "build", model: "mock-anthropic/mock-sonnet", parts: [] }),
        });
        expect(response.status).toBe(204);
        expect(h.requests()).toHaveLength(before);
        const store = openTestDb(h.contextDbPath());
        try {
            expect((store.prepare("SELECT count(*) AS n FROM dream_runs WHERE project_path=?").get(project) as { n: number }).n).toBe(0);
            const schedule = store.prepare("SELECT last_status, last_error, next_due_at FROM task_schedule_state WHERE project_path=? AND task=?").get(project, task) as { last_status: string; last_error: string | null; next_due_at: number };
            expect(schedule.last_status).toBe("completed");
            expect(schedule.last_error).toBeNull();
            expect(schedule.next_due_at).toBeGreaterThan(Date.now());
        } finally { store.close(); }
    }, 300_000);
});
