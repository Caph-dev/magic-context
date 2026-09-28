import { closeSync, opendirSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { PRIMER_SEED_CAP_TOKENS } from "@magic-context/core/features/magic-context/dreamer/primer-seed";
import type { RawMessageProvider } from "@magic-context/core/hooks/magic-context/read-session-chunk";
import { estimateTokens } from "@magic-context/core/hooks/magic-context/read-session-formatting";
import { RAW_SUMMARY_TEXT_MAX_CHARS } from "@magic-context/core/hooks/magic-context/read-session-raw";
import { convertEntriesToRawMessagePage } from "../read-session-pi";
import { resolvePiCodingAgentModule } from "./pi-session-api";

export interface PiPrimerRawProviderDeps {
	/** An explicit session directory, as accepted by SessionManager.listAll. */
	sessionDir?: string;
}

// A malformed or unusually large entry must not defeat the seed's memory bound.
// Refuse it rather than skipping it and silently shifting persisted ordinals.
const MAX_ENTRY_BYTES = 1024 * 1024;
const MAX_PARTS = 256;
const TOOL_KEYS = [
	"description",
	"filePath",
	"path",
	"pattern",
	"query",
	"symbol",
	"module",
	"action",
];

function* lines(path: string): Generator<string> {
	const fd = openSync(path, "r");
	const buffer = Buffer.alloc(64 * 1024);
	let pending = Buffer.alloc(0);
	try {
		while (true) {
			const bytes = readSync(fd, buffer, 0, buffer.length, null);
			if (bytes === 0) break;
			let start = 0;
			for (let i = 0; i < bytes; i++) {
				if (buffer[i] !== 10) continue;
				if (pending.length + i - start > MAX_ENTRY_BYTES)
					throw new Error("Pi primer entry exceeds bounded reader capacity");
				yield Buffer.concat([pending, buffer.subarray(start, i)]).toString(
					"utf8",
				);
				pending = Buffer.alloc(0);
				start = i + 1;
			}
			if (pending.length + bytes - start > MAX_ENTRY_BYTES)
				throw new Error("Pi primer entry exceeds bounded reader capacity");
			pending = Buffer.concat([pending, buffer.subarray(start, bytes)]);
		}
		if (pending.length) yield pending.toString("utf8");
	} finally {
		closeSync(fd);
	}
}

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}
function short(value: unknown, max = 512): string | undefined {
	if (typeof value !== "string") return undefined;
	// Keep a long string unchanged when its estimated tokens fit the primer's
	// token budget; otherwise truncate it to the field's character limit.
	return value.length <= max || estimateTokens(value) <= PRIMER_SEED_CAP_TOKENS
		? value
		: value.slice(0, max);
}

/** Keep only text and the tool-input fields used by the OpenCode summary reader. */
function projectEntry(value: unknown): unknown {
	const entry = record(value);
	if (entry.type !== "message") return { type: entry.type };
	const message = record(entry.message);
	let content: unknown = [];
	if (message.role === "user" && typeof message.content === "string") {
		content = short(message.content, RAW_SUMMARY_TEXT_MAX_CHARS);
	} else if (message.role !== "toolResult" && Array.isArray(message.content)) {
		if (message.content.length > MAX_PARTS)
			throw new Error("Pi primer entry has too many parts");
		content = message.content.flatMap<unknown>((part) => {
			const p = record(part);
			if (p.type === "text")
				return [
					{ type: "text", text: short(p.text, RAW_SUMMARY_TEXT_MAX_CHARS) },
				];
			if (p.type !== "toolCall") return [];
			const args = record(p.arguments);
			return [
				{
					type: "toolCall",
					id: short(p.id),
					name: short(p.name),
					arguments: Object.fromEntries(
						TOOL_KEYS.map((key) => [key, short(args[key])]),
					),
				},
			];
		});
	}
	return {
		type: entry.type,
		id: entry.id,
		timestamp: entry.timestamp,
		message: {
			role: message.role,
			content,
			toolCallId: short(message.toolCallId),
			toolName: short(message.toolName),
		},
	};
}

function* summaryEntries(path: string): Generator<unknown> {
	let pendingResults = 0;
	for (const line of lines(path)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		const entry = projectEntry(parsed);
		const e = record(entry);
		if (e.type === "message") {
			const m = record(e.message);
			if (m.role === "toolResult" && m.toolCallId) {
				// The canonical converter folds consecutive results into one user
				// row. Bound that row too, not only the number of rows in a page.
				if (++pendingResults > MAX_PARTS)
					throw new Error("Pi primer has too many consecutive tool results");
			} else if (m.role === "user" || m.role === "assistant")
				pendingResults = 0;
		}
		yield entry;
	}
}

function* sessionFiles(directory: string, nested: boolean): Generator<string> {
	let dir: ReturnType<typeof opendirSync>;
	try {
		dir = opendirSync(directory);
	} catch {
		return;
	}
	try {
		while (true) {
			const entry = dir.readSync();
			if (!entry) break;
			const path = join(directory, entry.name);
			if (entry.isFile() && entry.name.endsWith(".jsonl")) yield path;
			else if (nested && entry.isDirectory()) yield* sessionFiles(path, false);
		}
	} finally {
		dir.closeSync();
	}
}

/** Discovery reads only one bounded header per file, never listAll's transcript previews. */
function findSession(
	directory: string,
	nested: boolean,
	sessionId: string,
): string | null {
	for (const path of sessionFiles(directory, nested)) {
		try {
			for (const line of lines(path)) {
				const header = record(JSON.parse(line));
				if (header.type === "session" && header.id === sessionId) return path;
				break;
			}
		} catch {
			/* Unreadable or malformed headers are not candidates. */
		}
	}
	return null;
}

export function createPiPrimerRawProviderFactory(
	deps: PiPrimerRawProviderDeps = {},
): (sessionId: string) => Promise<RawMessageProvider | null> {
	return async (sessionId) => {
		try {
			let directory = deps.sessionDir;
			if (!directory) {
				const mod = (await resolvePiCodingAgentModule()) as {
					getAgentDir?: () => string;
				};
				if (!mod.getAgentDir) return null;
				directory = join(mod.getAgentDir(), "sessions");
			}
			const path = findSession(directory, !deps.sessionDir, sessionId);
			if (!path) return null;
			return {
				readMessages() {
					throw new Error("Pi primer history requires bounded pages");
				},
				readMessagePage(after, limit, watermark) {
					// Re-open per page: no file descriptor survives early visitor
					// termination, and no earlier page or tool output is retained.
					return convertEntriesToRawMessagePage(
						summaryEntries(path),
						after,
						Math.min(50, limit),
						watermark,
					);
				},
			};
		} catch {
			return null;
		}
	};
}
