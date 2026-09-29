// Point MC_E2E_OPENCODE2_CLI at an OpenCode 2 binary. To test an older plugin,
// point MC_554_SOURCE_ROOT at its extracted packages/plugin/src directory.
// Host stores, logs, and the shared context.db stay beneath this run's temporary root.
import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { OpenCode } from "@opencode/client";
import { isolation, spawnOpencode2 } from "../src/opencode2-runner/spawn";

const count = Number(process.env.MC_554_HOSTS ?? 11);
const root = resolve(
	join(tmpdir(), "magic-context", "issue-554", `${Date.now()}-${process.pid}`),
);
mkdirSync(root, { recursive: true });
const canonicalRoot = realpathSync(root);
const storage = join(canonicalRoot, "shared");
mkdirSync(storage);
const source = resolve(
	process.env.MC_554_SOURCE_ROOT ?? join(import.meta.dir, "../../plugin/src"),
);
const plugin = join(root, "probe-plugin");
mkdirSync(plugin);
symlinkSync(
	resolve(import.meta.dir, "../../plugin/node_modules"),
	join(plugin, "node_modules"),
);
writeFileSync(
	join(plugin, "package.json"),
	JSON.stringify({
		name: "issue-554-probe",
		type: "module",
		main: "server.js",
	}),
);
writeFileSync(
	join(plugin, "entry.ts"),
	`
import { appendFileSync } from "node:fs";
import { Database } from "bun:sqlite";
const sample = new Database(":memory:");
const statementPrototype = Object.getPrototypeOf(sample.prepare("SELECT 1"));
const originalRun = statementPrototype.run;
statementPrototype.run = function (...args) {
  const start = Date.now();
  const stack = new Error().stack;
  try { return originalRun.apply(this, args); }
  finally {
    const ms = Date.now() - start;
    if (ms > 150) appendFileSync(${JSON.stringify(join(root, "sqlite-waits.log"))}, JSON.stringify({ pid: process.pid, ms, method: "run", sql: String(this).slice(0, 180), stack }) + '\\n');
  }
};
const originalExec = Database.prototype.exec;
Database.prototype.exec = function (...args) {
  const start = Date.now();
  const stack = new Error().stack;
  try { return originalExec.apply(this, args); }
  finally {
    const ms = Date.now() - start;
    if (ms > 150) appendFileSync(${JSON.stringify(join(root, "sqlite-waits.log"))}, JSON.stringify({ pid: process.pid, ms, method: "exec", sql: args[0], stack }) + '\\n');
  }
};
sample.close();
const { setup } = await import(${JSON.stringify(join(source, "v2/server.ts"))});
const trace = ${JSON.stringify(join(root, "heartbeat.log"))};
export default { id: "opencode-magic-context", async setup(context) {
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    if (now - last > 150) appendFileSync(trace, JSON.stringify({ pid: process.pid, at: now, gapMs: now - last }) + '\\n');
    last = now;
  }, 20);
  timer.unref();
  return setup(context);
} };
`,
);
const built = await Bun.build({
	entrypoints: [join(plugin, "entry.ts")],
	outdir: plugin,
	naming: "server.js",
	target: "bun",
	tsconfig: resolve(import.meta.dir, "../../plugin/tsconfig.json"),
	define: { "process.env.NODE_ENV": JSON.stringify("production") },
	external: [
		"@opencode/plugin",
		"onnxruntime-node",
		"onnxruntime-web",
		"sharp",
	],
});
if (!built.success) throw new Error(built.logs.join("\n"));
const hosts: Awaited<ReturnType<typeof spawnOpencode2>>[] = [];
const samples: {
	phase: string;
	index: number;
	ms: number;
	status: number | string;
	at: number;
}[] = [];
const turns: { index: number; phase: string; ms: number; result: string }[] =
	[];
const dbPath = join(storage, "context.db");
let lock: Database | undefined;
let paused = false;
const version = execFileSync(process.env.MC_E2E_OPENCODE2_CLI!, ["--version"], {
	encoding: "utf8",
}).trim();
try {
	for (let index = 0; index < count; index++) {
		const prior = process.env.TMPDIR;
		process.env.TMPDIR = root;
		const fixture = isolation();
		if (prior === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = prior;
		fixture.root = canonicalRoot;
		fixture.env.MAGIC_CONTEXT_STORAGE_DIR = storage;
		fixture.env.TMPDIR = join(canonicalRoot, `host-tmp-${index}`);
		mkdirSync(fixture.env.TMPDIR);
		// In the runner each host has its own OpenCode DB and private XDG roots.
		const host = await spawnOpencode2({
			existingIsolation: fixture,
			includeMagicContext: false,
			probePlugin: plugin,
			prepareContextDatabase: false,
			magicContextConfig: {
				dreamer: { disable: true },
				historian: { disable: true },
				memory: { enabled: false },
			},
		});
		hosts.push(host);
	}
	const auth = (host: (typeof hosts)[number]) => ({
		authorization: `Basic ${btoa(`opencode:${host.password}`)}`,
	});
	const clients = hosts.map((host) =>
		OpenCode.make({ baseUrl: host.url, headers: auth(host) }),
	);
	const sessions = await Promise.all(
		clients.map(async (client, i) => {
			const session = await client.session.create({
				title: `issue 554 ${i}`,
				location: { directory: hosts[i].cwd },
				model: { providerID: "openai", id: "mock-model" },
			});
			return session.id;
		}),
	);
	const drive = async (phase: string) =>
		Promise.allSettled(
			clients.map(async (client, i) => {
				if (i >= 7) return;
				const start = performance.now();
				try {
					await client.session.prompt({
						sessionID: sessions[i],
						text: `issue 554 ${phase} ${Date.now()}`,
					});
					turns.push({
						index: i,
						phase,
						ms: performance.now() - start,
						result: "ok",
					});
				} catch (error) {
					turns.push({
						index: i,
						phase,
						ms: performance.now() - start,
						result: String(error),
					});
				}
			}),
		);
	const poll = async (phase: string, seconds: number) => {
		const end = performance.now() + seconds * 1000;
		while (performance.now() < end) {
			const start = performance.now();
			await Promise.all(
				hosts.map(async (host, index) => {
					const began = performance.now();
					try {
						const response = await fetch(`${host.url}/health`, {
							headers: auth(host),
							signal: AbortSignal.timeout(900),
						});
						samples.push({
							phase,
							index,
							ms: performance.now() - began,
							status: response.status,
							at: Date.now(),
						});
					} catch (error) {
						samples.push({
							phase,
							index,
							ms: performance.now() - began,
							status: String(error),
							at: Date.now(),
						});
					}
				}),
			);
			await Bun.sleep(Math.max(0, 1000 - (performance.now() - start)));
		}
	};
	// Keep prompts in flight as the external probe observes the active host event loops.
	const steadyTurn = drive("steady");
	await poll("steady", 10);
	await steadyTurn;
	hosts.forEach((host) => process.kill(host.pid!, "SIGSTOP"));
	paused = true;
	await poll("stopped", 30);
	hosts.forEach((host) => process.kill(host.pid!, "SIGCONT"));
	paused = false;
	const wakeTurn = drive("wake");
	await poll("wake", 10);
	await wakeTurn;
	lock = new Database(dbPath);
	lock.exec("BEGIN IMMEDIATE");
	const lockTurn = drive("locked");
	await poll("locked", 10);
	lock.exec("ROLLBACK");
	lock.close();
	lock = undefined;
	await poll("released", 7);
	await Promise.race([lockTurn, Bun.sleep(12000)]);
	const openPaths = hosts.map((host) => ({
		pid: host.pid,
		dbs: execFileSync("lsof", ["-p", String(host.pid), "-Fn"], {
			encoding: "utf8",
		})
			.split("\n")
			.filter((line) => /^n.*\.db(?:-wal|-shm)?$/.test(line))
			.map((line) => line.slice(1)),
	}));
	if (
		openPaths.some(
			({ dbs }) =>
				dbs.length === 0 ||
				dbs.some((path) => !path.startsWith(canonicalRoot + "/")),
		)
	)
		throw new Error("host database path escaped throwaway root");
	const phases = Object.fromEntries(
		["steady", "stopped", "wake", "locked", "released"].map((phase) => {
			const group = samples.filter((sample) => sample.phase === phase);
			return [
				phase,
				{
					count: group.length,
					failures: group.filter((item) => item.status !== 200).length,
					maxMs: Math.round(Math.max(...group.map((item) => item.ms))),
					p95Ms: Math.round(
						group.map((item) => item.ms).sort((a, b) => a - b)[
							Math.floor(group.length * 0.95)
						] ?? 0,
					),
				},
			];
		}),
	);
	const hostLogs = hosts.map((host) => ({
		pid: host.pid,
		stdout: host.stdout(),
		stderr: host.stderr(),
	}));
	const sqliteWaits = existsSync(join(root, "sqlite-waits.log"))
		? readFileSync(join(root, "sqlite-waits.log"), "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line))
		: [];
	const evidence = {
		root,
		version,
		source,
		sqliteWaits,
		hostPids: hosts.map((host) => host.pid),
		phases,
		turns,
		openPaths,
		samples,
		hostLogs,
		heartbeat: readFileSync(join(root, "heartbeat.log"), "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line)),
	};
	writeFileSync(join(root, "evidence.json"), JSON.stringify(evidence, null, 2));
	console.log(
		JSON.stringify({
			root,
			version,
			phases,
			turns,
			heartbeat: evidence.heartbeat.length,
			openPaths,
		}),
	);
} finally {
	if (paused)
		hosts.forEach((host) => {
			try {
				process.kill(host.pid!, "SIGCONT");
			} catch {}
		});
	if (lock) {
		lock.exec("ROLLBACK");
		lock.close();
	}
	await Promise.allSettled(hosts.map((host) => host.stop()));
}
