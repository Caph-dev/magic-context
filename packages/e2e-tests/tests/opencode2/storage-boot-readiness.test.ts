import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { OpenCode } from "@opencode/client";
import {
	CLI,
	isolation,
	spawnOpencode2,
	waitForPluginActive,
} from "../../src/opencode2-runner/spawn";

test("OpenCode 2 serves HTTP while Windows migration probes are slow and storage is blocked", async () => {
	const parent = join(tmpdir(), "magic-context", "boot-readiness");
	mkdirSync(parent, { recursive: true });
	const previousTmp = process.env.TMPDIR;
	process.env.TMPDIR = parent;
	const fixture = isolation();
	if (previousTmp === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = previousTmp;
	const cliVersion = execFileSync(CLI, ["--version"], {
		env: fixture.env,
		encoding: "utf8",
	}).trim();
	console.log(`OpenCode CLI: ${CLI}; version: ${cliVersion}`);
	const storage = fixture.env.MAGIC_CONTEXT_STORAGE_DIR!;
	mkdirSync(join(storage, "rpc", "older-host"), { recursive: true });
	const dbPath = join(storage, "context.db");
	const db = new Database(dbPath);
	db.exec(
		"CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY); INSERT INTO schema_migrations VALUES (90)",
	);
	db.exec("BEGIN IMMEDIATE");
	const blockerPid = process.pid;
	writeFileSync(
		join(storage, "rpc", "older-host", `port-${blockerPid}.json`),
		JSON.stringify({
			pid: blockerPid,
			port: 43123,
			started_at: Date.now(),
			kind: "OpenCode server",
		}),
	);
	const source =
		process.env.MC_BOOT_SOURCE_ROOT ??
		resolve(import.meta.dir, "../../../plugin/src");
	const plugin = join(fixture.root, "probe-plugin");
	mkdirSync(plugin);
	symlinkSync(
		resolve(import.meta.dir, "../../../plugin/node_modules"),
		join(plugin, "node_modules"),
	);
	const trace = join(fixture.root, "probes.log");
	writeFileSync(
		join(plugin, "package.json"),
		JSON.stringify({
			name: "storage-readiness-probe",
			type: "module",
			main: "index.js",
		}),
	);
	const entry = join(plugin, "entry.ts");
	writeFileSync(
		entry,
		`
import { appendFileSync } from "node:fs";
import { setup } from ${JSON.stringify(join(source, "v2/server.ts"))};
import * as probes from ${JSON.stringify(join(source, "shared/rpc-utils.ts"))};
const facts = JSON.stringify([{ ProcessId: ${blockerPid}, ParentProcessId: 1, CommandLine: "opencode serve", CreationDate: "2026-01-01T00:00:00Z" }]);
const mark = (text) => appendFileSync(${JSON.stringify(trace)}, text + "\\n");
probes.__setRpcIdentityTestHooks({ platform: "win32", execFileSync: (file) => file === "powershell" ? facts : '"opencode.exe","${blockerPid}"', processListExecFileSync: () => { mark("sync-start"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000); mark("sync-end"); return facts; } });
const asyncHook = probes["__setAsyncProcessProbeForTests"];
if (asyncHook) asyncHook(async () => { mark("async-start"); await new Promise(resolve => setTimeout(resolve, 5000)); mark("async-end"); return facts; });
export default { id: "opencode-magic-context", async setup(context) { mark("setup-start " + Date.now()); let lastBeat = Date.now(); let maxGap = 0; const beat = () => { const now = Date.now(); maxGap = Math.max(maxGap, now - lastBeat); lastBeat = now; }; const heartbeat = setInterval(beat, 10); try { const dispose = await setup(context); mark("setup-end " + Date.now()); return dispose; } finally { beat(); clearInterval(heartbeat); mark("heartbeat-max " + maxGap); } } };
`,
	);
	const built = await Bun.build({
		entrypoints: [entry],
		outdir: plugin,
		naming: "server.js",
		target: "bun",
		define: { "process.env.NODE_ENV": JSON.stringify("production") },
		external: [
			"@opencode/plugin",
			"onnxruntime-node",
			"onnxruntime-web",
			"sharp",
		],
	});
	if (!built.success) throw new Error(built.logs.join("\n"));
	const host = await spawnOpencode2({
		existingIsolation: fixture,
		includeMagicContext: false,
		probePlugin: plugin,
		prepareContextDatabase: false,
		magicContextConfig: {
			dreamer: { disable: true },
			memory: { enabled: false },
		},
	});
	const headers = {
		authorization: `Basic ${btoa(`opencode:${host.password}`)}`,
	};
	const client = OpenCode.make({ baseUrl: host.url, headers });
	let releaseLock: ReturnType<typeof setTimeout> | undefined;
	try {
		// Activation is lazy on this host; drive it while sampling HTTP from outside
		// the host process, so a blocked host event loop cannot delay our timeout.
		const activationStarted = performance.now();
		let activationMs = 0;
		const activation = client.session
			.create({
				title: "blocked storage boot",
				location: { directory: host.cwd },
				model: { providerID: "openai", id: "mock-model" },
			})
			.then(() => waitForPluginActive(client, host.cwd))
			.then(() => {
				activationMs = performance.now() - activationStarted;
			});
		const setupDeadline = Date.now() + 30_000;
		while (
			(!existsSync(trace) ||
				!readFileSync(trace, "utf8").includes("setup-start")) &&
			Date.now() < setupDeadline
		)
			await Bun.sleep(10);
		// Hold an actual SQLite writer lock through the five-second discovery probe.
		// The advertised live server must still block migration after the lock is released.
		releaseLock = setTimeout(() => db.exec("ROLLBACK"), 5000);
		const latencies: number[] = [];
		const failures: string[] = [];
		for (let index = 0; index < 30; index++) {
			const started = performance.now();
			try {
				const response = await fetch(`${host.url}/health`, {
					headers,
					signal: AbortSignal.timeout(2000),
				});
				if (!response.ok) failures.push(`HTTP ${response.status}`);
			} catch (error) {
				failures.push(String(error));
			}
			latencies.push(performance.now() - started);
			await Bun.sleep(200);
		}
		await activation;
		clearTimeout(releaseLock);
		if (db.inTransaction) db.exec("ROLLBACK");
		const openFiles = execFileSync("lsof", ["-p", String(host.pid), "-Fn"], {
			encoding: "utf8",
		});
		const databases = openFiles
			.split("\n")
			.filter(
				(line) => line.startsWith("n") && /\.db(?:-wal|-shm)?$/.test(line),
			);
		expect(databases.length).toBeGreaterThan(0);
		for (const path of databases)
			expect(path.slice(1).startsWith(fixture.root)).toBe(true);
		const probeLog = readFileSync(trace, "utf8");
		const evidence = {
			root: fixture.root,
			cliVersion,
			pid: host.pid,
			source,
			probeLog,
			activationMs,
			latencies,
			failures,
			databases,
		};
		writeFileSync(
			join(fixture.root, "readiness-evidence.json"),
			JSON.stringify(evidence, null, 2),
		);
		console.log(JSON.stringify(evidence));
		expect(probeLog).toContain("setup-end");
		if (!process.env.MC_BOOT_SOURCE_ROOT) {
			expect(probeLog).toContain("async-start");
			expect(probeLog.split("\n")).not.toContain("sync-start");
		}
		const setupMs =
			Number(/setup-end (\d+)/.exec(probeLog)?.[1]) -
			Number(/setup-start (\d+)/.exec(probeLog)?.[1]);
		console.log(`Setup duration: ${setupMs} ms`);
		expect(Number(/heartbeat-max (\d+)/.exec(probeLog)?.[1])).toBeLessThan(1000);
		expect(failures).toEqual([]);
		expect(Math.max(...latencies)).toBeLessThan(2000);
		const checked = new Database(dbPath, { readonly: true });
		expect(
			checked
				.query("SELECT MAX(version) AS version FROM schema_migrations")
				.get(),
		).toEqual({ version: 90 });
		checked.close();
	} catch (error) {
		writeFileSync(join(fixture.root, "host-stderr.log"), host.stderr());
		console.error(`Host diagnostics: ${fixture.root}`);
		throw error;
	} finally {
		clearTimeout(releaseLock);
		db.close();
		await host.stop();
	}
}, 120_000);
