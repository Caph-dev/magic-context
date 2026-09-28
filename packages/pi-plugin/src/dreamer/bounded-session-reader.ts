import { closeSync, opendirSync, openSync, readSync } from "node:fs";
import { join } from "node:path";

// Reject oversized entries rather than silently shifting persisted ordinals.
const MAX_ENTRY_BYTES = 1024 * 1024;

export function* lines(path: string): Generator<string> {
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
					throw new Error("Pi session entry exceeds bounded reader capacity");
				yield Buffer.concat([pending, buffer.subarray(start, i)]).toString(
					"utf8",
				);
				pending = Buffer.alloc(0);
				start = i + 1;
			}
			if (pending.length + bytes - start > MAX_ENTRY_BYTES)
				throw new Error("Pi session entry exceeds bounded reader capacity");
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

export function* sessionFiles(
	directory: string,
	nested: boolean,
): Generator<string> {
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
export function findSession(
	directory: string,
	nested: boolean,
	sessionId: string,
): string | null {
	for (const header of sessionHeaders(directory, nested)) {
		if (header.id === sessionId) return header.path;
	}
	return null;
}

export function* sessionHeaders(
	directory: string,
	nested: boolean,
): Generator<Record<string, unknown> & { path: string }> {
	for (const path of sessionFiles(directory, nested)) {
		try {
			for (const line of lines(path)) {
				const header = record(JSON.parse(line));
				if (header.type === "session") yield { ...header, path };
				break;
			}
		} catch {
			/* Unreadable or malformed headers are not candidates. */
		}
	}
}

export function* sessionEntries(path: string): Generator<unknown> {
	for (const line of lines(path)) {
		try {
			yield JSON.parse(line);
		} catch {
			/* Match Pi's tolerant JSONL parser. */
		}
	}
}
