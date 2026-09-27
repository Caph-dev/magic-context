/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { RustTestHarness } from "../src/rust-harness";
import { rustPrereqs } from "../src/rust-scenario-support";

interface SqliteRow {
    id: string;
    message_id?: string;
    session_id: string;
    time_created: number;
    time_updated: number;
    data: string;
}

function sha256(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

describe.skipIf(!rustPrereqs.ok)("rust invariant: compaction marker byte identity", () => {
    let h: RustTestHarness;

    beforeEach(async () => {
        h = await RustTestHarness.create({
            modelContextLimit: 30_000,
            // The historian gets its own 128k mock model: the 30k session window
            // builds pressure quickly but cannot hold a historian prompt.
            historianModelContextLimit: 128_000,
            magicContextConfig: {
                execute_threshold_percentage: 25,
                protected_tags: 1,
                compressor: { enabled: false },
            },
        });
    });

    afterEach(async () => {
        await h?.dispose();
    });

    it(
        "serves identical serialized arrays with the marker applied and deliberately absent",
        async () => {
            const sessionId = await h.createSession();
            const opencodeDb = new Database(join(h.env.dataDir, "opencode", "opencode.db"));
            // The harness's OpenCode server writes this database concurrently; bun:sqlite
            // defaults to no busy wait, so the marker deletes below would fail on the
            // first overlapping host write (seen as SQLITE_BUSY in release run r2).
            opencodeDb.exec("PRAGMA busy_timeout = 30000");

            for (let turn = 1; turn <= 20; turn += 1) {
                h.mock.setDefault({
                    text: `fold reply ${turn}`,
                    usage: {
                        input_tokens: 3_000 * turn,
                        output_tokens: 20,
                        cache_creation_input_tokens: 2_000,
                    },
                });
                await h.sendPrompt(sessionId, `marker fold turn ${turn}: ${h.ballast(6_000)}`);
                const markerCount = (
                    opencodeDb
                        .prepare(
                            `SELECT COUNT(*) AS count
                               FROM part
                              WHERE session_id = ?
                                AND json_extract(data, '$.type') = 'compaction'
                                AND json_extract(data, '$.auto') = 1`,
                        )
                        .get(sessionId) as { count: number }
                ).count;
                if (
                    markerCount > 0 ||
                    h.readRustPasses().some((pass) => pass.reason === "coverage_fold")
                ) {
                    break;
                }
                await Bun.sleep(200);
            }

            const summaryRows = opencodeDb
                .prepare(
                    `SELECT * FROM message
                      WHERE session_id = ?
                        AND json_extract(data, '$.summary') = 1
                        AND json_extract(data, '$.providerID') = 'magic-context'`,
                )
                .all(sessionId) as SqliteRow[];
            const compactionRows = opencodeDb
                .prepare(
                    `SELECT * FROM part
                      WHERE session_id = ?
                        AND json_extract(data, '$.type') = 'compaction'
                        AND json_extract(data, '$.auto') = 1`,
                )
                .all(sessionId) as SqliteRow[];
            if (summaryRows.length !== 1 || compactionRows.length !== 1) {
                const pluginLog = await Bun.file(h.logPath).text();
                throw new Error(
                    `expected one applied marker; summary=${summaryRows.length} compaction=${compactionRows.length}\n` +
                        `rust passes=${JSON.stringify(h.readRustPasses())}\n` +
                        `marker logs=${pluginLog
                            .split("\n")
                            .filter((line) => line.includes("compaction-marker"))
                            .join("\n")}\n` +
                        `module log tail=${h.subc.moduleLog().slice(-8_000)}`,
                );
            }
            const summaryPartRows = opencodeDb
                .prepare("SELECT * FROM part WHERE session_id = ? AND message_id = ?")
                .all(sessionId, summaryRows[0]!.id) as SqliteRow[];

            // For the baseline run, temporarily remove OpenCode's compaction-marker and summary
            // rows so the host supplies no marker. Restore them before the restart comparison
            // while leaving the module's durable fold unchanged.
            opencodeDb.transaction(() => {
                for (const row of [...compactionRows, ...summaryPartRows]) {
                    opencodeDb.prepare("DELETE FROM part WHERE id = ?").run(row.id);
                }
                opencodeDb.prepare("DELETE FROM message WHERE id = ?").run(summaryRows[0]!.id);
            })();

            const probe = "byte identity marker probe";
            const probeMessageId = "msg_01MKRBYT3ID3NT1TYPR0BE0000";
            await Bun.sleep(700);
            const controlPassesBefore = h.readRustPasses().length;
            await h.sendPrompt(sessionId, probe, { messageID: probeMessageId });
            const controlPasses = await h.waitForRustPasses(controlPassesBefore + 1);
            const controlInput = controlPasses.at(-1)!.inputCount;
            const controlSerialized = h.lastMainWireSerialized();
            const controlHash = sha256(controlSerialized);
            const controlProbe = (await h.listMessages(sessionId))
                .filter(
                    (message) =>
                        message.info?.role === "user" &&
                        message.parts?.some((part) => part.type === "text" && part.text === probe),
                )
                .at(-1)?.info?.id;
            expect(controlProbe).toBe(probeMessageId);
            await h.revertMessage(sessionId, controlProbe!);

            opencodeDb.transaction(() => {
                for (const row of summaryRows) {
                    opencodeDb
                        .prepare(
                            "INSERT OR REPLACE INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
                        )
                        .run(row.id, row.session_id, row.time_created, row.time_updated, row.data);
                }
                for (const row of [...compactionRows, ...summaryPartRows]) {
                    opencodeDb
                        .prepare(
                            "INSERT OR REPLACE INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
                        )
                        .run(
                            row.id,
                            row.message_id!,
                            row.session_id,
                            row.time_created,
                            row.time_updated,
                            row.data,
                        );
                }
            })();

            await h.subc.restartModule();
            await Bun.sleep(700);
            const markerPassesBefore = h.readRustPasses().length;
            await h.sendPrompt(sessionId, probe, { messageID: probeMessageId });
            const markerPasses = await h.waitForRustPasses(markerPassesBefore + 1);
            const markerInput = markerPasses.at(-1)!.inputCount;
            const markerSerialized = h.lastMainWireSerialized();
            const markerHash = sha256(markerSerialized);
            const markerProbe = (await h.listMessages(sessionId))
                .filter(
                    (message) =>
                        message.info?.role === "user" &&
                        message.parts?.some((part) => part.type === "text" && part.text === probe),
                )
                .at(-1)?.info?.id;
            expect(markerProbe).toBe(probeMessageId);
            await h.revertMessage(sessionId, markerProbe!);

            const replayPassesBefore = h.readRustPasses().length;
            await h.sendPrompt(sessionId, probe, { messageID: probeMessageId });
            const replayPasses = await h.waitForRustPasses(replayPassesBefore + 1);
            const replaySerialized = h.lastMainWireSerialized();
            const replayHash = sha256(replaySerialized);

            console.log(`rust marker byte identity control sha256=${controlHash}`);
            console.log(`rust marker byte identity post-restart-1 sha256=${markerHash}`);
            console.log(`rust marker byte identity post-restart-2 sha256=${replayHash}`);
            expect(controlInput).toBeGreaterThan(markerInput);
            expect(replayPasses.at(-1)!.inputCount).toBe(markerInput);
            if (controlHash !== markerHash || markerHash !== replayHash) {
                const firstDifference =
                    controlHash !== markerHash
                        ? [...controlSerialized].findIndex(
                              (character, index) => character !== markerSerialized[index],
                          )
                        : [...markerSerialized].findIndex(
                              (character, index) => character !== replaySerialized[index],
                          );
                throw new Error(
                    `wire bytes diverged at ${firstDifference}: ` +
                        `control=${JSON.stringify(controlSerialized.slice(firstDifference, firstDifference + 500))} ` +
                        `postRestart1=${JSON.stringify(markerSerialized.slice(firstDifference, firstDifference + 500))} ` +
                        `postRestart2=${JSON.stringify(replaySerialized.slice(firstDifference, firstDifference + 500))}`,
                );
            }
            opencodeDb.close();
        },
        300_000,
    );
});
