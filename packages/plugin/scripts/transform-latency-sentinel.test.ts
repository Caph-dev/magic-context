import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readNewLines, runLatencySentinel } from "./transform-latency-sentinel";

const BASE = Date.parse("2026-09-28T18:00:00Z");
let root: string;
let path: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "latency-sentinel-")); path = join(root, "log"); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
const line = (id: string, second: number, elapsed: number, module?: number) =>
    `[${new Date(BASE + second * 1000).toISOString()}] [magic-context][${id}] ${module === undefined ? `transform completed in ${elapsed}ms` : `rust pass: decision=SOFT+ served_from=transform elapsed=${elapsed} ms module=${module} ms`}\n`;
async function run(now = BASE + 100_000) {
    return runLatencySentinel({ files: [path], stateFile: join(root, "state.json"), db: join(root, "absent.db"), connectionFile: "", send: false, now: () => now, load: () => [1, 2, 3], stdout: () => {}, stderr: () => {} });
}
test("fixture positives fire for each event kind and quiet session does not", async () => {
    writeFileSync(path, readFileSync(join(import.meta.dir, "fixtures/transform-latency.txt")));
    const result = await run();
    expect(result.alerts.map((a) => `${a.sessionId}:${a.kind}`).sort()).toEqual([
        "ses_park:park", "ses_refused2:refusal", "ses_refused3:refusal", "ses_refused:refusal",
        "ses_slow:single", "ses_timeout2:timeout", "ses_timeout3:timeout", "ses_timeout:timeout",
    ].sort());
    expect(result.alerts[0]).toMatchObject({ p50: 13000, p90: 13000, max: 13000, moduleP50: 3000, pluginP50: 10000, load: [1, 2, 3] });
    expect((await run()).alerts).toHaveLength(0);
});
test("p90 over ten passes, module climb over twenty, and quiet controls", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 20; i++) {
        lines.push(line("ses_climb", i, 30 + i * 180, 8 + i * 160));
        lines.push(line("ses_quiet", i, 50, 10));
        if (i < 10) lines.push(line("ses_p90", i, i < 2 ? 7000 : 100, 10));
    }
    writeFileSync(path, lines.join(""));
    const result = await run();
    expect(result.alerts.some((a) => a.sessionId === "ses_p90" && a.kind === "p90")).toBe(true);
    expect(result.alerts.some((a) => a.sessionId === "ses_climb" && a.kind === "module_climb")).toBe(true);
    expect(result.alerts.some((a) => a.sessionId === "ses_quiet")).toBe(false);
});
test("watermark resumes partial lines, handles rotation and re-alerts only at 50% or six hours", async () => {
    writeFileSync(path, line("ses_slow", 0, 13000).trimEnd());
    expect((await run()).alerts).toHaveLength(0);
    appendFileSync(path, "\n");
    expect((await run()).alerts.map((a) => a.kind)).toEqual(["single"]);
    appendFileSync(path, line("ses_slow", 1, 14000));
    expect((await run()).alerts).toHaveLength(0);
    appendFileSync(path, line("ses_slow", 2, 20000));
    expect((await run()).alerts.map((a) => a.kind)).toEqual(["single"]);
    renameSync(path, join(root, "old-log"));
    writeFileSync(path, line("ses_new", 3, 13000));
    expect((await run()).alerts.map((a) => a.sessionId)).toEqual(["ses_new"]);
    appendFileSync(path, line("ses_slow", 7 * 3600, 13000));
    expect((await run(BASE + 8 * 3600_000)).alerts.map((a) => a.sessionId)).toEqual(["ses_slow"]);
});
test("scan is byte bounded and resumes without re-reading earlier events", async () => {
    writeFileSync(path, line("ses_first", 0, 13000) + line("ses_second", 1, 13000));
    const first = await runLatencySentinel({ files: [path], stateFile: join(root, "state.json"), db: "", connectionFile: "", send: false, now: () => BASE + 100_000, load: () => [0, 0, 0], stdout: () => {}, stderr: () => {}, replay: true });
    expect(first.alerts.map((a) => a.sessionId)).toEqual(["ses_first", "ses_second"]);
    expect(first.files[path].offset).toBeGreaterThan(0);
    const fragment = readNewLines(path, undefined, Buffer.byteLength(line("ses_first", 0, 13000)) + 5);
    expect(fragment.lines).toHaveLength(1);
    expect(readNewLines(path, fragment.cursor).lines).toHaveLength(1);
});
test("peer roster name takes precedence over project binding", async () => {
    writeFileSync(path, line("ses_slow", 0, 13000));
    const project = new Database(join(root, "context.db"));
    project.exec("CREATE TABLE session_projects(session_id TEXT, project_path TEXT)");
    project.query("INSERT INTO session_projects VALUES (?, ?)").run("ses_slow", "git:example");
    project.close(false);
    const roster = new Database(join(root, "peers.db"));
    roster.exec("CREATE TABLE agent(name TEXT, residence_address_json TEXT, terminal_reason TEXT); CREATE TABLE peers(name TEXT, session_id TEXT, added_at INTEGER)");
    roster.query("INSERT INTO peers VALUES (?, ?, ?)").run("CEREB", "ses_slow", 1);
    roster.close(false);
    const result = await runLatencySentinel({ files: [path], stateFile: join(root, "state.json"), db: join(root, "context.db"), peerDb: join(root, "peers.db"), connectionFile: "", send: false, now: () => BASE + 100_000, load: () => [0, 0, 0], stdout: () => {}, stderr: () => {} });
    expect(result.alerts[0]?.name).toBe("CEREB");
});
