import type { RawMessageOrdinalAnchor } from "../hooks/magic-context/read-session-raw";
import {
    assertOpenCodeStoreGeneration,
    resolveOpenCodeDbPath,
    sourceOpenCodeDatabaseFilename,
} from "../shared/opencode-db-path";
import { Database } from "../shared/sqlite";

/** Compatibility export; shared/opencode-db-path.ts is the single filename authority. */
export function sourceDatabaseFilename(
    channel: string,
    env: NodeJS.ProcessEnv = process.env,
): string {
    return sourceOpenCodeDatabaseFilename("v2", channel, env);
}

/** GA data root resolved by the shared host-generation-aware resolver. */
export function gaDatabasePath(
    dataHome: string,
    channel = "latest",
    env: NodeJS.ProcessEnv = process.env,
): string {
    return resolveOpenCodeDbPath("v2", { dataHome, channel, env }).path;
}

// GA core-session-message.excerpt.js and oc-audit-7a31b5c0f7.md:166-184.
export type MessageType =
    | "agent-switched"
    | "model-switched"
    | "location-switched"
    | "user"
    | "synthetic"
    | "system"
    | "skill"
    | "shell"
    | "assistant"
    | "compaction"
    | "idle";

export const RAW_MESSAGE_TYPES = [
    "user",
    "synthetic",
    "assistant",
    "skill",
    "shell",
    "system",
] as const satisfies readonly MessageType[];

const RAW_MESSAGE_TYPE_PARAMETERS = RAW_MESSAGE_TYPES.map(() => "?").join(", ");

export const V2_MESSAGE_PAGE_SQL = `WITH bounds AS (
    SELECT
        CASE WHEN ? = 0 THEN -1 ELSE COALESCE((
            SELECT seq FROM session_message
            WHERE session_id = ? AND type IN (${RAW_MESSAGE_TYPE_PARAMETERS})
            ORDER BY seq ASC LIMIT 1 OFFSET ?
        ), -1) END AS after_seq,
        COALESCE((
            SELECT seq FROM session_message
            WHERE session_id = ? AND type IN (${RAW_MESSAGE_TYPE_PARAMETERS})
            ORDER BY seq ASC LIMIT 1 OFFSET ?
        ), ?) AS watermark_seq
)
SELECT id, session_id, type, seq, time_created, data FROM session_message, bounds
WHERE session_id = ?
  AND type IN (${RAW_MESSAGE_TYPE_PARAMETERS})
  AND seq > bounds.after_seq
  AND seq <= bounds.watermark_seq
ORDER BY seq ASC LIMIT ?`;
export interface MessageData {
    [key: string]: unknown;
    content?: Array<Record<string, unknown>>;
    text?: string;
    finish?: string;
    outcome?: "succeeded" | "failed" | "interrupted";
    error?: unknown;
    model?: { id: string; providerID: string; variant?: string };
    tokens?: {
        input: number;
        output: number;
        reasoning: number;
        cache: { read: number; write: number };
    };
    time?: { created: number; completed?: number; streamed?: number };
}
export interface IdleData extends MessageData {
    outcome: "succeeded" | "failed" | "interrupted";
}
export interface CompactionData extends MessageData {
    status: string;
    summary?: string;
    recent?: string;
}
export interface StoreRow<T extends MessageType = MessageType> {
    id: string;
    session_id: string;
    type: T;
    seq: number;
    time_created?: number;
    data: T extends "idle" ? IdleData : T extends "compaction" ? CompactionData : MessageData;
}
interface RawRow extends Omit<StoreRow, "data"> {
    data: string;
}

export const V2_STORE_READER_DEBUG_COUNTER_KEY = "magic-context.v2.store-reader-debug";

export interface V2StoreReaderDebugOperation {
    calls: number;
    decodedRows: number;
    maxDecodedRows: number;
}

export interface V2StoreReaderDebugQuery {
    operation: string;
    statement: string;
    rows: number;
    elapsedMs: number;
}

export interface V2StoreReaderDebugCounters {
    decodedRows: number;
    operations: Record<string, V2StoreReaderDebugOperation>;
    openReaders: number;
    maxOpenReaders: number;
    readersOpened: number;
    readersClosed: number;
    queries?: V2StoreReaderDebugQuery[];
    captureQueries?: boolean;
}

export interface V2MessageOrdinalAnchor {
    timeCreated: number;
    id: string;
}

export interface V2MessageOrdinalEntry extends V2MessageOrdinalAnchor {
    contributesOrdinal: boolean;
    hasValidInfo: boolean;
}

const debugSymbol = Symbol.for(V2_STORE_READER_DEBUG_COUNTER_KEY);
const debugGlobal = globalThis as typeof globalThis & {
    [key: symbol]: V2StoreReaderDebugCounters | undefined;
};

const QUERY_STATEMENTS: Readonly<Record<string, string>> = {
    messagePage: V2_MESSAGE_PAGE_SQL,
    messageCount:
        "SELECT COUNT(*) AS count FROM session_message WHERE session_id = ? AND type IN (?)",
    storedMessageCount: "SELECT COUNT(*) AS count FROM session_message WHERE session_id = ?",
    messageById:
        "SELECT id, session_id, type, seq, time_created, data FROM session_message WHERE session_id = ? AND id = ? AND type IN (?) LIMIT 1",
    messageExistsById:
        "SELECT 1 FROM session_message WHERE id = ? AND session_id = ? AND type IN (?) LIMIT 1",
    messageOrdinalById: `WITH target AS (
    SELECT seq FROM session_message WHERE session_id = ? AND id = ? AND type IN (?) LIMIT 1
)
SELECT (SELECT COUNT(*) FROM session_message WHERE session_id = ? AND type IN (?) AND seq <= target.seq) AS ordinal FROM target`,
    messageIdOrdinals:
        "SELECT id FROM session_message WHERE session_id = ? AND type IN (?) ORDER BY seq ASC LIMIT ? OFFSET ?",
    messageOrdinalPage:
        "SELECT id, type, seq, json_valid(data) AS valid FROM session_message WHERE session_id = ? AND seq > ? ORDER BY seq ASC, id ASC LIMIT ?",
    rawRowsThrough:
        "SELECT id, session_id, type, seq, time_created, data FROM session_message WHERE session_id = ? AND type IN (?) AND seq <= ? ORDER BY seq DESC LIMIT ?",
};

function debugCounters(): V2StoreReaderDebugCounters {
    const counters = (debugGlobal[debugSymbol] ??= {
        decodedRows: 0,
        operations: {},
        openReaders: 0,
        maxOpenReaders: 0,
        readersOpened: 0,
        readersClosed: 0,
    });
    counters.openReaders ??= 0;
    counters.maxOpenReaders ??= 0;
    counters.readersOpened ??= 0;
    counters.readersClosed ??= 0;
    return counters;
}

function returnedRowCount(value: unknown): number {
    if (Array.isArray(value)) return value.length;
    if (value === null || value === undefined || value === false) return 0;
    return 1;
}

function trackDecodeOperation<T>(name: string, operation: () => T): T {
    const counters = debugCounters();
    const before = counters.decodedRows;
    const started = performance.now();
    let value: T | undefined;
    try {
        value = operation();
        return value;
    } finally {
        const decodedRows = counters.decodedRows - before;
        const current = counters.operations[name] ?? {
            calls: 0,
            decodedRows: 0,
            maxDecodedRows: 0,
        };
        current.calls += 1;
        current.decodedRows += decodedRows;
        current.maxDecodedRows = Math.max(current.maxDecodedRows, decodedRows);
        counters.operations[name] = current;
        const statement = QUERY_STATEMENTS[name];
        if (counters.captureQueries && statement) {
            (counters.queries ??= []).push({
                operation: name,
                statement,
                rows: returnedRowCount(value),
                elapsedMs: performance.now() - started,
            });
        }
    }
}

export function getV2StoreReaderDebugCounters(): V2StoreReaderDebugCounters {
    const counters = debugCounters();
    return {
        decodedRows: counters.decodedRows,
        operations: Object.fromEntries(
            Object.entries(counters.operations).map(([name, operation]) => [
                name,
                { ...operation },
            ]),
        ),
        openReaders: counters.openReaders,
        maxOpenReaders: counters.maxOpenReaders,
        readersOpened: counters.readersOpened,
        readersClosed: counters.readersClosed,
        ...(counters.captureQueries
            ? {
                  captureQueries: true,
                  queries: counters.queries?.map((query) => ({ ...query })) ?? [],
              }
            : {}),
    };
}

export function resetV2StoreReaderDebugCounters(options: { captureQueries?: boolean } = {}): void {
    debugGlobal[debugSymbol] = {
        decodedRows: 0,
        operations: {},
        openReaders: 0,
        maxOpenReaders: 0,
        readersOpened: 0,
        readersClosed: 0,
        ...(options.captureQueries ? { captureQueries: true, queries: [] } : {}),
    };
}

function decode(row: RawRow): StoreRow {
    debugCounters().decodedRows += 1;
    const data: unknown = JSON.parse(row.data);
    if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new Error(`Invalid session_message data at seq ${row.seq}`);
    }
    if (
        row.type === "idle" &&
        !["succeeded", "failed", "interrupted"].includes(String((data as IdleData).outcome))
    ) {
        throw new Error(`Invalid idle outcome at seq ${row.seq}`);
    }
    return { ...row, data: data as MessageData };
}

/** Opens an existing store read-only; missing/corrupt stores propagate errors, never an empty history. */
export class V2StoreReader {
    private readonly db: Database;
    private closed = false;
    constructor(path: string) {
        this.db = new Database(path, { readonly: true, fileMustExist: true });
        try {
            assertOpenCodeStoreGeneration(this.db, "v2", path);
        } catch (error) {
            this.db.close();
            throw error;
        }
        const counters = debugCounters();
        counters.openReaders += 1;
        counters.readersOpened += 1;
        counters.maxOpenReaders = Math.max(counters.maxOpenReaders, counters.openReaders);
    }
    close(): void {
        if (this.closed) return;
        this.closed = true;
        try {
            this.db.close();
        } finally {
            const counters = debugCounters();
            counters.openReaders = Math.max(0, counters.openReaders - 1);
            counters.readersClosed += 1;
        }
    }

    /** Exclusive cursor, ascending seq. IDs are not chronological in the v2 store. */
    page(
        sessionID: string,
        options: {
            after?: number;
            through?: number;
            limit?: number;
            type?: MessageType;
        } = {},
    ): { rows: StoreRow[]; cursor: number | undefined } {
        return trackDecodeOperation("page", () => {
            const limit = options.limit ?? 100;
            if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000)
                throw new Error("Invalid page limit");
            const after = options.after ?? -1;
            if (!Number.isSafeInteger(after)) throw new Error("Invalid seq cursor");
            if (options.through !== undefined && !Number.isSafeInteger(options.through))
                throw new Error("Invalid seq upper bound");
            const predicates = ["session_id = ?", "seq > ?"];
            const parameters: Array<string | number> = [sessionID, after];
            if (options.through !== undefined) {
                predicates.push("seq <= ?");
                parameters.push(options.through);
            }
            if (options.type) {
                predicates.push("type = ?");
                parameters.push(options.type);
            }
            const rows = (
                this.db
                    .prepare(`SELECT id, session_id, type, seq, time_created, data FROM session_message
                        WHERE ${predicates.join(" AND ")}
                        ORDER BY seq ASC LIMIT ?`)
                    .all(...parameters, limit) as RawRow[]
            ).map(decode);
            return { rows, cursor: rows.at(-1)?.seq };
        });
    }

    /**
     * Read one page from the contiguous raw-message ordinal space. OpenCode seq
     * includes non-conversation rows, so the CTE maps the two ordinal boundaries
     * to seq values without hydrating any row outside the requested page.
     */
    messagePage(
        sessionID: string,
        afterOrdinal: number,
        limit: number,
        finalWatermark: number,
        after?: RawMessageOrdinalAnchor,
    ): StoreRow[] {
        return trackDecodeOperation("messagePage", () => {
            if (!Number.isSafeInteger(afterOrdinal) || afterOrdinal < 0)
                throw new Error("Invalid raw-message ordinal cursor");
            if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000)
                throw new Error("Invalid page limit");
            if (!Number.isSafeInteger(finalWatermark) || finalWatermark < 0)
                throw new Error("Invalid raw-message watermark");
            const pageSize = Math.min(limit, finalWatermark - afterOrdinal);
            if (pageSize <= 0) return [];
            // A carried row id maps to seq with a point lookup, not another
            // ordinal OFFSET. The remaining ordinal count bounds the watermark.
            if (after) {
                const anchor = this.db
                    .prepare("SELECT seq FROM session_message WHERE session_id = ? AND id = ?")
                    .get(sessionID, after.id) as { seq: number } | undefined;
                if (anchor) {
                    return (
                        this.db
                            .prepare(`SELECT id, session_id, type, seq, time_created, data
                        FROM session_message WHERE session_id = ? AND seq > ?
                        AND type IN (${RAW_MESSAGE_TYPE_PARAMETERS}) ORDER BY seq ASC LIMIT ?`)
                            .all(sessionID, anchor.seq, ...RAW_MESSAGE_TYPES, pageSize) as RawRow[]
                    ).map(decode);
                }
            }
            const maximumSeq = Number.MAX_SAFE_INTEGER;
            const rows = this.db
                .prepare(V2_MESSAGE_PAGE_SQL)
                .all(
                    afterOrdinal,
                    sessionID,
                    ...RAW_MESSAGE_TYPES,
                    Math.max(0, afterOrdinal - 1),
                    sessionID,
                    ...RAW_MESSAGE_TYPES,
                    finalWatermark - 1,
                    maximumSeq,
                    sessionID,
                    ...RAW_MESSAGE_TYPES,
                    pageSize,
                ) as RawRow[];
            return rows.map(decode);
        });
    }

    messageCount(sessionID: string): number {
        return trackDecodeOperation("messageCount", () => {
            const rawTypes = RAW_MESSAGE_TYPES.map(() => "?").join(", ");
            const row = this.db
                .prepare(
                    `SELECT COUNT(*) AS count FROM session_message
                     WHERE session_id = ? AND type IN (${rawTypes})`,
                )
                .get(sessionID, ...RAW_MESSAGE_TYPES) as { count?: number } | undefined;
            return typeof row?.count === "number" ? row.count : 0;
        });
    }

    /**
     * One page of host sessions with the directory each was created in, in
     * ascending id order after `afterSessionID` (exclusive; null starts at the
     * beginning). Feeds the session-to-project backfill.
     */
    sessionDirectoryPage(
        afterSessionID: string | null,
        limit: number,
    ): Array<{ sessionId: string; directory: string }> {
        const rows = this.db
            .prepare(
                `SELECT id, COALESCE(directory, '') AS directory FROM session_v2
                 WHERE id > ? ORDER BY id ASC LIMIT ?`,
            )
            .all(afterSessionID ?? "", limit) as Array<{ id: string; directory: string }>;
        return rows.map((row) => ({ sessionId: row.id, directory: row.directory }));
    }

    latestMessageTime(sessionID: string): number | undefined {
        const row = this.db
            .prepare("SELECT MAX(time_created) AS time FROM session_message WHERE session_id = ?")
            .get(sessionID) as { time: number | null } | undefined;
        return row?.time ?? undefined;
    }

    storedMessageCount(sessionID: string): number {
        return trackDecodeOperation("storedMessageCount", () => {
            const row = this.db
                .prepare("SELECT COUNT(*) AS count FROM session_message WHERE session_id = ?")
                .get(sessionID) as { count?: number } | undefined;
            return typeof row?.count === "number" ? row.count : 0;
        });
    }

    messageById(sessionID: string, id: string): StoreRow | null {
        return trackDecodeOperation("messageById", () => {
            const rawTypes = RAW_MESSAGE_TYPES.map(() => "?").join(", ");
            const row = this.db
                .prepare(
                    `SELECT id, session_id, type, seq, time_created, data FROM session_message
                     WHERE session_id = ? AND id = ? AND type IN (${rawTypes}) LIMIT 1`,
                )
                .get(sessionID, id, ...RAW_MESSAGE_TYPES) as RawRow | undefined;
            return row ? decode(row) : null;
        });
    }

    messageExistsById(sessionID: string, id: string): boolean {
        return trackDecodeOperation("messageExistsById", () => {
            const rawTypes = RAW_MESSAGE_TYPES.map(() => "?").join(", ");
            const row = this.db
                .prepare(
                    `SELECT 1 FROM session_message
                     WHERE id = ? AND session_id = ? AND type IN (${rawTypes}) LIMIT 1`,
                )
                .get(id, sessionID, ...RAW_MESSAGE_TYPES);
            return row != null;
        });
    }

    messageOrdinalById(sessionID: string, id: string): number | null {
        return trackDecodeOperation("messageOrdinalById", () => {
            const rawTypes = RAW_MESSAGE_TYPES.map(() => "?").join(", ");
            const row = this.db
                .prepare(
                    `WITH target AS (
                        SELECT seq FROM session_message
                        WHERE session_id = ? AND id = ? AND type IN (${rawTypes})
                        LIMIT 1
                    )
                    SELECT (
                        SELECT COUNT(*) FROM session_message
                        WHERE session_id = ?
                          AND type IN (${rawTypes})
                          AND seq <= target.seq
                    ) AS ordinal
                    FROM target`,
                )
                .get(sessionID, id, ...RAW_MESSAGE_TYPES, sessionID, ...RAW_MESSAGE_TYPES) as
                | { ordinal?: number }
                | undefined;
            return typeof row?.ordinal === "number" ? row.ordinal : null;
        });
    }

    messageIdOrdinals(
        sessionID: string,
        fromOrdinal: number,
        toOrdinal: number,
    ): Map<string, number> {
        return trackDecodeOperation("messageIdOrdinals", () => {
            if (!Number.isSafeInteger(fromOrdinal) || fromOrdinal < 1)
                throw new Error("Invalid raw-message range start");
            if (!Number.isSafeInteger(toOrdinal) || toOrdinal < fromOrdinal)
                throw new Error("Invalid raw-message range end");
            const rawTypes = RAW_MESSAGE_TYPES.map(() => "?").join(", ");
            const rows = this.db
                .prepare(
                    `SELECT id FROM session_message
                     WHERE session_id = ? AND type IN (${rawTypes})
                     ORDER BY seq ASC LIMIT ? OFFSET ?`,
                )
                .all(
                    sessionID,
                    ...RAW_MESSAGE_TYPES,
                    toOrdinal - fromOrdinal + 1,
                    fromOrdinal - 1,
                ) as Array<{ id: string }>;
            return new Map(rows.map((row, index) => [row.id, fromOrdinal + index]));
        });
    }

    messageOrdinalPage(
        sessionID: string,
        after: V2MessageOrdinalAnchor | null,
        limit: number,
    ): V2MessageOrdinalEntry[] {
        return trackDecodeOperation("messageOrdinalPage", () => {
            if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000)
                throw new Error("Invalid page limit");
            const rows = (
                after
                    ? this.db
                          .prepare(
                              `SELECT id, type, seq, json_valid(data) AS valid
                               FROM session_message
                               WHERE session_id = ? AND (seq > ? OR (seq = ? AND id > ?))
                               ORDER BY seq ASC, id ASC LIMIT ?`,
                          )
                          .all(sessionID, after.timeCreated, after.timeCreated, after.id, limit)
                    : this.db
                          .prepare(
                              `SELECT id, type, seq, json_valid(data) AS valid
                               FROM session_message
                               WHERE session_id = ?
                               ORDER BY seq ASC, id ASC LIMIT ?`,
                          )
                          .all(sessionID, limit)
            ) as Array<{ id: string; type: MessageType; seq: number; valid: number }>;
            const rawTypes = new Set<MessageType>(RAW_MESSAGE_TYPES);
            return rows.map((row) => ({
                id: row.id,
                timeCreated: row.seq,
                contributesOrdinal: rawTypes.has(row.type),
                hasValidInfo: row.valid === 1,
            }));
        });
    }

    range(sessionID: string, after: number, through: number): StoreRow[] {
        return trackDecodeOperation("range", () =>
            through <= after ? [] : this.all(sessionID, after, undefined, through),
        );
    }

    /**
     * One stamp per row with `after < seq <= through`, keyed by seq, built without
     * decoding any row: the row id, its update time and the byte length of its data.
     * A row deleted, added, or rewritten in place to a different size or with a new
     * update time changes its stamp; comparing stamps row by row, not an aggregate,
     * means two such changes cannot cancel out.
     */
    spanRowStamps(sessionID: string, after: number, through: number): Map<number, string> {
        if (!Number.isSafeInteger(after) || !Number.isSafeInteger(through))
            throw new Error("Invalid seq span");
        const rows = this.db
            .prepare(
                `SELECT seq, id, time_updated AS updated, length(CAST(data AS BLOB)) AS bytes
                 FROM session_message WHERE session_id = ? AND seq > ? AND seq <= ?
                 ORDER BY seq ASC`,
            )
            .all(sessionID, after, through) as Array<{
            seq: number;
            id: string;
            updated: number | null;
            bytes: number | null;
        }>;
        const stamps = new Map<number, string>();
        for (const row of rows)
            stamps.set(row.seq, `${row.id}\u0000${row.updated ?? ""}\u0000${row.bytes ?? ""}`);
        return stamps;
    }

    /** Conversational rows at or before `throughSeq`, newest first. */
    rawRowsThrough(sessionID: string, throughSeq: number, limit: number): StoreRow[] {
        return trackDecodeOperation("rawRowsThrough", () => {
            if (!Number.isSafeInteger(throughSeq)) throw new Error("Invalid seq upper bound");
            if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000)
                throw new Error("Invalid page limit");
            const rawTypes = RAW_MESSAGE_TYPES.map(() => "?").join(", ");
            return (
                this.db
                    .prepare(
                        `SELECT id, session_id, type, seq, time_created, data FROM session_message
                         WHERE session_id = ? AND type IN (${rawTypes}) AND seq <= ?
                         ORDER BY seq DESC LIMIT ?`,
                    )
                    .all(sessionID, ...RAW_MESSAGE_TYPES, throughSeq, limit) as RawRow[]
            ).map(decode);
        });
    }

    sequenceForId(sessionID: string, id: string | null | undefined): number | undefined {
        if (!id) return undefined;
        const row = this.db
            .prepare("SELECT seq FROM session_message WHERE session_id = ? AND id = ? LIMIT 1")
            .get(sessionID, id) as { seq?: number } | undefined;
        return typeof row?.seq === "number" ? row.seq : undefined;
    }

    latestSequenceForIds(sessionID: string, ids: readonly string[]): number {
        let latest = -1;
        for (let offset = 0; offset < ids.length; offset += 500) {
            const chunk = ids.slice(offset, offset + 500);
            const row = this.db
                .prepare(
                    `SELECT MAX(seq) AS seq FROM session_message
                     WHERE session_id = ? AND id IN (${chunk.map(() => "?").join(", ")})`,
                )
                .get(sessionID, ...chunk) as { seq?: number | null } | undefined;
            if (typeof row?.seq === "number") latest = Math.max(latest, row.seq);
        }
        return latest;
    }

    private compactionByStatus(
        sessionID: string,
        status: "completed" | "running",
    ): StoreRow<"compaction"> | undefined {
        const row = this.db
            .prepare(`SELECT id, session_id, type, seq, time_created, data FROM session_message
                WHERE session_id = ? AND type = 'compaction'
                  AND json_extract(data, '$.status') = ?
                ORDER BY seq DESC LIMIT 1`)
            .get(sessionID, status) as RawRow | undefined;
        return row ? (decode(row) as StoreRow<"compaction">) : undefined;
    }

    // Only a completed compaction is a stable history boundary; a running or
    // failed compaction must not hide rows from the active context.
    latestCompaction(sessionID: string): StoreRow<"compaction"> | undefined {
        return trackDecodeOperation("latestCompaction", () =>
            this.compactionByStatus(sessionID, "completed"),
        );
    }

    latestRunningCompaction(sessionID: string): StoreRow<"compaction"> | undefined {
        return trackDecodeOperation("latestRunningCompaction", () =>
            this.compactionByStatus(sessionID, "running"),
        );
    }

    idleRows(sessionID: string, after = -1): StoreRow<"idle">[] {
        return trackDecodeOperation(
            "idleRows",
            () => this.all(sessionID, after, "idle") as StoreRow<"idle">[],
        );
    }

    earliestSequence(sessionID: string): number | undefined {
        const row = this.db
            .prepare("SELECT MIN(seq) AS seq FROM session_message WHERE session_id = ?")
            .get(sessionID) as { seq: number | null } | undefined;
        return typeof row?.seq === "number" ? row.seq : undefined;
    }

    latestSequence(sessionID: string): number {
        const row = this.db
            .prepare("SELECT MAX(seq) AS seq FROM session_message WHERE session_id = ?")
            .get(sessionID) as { seq: number | null } | undefined;
        return typeof row?.seq === "number" ? row.seq : -1;
    }

    assistantSince(sessionID: string, afterSeq: number): StoreRow<"assistant">[] {
        return trackDecodeOperation("assistantSince", () => {
            const rows = this.db
                .prepare(`SELECT id, session_id, type, seq, time_created, data FROM session_message
                    WHERE session_id = ? AND type = 'assistant' AND seq > ?
                    ORDER BY seq ASC`)
                .all(sessionID, afterSeq) as RawRow[];
            return rows.map((row) => decode(row) as StoreRow<"assistant">);
        });
    }

    latestAssistant(sessionID: string): StoreRow<"assistant"> | undefined {
        return trackDecodeOperation("latestAssistant", () => {
            const row = this.db
                .prepare(`SELECT id, session_id, type, seq, time_created, data FROM session_message
                    WHERE session_id = ? AND type = 'assistant'
                    ORDER BY seq DESC LIMIT 1`)
                .get(sessionID) as RawRow | undefined;
            return row ? (decode(row) as StoreRow<"assistant">) : undefined;
        });
    }

    latestIdle(sessionID: string): StoreRow<"idle"> | undefined {
        return trackDecodeOperation("latestIdle", () => {
            const row = this.db
                .prepare(`SELECT id, session_id, type, seq, time_created, data FROM session_message
                    WHERE session_id = ? AND type = 'idle'
                    ORDER BY seq DESC LIMIT 1`)
                .get(sessionID) as RawRow | undefined;
            return row ? (decode(row) as StoreRow<"idle">) : undefined;
        });
    }

    /** Include the completed checkpoint itself, matching the host history cut. */
    window(sessionID: string): StoreRow[] {
        return trackDecodeOperation("window", () =>
            this.db
                .transaction(() => {
                    const cut = this.latestCompaction(sessionID);
                    return this.all(sessionID, cut ? cut.seq - 1 : -1);
                })
                .deferred(),
        );
    }

    /**
     * Read every retained row only for conversions between store generations and
     * explicit diagnostics, because those operations need every part payload.
     * Context passes use messagePage, messageCount, and range instead.
     */
    history(sessionID: string): StoreRow[] {
        return trackDecodeOperation("history", () => this.all(sessionID, -1));
    }

    private all(
        sessionID: string,
        after: number,
        type?: MessageType,
        through?: number,
    ): StoreRow[] {
        const rows: StoreRow[] = [];
        for (;;) {
            const page = this.page(sessionID, { after, through, type });
            rows.push(...page.rows);
            if (page.rows.length < 100 || page.cursor === undefined) return rows;
            after = page.cursor;
        }
    }
}
