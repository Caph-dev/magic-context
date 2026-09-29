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
const turns: {
	index: number;
	phase: string;
	ms: number;
	result: string;
	startedAt: number;
	settledAt: number;
	promptText: string;
	idleOutcome?: string;
	providerRequests?: number;
	classification?: string;
}[] = [];
const dbPath = join(storage, "context.db");
// Initialize the isolated shared schema before starting the hosts. If they
// start against an unmigrated database together, a later host can refuse the
// migration instead of reaching the ten-second external writer-lock phase.
const { openDatabase, closeDatabase } = await import("../../plugin/src/features/magic-context/storage-db");
if (!openDatabase(dbPath)) throw new Error("failed to initialize throwaway shared store");
closeDatabase();
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
		fixture.env.MAGIC_CONTEXT_LOG_PATH = join(canonicalRoot, `magic-context-${index}.log`);
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
			for (let round = 0; round < (phase === "locked" ? 1 : 3); round++) {
				const start = performance.now();
				const startedAt = Date.now();
				const promptText = `issue 554 ${phase} ${i} ${round} ${startedAt}`;
				let result = "ok";
				try {
					await client.session.prompt({ sessionID: sessions[i], text: promptText });
					await client.session.wait(
						{ sessionID: sessions[i] },
						{ signal: AbortSignal.timeout(40_000) },
					);
				} catch (error) {
					result = String(error);
				}
				const store = new Database(
					join(hosts[i].env.XDG_DATA_HOME!, "opencode", hosts[i].env.OPENCODE_DB!),
					{ readonly: true },
				);
				let idleOutcome: string | undefined;
				try {
					const idle = store.prepare("SELECT data FROM session_message WHERE session_id=? AND type='idle' ORDER BY seq DESC LIMIT 1").get(sessions[i]) as { data: string } | undefined;
					idleOutcome = idle ? JSON.parse(idle.data).outcome : undefined;
				} finally {
					store.close();
				}
				turns.push({
					index: i,
					phase,
					ms: performance.now() - start,
					result,
					startedAt,
					settledAt: Date.now(),
					promptText,
					idleOutcome,
					providerRequests: hosts[i].mock.requests().filter((request) =>
						JSON.stringify(request).includes(promptText),
					).length,
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
	await Promise.race([lockTurn, Bun.sleep(40000)]);
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
	// The logger buffers diagnostics; allow its flush timer to run before
	// matching session-specific replay and refusal markers to completed turns.
	await Bun.sleep(500);
	const acquisitionWaits: Array<{ index: number; phase: string; site: string; lane: string; line: string }> = [];
	for (const turn of turns) {
		const logPath = join(canonicalRoot, `magic-context-${turn.index}.log`);
		const lines = existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n") : [];
		const inTurn = lines.filter((line) => {
			const timestamp = Date.parse(line.slice(1, 25));
			return timestamp >= turn.startedAt && timestamp <= turn.settledAt + 500;
		});
		const sessionLines = inTurn.filter((line) => line.includes(`[${sessions[turn.index]}]`));
		turn.classification = turn.idleOutcome === "interrupted" && (turn.providerRequests ?? 0) === 0 &&
			sessionLines.some((line) => line.includes("v2 refusal:"))
			? "refused"
			: (turn.providerRequests ?? 0) > 0 && sessionLines.some((line) => line.includes("lkg_replay_served"))
				? "lkg"
				: turn.idleOutcome === "succeeded" && (turn.providerRequests ?? 0) > 0 &&
					sessionLines.some((line) => line.includes("transform completed in"))
					? "normal"
					: "unknown";
	}
	const turnOutcomes = Object.fromEntries(
		["steady", "wake", "locked"].map((phase) => [phase,
			Object.fromEntries(["normal", "lkg", "refused", "unknown"].map((kind) => [kind, turns.filter((turn) => turn.phase === phase && turn.classification === kind).length])),
		]),
	);
	const hostLogs = hosts.map((host) => ({
		pid: host.pid,
		stdout: host.stdout(),
		stderr: host.stderr(),
	}));
	for (const [index, host] of hostLogs.entries()) {
		for (const line of host.stderr.split("\n")) {
			if (!line.includes("sqlite acquisition site=")) continue;
			const completedAt = Date.parse(line.slice(1, 25));
			const elapsed = Number(/elapsed=(\d+)ms/.exec(line)?.[1] ?? 0);
			const beganAt = completedAt - elapsed;
			const turn = turns.find((item) =>
				item.index === index && beganAt >= item.startedAt - 500 && beganAt <= item.settledAt + 500,
			);
			acquisitionWaits.push({
				index,
				phase: turn?.phase ?? "outside-turn",
				site: /site=([^ ]+)/.exec(line)?.[1] ?? "unknown",
				lane: /lane=([^ ]+)/.exec(line)?.[1] ?? "unknown",
				line,
			});
		}
	}
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
		turnOutcomes,
		acquisitionWaits,
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
