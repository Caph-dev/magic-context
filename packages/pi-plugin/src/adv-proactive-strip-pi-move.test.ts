/**
 * Adversarial reproduction for moving the Pi thinking-binding strip from the
 * start of the context pass to its end.
 *
 * Before the move, a session that carries `binding_mismatch:` strips had its
 * frozen thinking removed from `event.messages` before any pipeline stage ran,
 * so every stage (tool-arc drop rendering included) saw an assistant without
 * thinking. After the move the stages see the thinking and the strip runs last.
 * A tool arc dropped beside frozen thinking therefore renders differently on the
 * first pass served by the new build, and that pass can be a defer pass.
 *
 * The earlier build is emulated here by feeding the handler input whose frozen
 * thinking is already removed: that is exactly what the start-of-pass strip
 * handed to every later stage, and the end-of-pass strip then finds nothing
 * left to remove.
 */
import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
	getTagsBySession,
	updateTagStatus,
} from "@magic-context/core/features/magic-context/storage";
import { addMergedReasoningStrippedIds } from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
	signalPiPendingMaterialization,
} from "./context-handler";
import {
	createFakePi,
	createTestDb,
	fakeContext,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";

const opus = (content: unknown[], timestamp: number) => ({
	role: "assistant",
	content,
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-opus-5-5",
	usage: {},
	stopReason: "toolUse",
	timestamp,
});

const THINKING = new Set(["thinking", "redactedThinking", "redacted_thinking"]);

const build = (withoutFrozenThinking: boolean) => {
	const thinking = (text: string) =>
		withoutFrozenThinking
			? []
			: [
					{
						type: "thinking",
						thinking: text,
						thinkingSignature: `sig-${text}`,
					},
				];
	return [
		userMessage("please read the file", 1),
		opus(
			[
				...thinking("t1"),
				{
					type: "toolCall",
					id: "c1",
					name: "Read",
					arguments: { path: "a.ts" },
				},
			],
			2,
		),
		toolResultMessage("c1", "payload ".repeat(400), 3),
		opus([...thinking("t2"), { type: "text", text: "done reading" }], 4),
		userMessage("next request", 5),
	];
};
const ENTRY_IDS = ["entry-u1", "entry-a1", "entry-t1", "entry-a2", "entry-u2"];

const sha = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");

describe("Pi binding-strip move: first pass on the new build", () => {
	// Expected to fail until sessions that already carry frozen thinking strips
	// keep removing that thinking before the pipeline stages run, and switch to
	// the end-of-pass order only on a pass that is allowed to change served bytes.
	it.failing("a defer pass after the upgrade serves the bytes the earlier build served", async () => {
		const db = createTestDb();
		const sessionId = "ses-pi-binding-move";
		const fake = createFakePi();
		try {
			registerPiContextHandler(
				fake.pi as never,
				{ db, heuristics: {} } as never,
			);
			const handler = fake.handlers.get("context") as (
				event: unknown,
				ctx: unknown,
			) => Promise<{ messages: unknown[] } | undefined>;
			const pass = async (withoutFrozenThinking: boolean) => {
				const messages = build(withoutFrozenThinking);
				const result = await handler(
					{ messages },
					{
						...fakeContext(
							sessionId,
							process.cwd(),
							ENTRY_IDS,
							messages as never,
						),
						model: { provider: "anthropic", id: "claude-opus-5-5" },
					},
				);
				return (result?.messages ?? messages) as unknown[];
			};

			// Earlier build: a binding 400 froze both assistants, then a busting
			// pass dropped the tool arc while the frozen thinking was already gone.
			await pass(false);
			addMergedReasoningStrippedIds(db, sessionId, [
				"binding_mismatch:entry-a1",
				"binding_mismatch:entry-a2",
			]);
			const tool = getTagsBySession(db, sessionId).find(
				(tag) => tag.type === "tool",
			);
			if (!tool) throw new Error("missing tool tag");
			updateTagStatus(db, sessionId, tool.tagNumber, "dropped");
			signalPiPendingMaterialization(sessionId);
			const earlierBusting = await pass(true);
			const earlierDefer = await pass(true);
			expect(sha(earlierDefer)).toBe(sha(earlierBusting));
			// The earlier build removed the whole arc: no assistant a1, no result.
			expect(earlierDefer).toHaveLength(3);

			// New build, defer pass: Pi hands over the stored messages with their
			// thinking; the strip now runs after the stages.
			const upgradedDefer = await pass(false);
			const thinkingLeft = upgradedDefer.some(
				(message) =>
					Array.isArray((message as { content?: unknown }).content) &&
					(message as { content: { type?: string }[] }).content.some((part) =>
						THINKING.has(String(part.type)),
					),
			);
			expect(thinkingLeft).toBe(false);
			// Fails on the delivery: the dropped arc comes back as a marker skeleton
			// (assistant toolCall with `{"dropped": …}` plus the placeholder result),
			// which changes the served prefix at index 1 on a defer pass.
			expect(sha(upgradedDefer)).toBe(sha(earlierDefer));
		} finally {
			clearContextHandlerSession(sessionId);
			closeQuietly(db);
		}
	});
});
