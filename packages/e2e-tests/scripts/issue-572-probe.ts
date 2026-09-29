import { Database } from "bun:sqlite";
import { spawnOpencode } from "../src/opencode-runner/spawn";
import { MockProvider } from "../src/mock-provider/server";
import { appendCompartments } from "../../plugin/src/features/magic-context/compartment-storage";
import { insertMemory } from "../../plugin/src/features/magic-context/memory/storage-memory";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";

// Run with TMPDIR under a throwaway magic-context/issue-572 root.
// configured uses a fixed 262144 window; fallback has no model limit; learned
// records a ninfer overflow limit before restart; proven grows accepted input.
// In proven mode, baseline requires repeated render-config folds, while stable
// requires frozen restart bytes and exactly one fold after a policy edit.
// See docs/reports/issue-572-render-budget-plan.md for isolation and caveats.
if (!realpathSync(tmpdir()).includes("/magic-context/issue-572"))
	throw new Error("Set TMPDIR to a throwaway magic-context/issue-572 root");
const mode = Bun.argv[2] ?? "configured";
const gate = Bun.argv[3];
const records: Array<{
	turn: number;
	folds: string[];
	identity: string;
	hash: string;
}> = [];
const mock = new MockProvider();
const { baseURL } = await mock.start();
const normal = { text: "ok", usage: { input_tokens: 1000, output_tokens: 10 } };
mock.setDefault(normal);
const opts = {
	mockProviderURL: baseURL,
	mockProviderID: "mock-ninfer",
	mockProviderAPI: "@ai-sdk/openai" as const,
	mockModelID: "Qwen3.8-27B",
	modelContextLimit: 262144,
	magicContextConfig: {
		...(mode === "proven" ? { compaction: { enabled: false } } : {}),
		historian: { disable: true },
		embedding: { provider: "off" },
		memory: {
			auto_search: { enabled: false },
			git_commit_indexing: { enabled: false },
		},
	},
	...(mode === "configured"
		? {}
		: {
				openCodeConfigExtra: {
					provider: {
						"mock-ninfer": {
							npm: "@ai-sdk/openai",
							name: "Mock ninfer",
							options: { apiKey: "test-key-not-real", baseURL },
							models: { "Qwen3.8-27B": { name: "Qwen3.8-27B" } },
						},
					},
				},
			}),
};
let host = await spawnOpencode(opts);
function isolate() {
	const paths = Bun.spawnSync(["lsof", "-p", String(host.pid), "-Fn"])
		.stdout.toString()
		.split("\n")
		.filter((s) => s.startsWith("n/"))
		.map((s) => s.slice(1));
	const dbs = [...new Set(paths.filter((s) => /\.db(-wal|-shm)?$/.test(s)))];
	if (
		!dbs.length ||
		dbs.some((s) => !s.startsWith(realpathSync(host.env.dataDir)))
	)
		throw new Error("isolation failed: " + dbs);
	console.log("ISOLATED", mode, host.pid, dbs);
}
async function turn(id: string, n: number) {
	const logPath = join(host.env.dataDir, "cortexkit", "magic-context-e2e.log");
	const logOffset = readFileSync(logPath, "utf8").length;
	const before = mock.requests().length;
	const snapshotDb = new Database(
		join(host.env.dataDir, "cortexkit", "magic-context", "context.db"),
	);
	const snapshot = () =>
		snapshotDb
			.prepare(
				"SELECT cached_m0_upgrade_state, last_usage_context_limit, observed_safe_input_tokens, detected_context_limit FROM session_meta WHERE session_id = ?",
			)
			.get(id);
	console.log("BEFORE", n, snapshot());
	const ballast =
		mode === "proven" && n >= 1 && n <= 4
			? "decision result ".repeat(
					Math.ceil(([261171, 270000, 280000, 280000][n - 1] * 4) / 16),
				)
			: "";
	const result = await fetch(host.url + "/session/" + id + "/message", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model: { providerID: "mock-ninfer", modelID: "Qwen3.8-27B" },
			parts: [{ type: "text", text: "turn " + n + " " + ballast }],
		}),
	});
	console.log("TURN", n, result.status);
	const response = (await result.json()) as {
		info?: { id?: string; error?: unknown };
	};
	await Bun.sleep(1200);
	console.log(
		"AFTER",
		n,
		snapshot(),
		"requests",
		mock.requests().length - before,
	);
	const row = snapshotDb
		.prepare(
			"SELECT cached_m0_upgrade_state, cached_m0_bytes FROM session_meta WHERE session_id = ?",
		)
		.get(id) as {
		cached_m0_upgrade_state: string;
		cached_m0_bytes: Uint8Array;
	};
	records.push({
		turn: n,
		identity: row.cached_m0_upgrade_state,
		hash: createHash("sha256").update(row.cached_m0_bytes).digest("hex"),
		folds: readFileSync(logPath, "utf8")
			.slice(logOffset)
			.split("\n")
			.filter(
				(line) =>
					line.includes("transform: injected m[0]/m[1]") &&
					line.includes("rematerialized=true"),
			),
	});
	snapshotDb.close();
	if (
		!result.ok ||
		(response.info?.error && n !== 98) ||
		mock.requests().length === before
	)
		throw new Error("turn failed: " + JSON.stringify(response.info));
	return response.info?.id;
}
try {
	isolate();
	const session = (await (
		await fetch(host.url + "/session", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		})
	).json()) as { id: string };
	const seedMessageId = await turn(session.id, 0);
	if (!seedMessageId) throw new Error("seed response has no message id");
	const db = new Database(
		join(host.env.dataDir, "cortexkit", "magic-context", "context.db"),
	);
	appendCompartments(
		db as unknown as Parameters<typeof appendCompartments>[0],
		session.id,
		[
			{
				sequence: 1,
				startMessage: 1,
				endMessage: 1,
				startMessageId: seedMessageId,
				endMessageId: seedMessageId,
				title: "Seed history",
				content: "",
				p1: "Remember the isolated fixture.",
				p2: "Fixture.",
				p3: "Fixture.",
				p4: "Fixture.",
				importance: 50,
			},
		],
	);
	insertMemory(db as unknown as Parameters<typeof insertMemory>[0], {
		projectPath: realpathSync(host.env.workdir),
		category: "ARCHITECTURE",
		content: "The mock provider is isolated.",
	});
	db.prepare(
		"UPDATE session_meta SET cached_m1_bytes = NULL WHERE session_id = ?",
	).run(session.id);
	db.close();
	await turn(session.id, 10);
	if (mode === "learned") {
		mock.script([
			{
				error: {
					status: 400,
					type: "invalid_request_error",
					message:
						"AI_APICallError: prepared prompt exceeds Engine max_context 262144",
				},
			},
		]);
		await turn(session.id, 98);
	}
	const env = host.env;
	await host.kill();
	host = await spawnOpencode({ ...opts, existingEnv: env });
	isolate();
	for (let n = 1; n <= 3; n++) {
		if (mode === "proven")
			mock.setDefault({
				text: "ok",
				usage: {
					input_tokens: [261171, 270000, 280000][n - 1],
					output_tokens: 10,
				},
			});
		await turn(session.id, n);
	}
	if (mode === "proven") await turn(session.id, 4);
	const restartRecords = records.filter((r) => r.turn >= 1 && r.turn <= 4);
	if (
		gate === "baseline" &&
		restartRecords
			.flatMap((r) => r.folds)
			.filter((s) => s.includes("reason=render_config")).length < 2
	)
		throw new Error("baseline did not reproduce repeated render-config folds");
	if (gate === "stable") {
		if (
			restartRecords.some((r) => r.folds.length > 0) ||
			new Set(restartRecords.map((r) => r.hash)).size !== 1
		)
			throw new Error("restart prefix was not frozen");
		const canonical = join(
			host.env.configDir,
			"cortexkit",
			"magic-context.jsonc",
		);
		const config = JSON.parse(readFileSync(canonical, "utf8"));
		config.history_budget_percentage = 0.2;
		writeFileSync(canonical, JSON.stringify(config));
		const env = host.env;
		await host.kill();
		host = await spawnOpencode({
			...opts,
			existingEnv: env,
			magicContextConfig: {
				...opts.magicContextConfig,
				history_budget_percentage: 0.2,
			},
		});
		isolate();
		for (let n = 20; n <= 22; n++) await turn(session.id, n);
		const edits = records.filter((r) => r.turn >= 20);
		if (
			edits[0].folds.length !== 1 ||
			!edits[0].folds[0].includes("render_config:budget(") ||
			edits.slice(1).some((r) => r.folds.length)
		)
			throw new Error("policy edit did not fold exactly once");
		if (JSON.stringify(mock.requests()).includes("render_config:"))
			throw new Error("diagnostic leaked into provider prompt");
	}
	console.table(
		records.map((r) => ({
			turn: r.turn,
			identity: r.identity,
			folds: r.folds.length,
			sha256: r.hash,
		})),
	);
	console.log("ROOT", host.env.dataDir);
	console.log(
		readFileSync(
			join(host.env.dataDir, "cortexkit", "magic-context-e2e.log"),
			"utf8",
		)
			.split("\n")
			.filter(
				(s) =>
					s.includes("issue-572 probe") ||
					s.includes("rematerialized=") ||
					s.includes("context limit") ||
					s.includes("models-dev-cache") ||
					s.includes("overflow"),
			)
			.join("\n"),
	);
} finally {
	await host.kill();
	await mock.stop();
}
