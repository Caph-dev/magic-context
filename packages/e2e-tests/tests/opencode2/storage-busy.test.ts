import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { STORAGE_BUSY_MESSAGE } from "../../../plugin/src/hooks/magic-context/storage-busy-refusal";
import { CLI, assertOpenPaths, isolation, spawnOpencode2, waitForPluginActive } from "../../src/opencode2-runner/spawn";

for (const seconds of [7, 60]) {
    test(`OpenCode 2 real write lock ${seconds}s ${seconds === 7 ? "retries successfully" : "refuses visibly without raw provider request"}`, async () => {
        const fixture = isolation();
        const version = spawnSync(CLI, ["--version"], { env: fixture.env, cwd: fixture.cwd, encoding: "utf8" });
        expect(version.status).toBe(0);
        console.info(`storage-busy CLI=${CLI} version=${version.stdout.trim()}`);
        const logPath = join(fixture.root, "magic-context.log");
        fixture.env.MAGIC_CONTEXT_LOG_PATH = logPath;
        const probe = join(fixture.root, "busy-probe");
        mkdirSync(probe);
        const ready = join(fixture.root, "context-ready");
        const locked = join(fixture.root, "lock-ready");
        // Start contention at the context boundary, not in unrelated session-created writers.
        writeFileSync(join(probe, "server.js"), `
            import mc from ${JSON.stringify(new URL("../../../plugin/dist/v2/server.js", import.meta.url).pathname)};
            import { existsSync, writeFileSync } from 'node:fs';
            export default { id: 'opencode-magic-context', async setup(context) {
                let armed = true;
                const session = new Proxy(context.session, { get(target, key) {
                    if (key !== 'hook') return Reflect.get(target, key);
                    return (name, callback) => target.hook(name, async draft => {
                        if (name === 'context' && armed && callback.toString().includes('rememberHostMedia')) {
                            armed = false;
                            writeFileSync(${JSON.stringify(ready)}, 'ready');
                            while (!existsSync(${JSON.stringify(locked)})) await new Promise(resolve => setTimeout(resolve, 20));
                        }
                        return callback(draft);
                    });
                }});
                return mc.setup(new Proxy(context, { get(target, key) { return key === 'session' ? session : Reflect.get(target, key); } }));
            }};
        `);
        const host = await spawnOpencode2({ existingIsolation: fixture, includeMagicContext: false, probePlugin: probe, magicContextConfig: {
            dreamer: { disable: true }, memory: { enabled: false }, historian: { disable: true },
        } });
        let locker: ReturnType<typeof Bun.spawn> | undefined;
        try {
            const client = OpenCode.make({ baseUrl: host.url, headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` } });
            const session = await client.session.create({ location: { directory: host.cwd }, model: { providerID: "openai", id: "mock-model" } });
            await waitForPluginActive(client, host.cwd);
            const text = `STORAGE-BUSY-${seconds}-SECONDS`;
            const prompt = client.session.prompt({ sessionID: session.id, text });
            const readyDeadline = Date.now() + 15000;
            while (!existsSync(ready) && Date.now() < readyDeadline) await Bun.sleep(20);
            expect(existsSync(ready)).toBe(true);
            const dbPath = join(fixture.env.MAGIC_CONTEXT_STORAGE_DIR!, "context.db");
            locker = Bun.spawn(["python3", "-u", "-c", "import sqlite3,sys,time; db=sqlite3.connect(sys.argv[1]); db.execute('BEGIN IMMEDIATE'); print('locked',flush=True); time.sleep(float(sys.argv[2])); db.rollback()", dbPath, String(seconds)], { env: fixture.env, stdout: "pipe", stderr: "pipe" });
            const reader = (locker.stdout as ReadableStream<Uint8Array>).getReader();
            expect(new TextDecoder().decode((await reader.read()).value)).toContain("locked");
            reader.releaseLock();
            const descriptors = spawnSync("lsof", ["-p", String(locker.pid), "-Fn"], { encoding: "utf8" });
            expect(descriptors.status).toBe(0);
            const paths = descriptors.stdout.split("\n").filter(line => line.startsWith("n")).map(line => line.slice(1));
            assertOpenPaths(paths, fixture.root);
            expect(paths).toContain(dbPath);
            console.info(`storage-busy host=${host.pid} locker=${locker.pid} root=${fixture.root} lsof_context_db=${dbPath}`);
            expect(locker.exitCode).toBeNull();
            const started = Date.now();
            writeFileSync(locked, "locked");
            await prompt;
            await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(80000) });
            const requests = () => host.mock.requests().filter(request => request.body.model === "mock-model" && JSON.stringify(request).includes(text));
            if (seconds === 7) {
                expect(requests().length).toBeGreaterThan(0);
                expect(Date.now() - started).toBeGreaterThan(5000);
            } else {
                expect(requests()).toHaveLength(0);
                const rows = () => {
                    const db = new Database(join(fixture.env.XDG_DATA_HOME!, "opencode", fixture.env.OPENCODE_DB!), { readonly: true });
                    try { return db.prepare("SELECT type,data FROM session_message WHERE session_id=? ORDER BY seq").all(session.id) as {type: string; data: string}[]; }
                    finally { db.close(); }
                };
                const deadline = Date.now() + 10000;
                while (!rows().some(row => row.type === "synthetic" && row.data.includes(STORAGE_BUSY_MESSAGE)) && Date.now() < deadline) await Bun.sleep(100);
                expect(rows().some(row => row.type === "synthetic" && row.data.includes(STORAGE_BUSY_MESSAGE))).toBe(true);
                expect(rows().some(row => row.type === "idle" && row.data.includes("interrupted"))).toBe(true);
                await locker.exited;
                const logDeadline = Date.now() + 10000;
                while (!readFileSync(logPath, "utf8").includes("storage-busy refusal stage=") && Date.now() < logDeadline) await Bun.sleep(100);
                expect(readFileSync(logPath, "utf8")).toContain("storage-busy refusal stage=");
                expect(readFileSync(logPath, "utf8")).toContain("database is locked");
                expect(requests()).toHaveLength(0);
                console.info(`storage-busy refusal shown in host: ${STORAGE_BUSY_MESSAGE}`);
            }
            await locker.exited;
        } catch (error) {
            console.error(`storage-busy fixture ${fixture.root}`, error, host.stderr());
            console.error(readFileSync(logPath, "utf8"));
            throw error;
        } finally {
            locker?.kill();
            await host.stop();
        }
    }, 120000);
}


test("OpenCode 2 busy LKG replays the exact served prefix and system together", async () => {
    const fixture = isolation();
    const version = spawnSync(CLI, ["--version"], { env: fixture.env, cwd: fixture.cwd, encoding: "utf8" });
    expect(version.status).toBe(0);
    console.info(`storage-busy CLI=${CLI} version=${version.stdout.trim()}`);
    const logPath = join(fixture.root, "magic-context.log");
    fixture.env.MAGIC_CONTEXT_LOG_PATH = logPath;
    const probe = join(fixture.root, "lkg-probe");
    mkdirSync(probe);
    const ready = join(fixture.root, "context-ready");
    const locked = join(fixture.root, "lock-ready");
    const trace = join(fixture.root, "served.jsonl");
    writeFileSync(join(probe, "server.js"), `
        import mc from ${JSON.stringify(new URL("../../../plugin/dist/v2/server.js", import.meta.url).pathname)};
        import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
        export default { id: 'opencode-magic-context', async setup(context) {
            let seen = 0;
            const session = new Proxy(context.session, { get(target, key) {
                if (key !== 'hook') return Reflect.get(target, key);
                return (name, callback) => target.hook(name, async draft => {
                    if (name !== 'context' || !callback.toString().includes('rememberHostMedia')) return callback(draft);
                    if (++seen === 2) {
                        writeFileSync(${JSON.stringify(ready)}, 'ready');
                        while (!existsSync(${JSON.stringify(locked)})) await new Promise(resolve => setTimeout(resolve, 20));
                    }
                    await callback(draft);
                    appendFileSync(${JSON.stringify(trace)}, JSON.stringify({system:draft.system,messages:draft.messages})+'\\n');
                });
            }});
            return mc.setup(new Proxy(context, { get(target,key) { return key === 'session' ? session : Reflect.get(target,key); } }));
        }};
    `);
    const host = await spawnOpencode2({ existingIsolation: fixture, includeMagicContext: false, probePlugin: probe, magicContextConfig: {
        dreamer: { disable: true }, memory: { enabled: false }, historian: { disable: true }, temporal_awareness: false,
    } });
    let locker: ReturnType<typeof Bun.spawn> | undefined;
    try {
        const client = OpenCode.make({ baseUrl: host.url, headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` } });
        const session = await client.session.create({ location: { directory: host.cwd }, model: { providerID: "openai", id: "mock-model" } });
        await waitForPluginActive(client, host.cwd);
        await client.session.prompt({ sessionID: session.id, text: "LKG-FIRST-TURN" });
        await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(60000) });
        const prompt = client.session.prompt({ sessionID: session.id, text: "LKG-BUSY-TURN" });
        const deadline = Date.now() + 20000;
        while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(20);
        expect(existsSync(ready)).toBe(true);
        const dbPath = join(fixture.env.MAGIC_CONTEXT_STORAGE_DIR!, "context.db");
        locker = Bun.spawn(["python3", "-u", "-c", "import sqlite3,sys,time; db=sqlite3.connect(sys.argv[1]); db.execute('BEGIN IMMEDIATE'); print('locked',flush=True); time.sleep(60); db.rollback()", dbPath], { env: fixture.env, stdout: "pipe", stderr: "pipe" });
        const reader = (locker.stdout as ReadableStream<Uint8Array>).getReader();
        expect(new TextDecoder().decode((await reader.read()).value)).toContain("locked");
        reader.releaseLock();
        for (const pid of [host.pid, locker.pid]) {
            const fds = spawnSync("lsof", ["-p", String(pid), "-Fn"], {encoding:"utf8"});
            expect(fds.status).toBe(0);
            const paths = fds.stdout.split("\n").filter(line=>line.startsWith("n")).map(line=>line.slice(1));
            assertOpenPaths(paths, fixture.root);
            console.info(`LKG lsof pid=${pid} root=${fixture.root} databases=${JSON.stringify(paths.filter(path=>/\.db(-wal|-shm)?$/.test(path)))}`);
        }
        expect(locker.exitCode).toBeNull();
        writeFileSync(locked, "locked");
        await prompt;
        await client.session.wait({sessionID:session.id},{signal:AbortSignal.timeout(90000)});
        const requests = host.mock.requests().filter(request=>request.body.model === "mock-model");
        expect(requests.filter(request=>JSON.stringify(request.body).includes("LKG-BUSY-TURN"))).toHaveLength(1);
        const frames = readFileSync(trace,"utf8").trim().split("\n").map(line=>JSON.parse(line));
        expect(frames).toHaveLength(2);
        expect(JSON.stringify(frames[1].messages.slice(0, frames[0].messages.length))).toBe(JSON.stringify(frames[0].messages));
        expect(JSON.stringify(frames[1].system)).toBe(JSON.stringify(frames[0].system));
        await locker.exited;
        const logDeadline = Date.now()+10000;
        while (!readFileSync(logPath,"utf8").includes("lkg_replay_served") && Date.now()<logDeadline) await Bun.sleep(100);
        expect(readFileSync(logPath,"utf8")).toContain("lkg_replay_served");
        expect(readFileSync(logPath,"utf8")).not.toContain("lkg_content_mismatch");
        console.info("LKG real-host served prefix IDENTICAL; system IDENTICAL; lkg_replay_served");
    } catch (error) {
        console.error(`LKG fixture ${fixture.root}`, readFileSync(logPath,"utf8"), host.stderr());
        throw error;
    } finally {
        locker?.kill();
        await host.stop();
    }
}, 180000);
