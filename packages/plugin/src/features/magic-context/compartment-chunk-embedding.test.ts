import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as formatting from "../../hooks/magic-context/read-session-formatting";
import { estimateTokens, formatBlock } from "../../hooks/magic-context/read-session-formatting";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    _resetCompartmentChunkSearchCacheForTests,
    buildCanonicalChunkTextFromFts,
    CHUNK_WINDOW_SAFETY_RATIO,
    canonicalizeInMemoryChunkTextForEmbedding,
    chunkCanonicalText,
    chunkEmbeddingWindowsAreCurrent,
    countSessionCompartmentEmbedCoverage,
    countSessionCompartmentEmbedCoveragePolite,
    countUnembeddedSessionCompartments,
    countUnembeddedSessionCompartmentsPolite,
    loadCompartmentChunkEmbeddingsForSearch,
    loadUnembeddedCompartmentChunkCandidates,
    loadUnembeddedSessionChunkCandidates,
    loadUnembeddedSessionChunkCandidatesPolite,
    recordChunkEmbedBackoff,
    replaceCompartmentChunkEmbeddings,
} from "./compartment-chunk-embedding";
import { embedAndStoreCompartmentChunks } from "./compartment-embedding";
import { appendCompartments, getCompartments } from "./compartment-storage";
import type { EmbeddingProvider, EmbeddingPurpose } from "./memory/embedding-provider";
import { backfillMessageFtsRowidMapBatch, recordMessageFtsRowid } from "./message-fts-rowid-map";
import { runMigrations } from "./migrations";
import {
    _resetProjectEmbeddingRegistryForTests,
    _setTestProviderFactoryForProject,
    embedSessionCompartmentChunks,
    getProjectEmbeddingSnapshot,
    registerProjectEmbedding,
} from "./project-embedding-registry";
import { recordSessionProjectIdentity } from "./session-project-storage";
import { initializeDatabase } from "./storage-db";
import { clearSession } from "./storage-meta-session";

class CapturingEmbeddingProvider implements EmbeddingProvider {
    readonly modelId = "mock:model";
    readonly maxInputTokens = 10_000;
    readonly texts: string[];

    constructor(texts: string[]) {
        this.texts = texts;
    }

    async initialize(): Promise<boolean> {
        return true;
    }

    async embed(
        text: string,
        _signal?: AbortSignal,
        _purpose?: EmbeddingPurpose,
    ): Promise<Float32Array> {
        this.texts.push(text);
        return new Float32Array([1, 0]);
    }

    async embedBatch(
        texts: string[],
        _signal?: AbortSignal,
        _purpose?: EmbeddingPurpose,
    ): Promise<Float32Array[]> {
        this.texts.push(...texts);
        return texts.map(() => new Float32Array([1, 0]));
    }

    async dispose(): Promise<void> {}

    isLoaded(): boolean {
        return true;
    }
}

function createDb(filename = ":memory:"): Database {
    const db = new Database(filename);
    initializeDatabase(db);
    runMigrations(db);
    backfillMessageFtsRowidMapBatch(db);
    return db;
}

function insertFtsRow(
    db: Database,
    sessionId: string,
    ordinal: number,
    role: "user" | "assistant",
    content: string,
): void {
    const result = db
        .prepare(
            "INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content) VALUES (?, ?, ?, ?, ?)",
        )
        .run(sessionId, ordinal, `${role}-${ordinal}`, role, content) as {
        lastInsertRowid: number | bigint;
    };
    recordMessageFtsRowid(db, sessionId, ordinal, result.lastInsertRowid);
}

function currentChunkModelId(projectIdentity: string): string {
    return getProjectEmbeddingSnapshot(projectIdentity)?.chunkModelId ?? "off";
}

describe("compartment chunk embedding core", () => {
    test("FTS reconstruction and in-memory stripping produce the same canonical bytes", () => {
        const db = createDb();
        try {
            insertFtsRow(db, "ses-canon", 1, "user", "How should semantic search work?");
            insertFtsRow(db, "ses-canon", 2, "user", "Keep adjacent user lines grouped.");
            insertFtsRow(db, "ses-canon", 3, "assistant", "Embed raw compartment chunks.");

            const fromFts = buildCanonicalChunkTextFromFts(db, "ses-canon", 1, 4);
            const fromMemory = canonicalizeInMemoryChunkTextForEmbedding(
                [
                    "[1-2] U: How should semantic search work? / Keep adjacent user lines grouped.",
                    "[3-4] A: Embed raw compartment chunks. / TC: read(packages/plugin/src/features/magic-context/search.ts)",
                ].join("\n"),
                1,
                4,
            );

            expect(fromFts).toBe(fromMemory);
            expect(fromFts).toBe(
                "[1-2] U: How should semantic search work? / Keep adjacent user lines grouped.\n[3] A: Embed raw compartment chunks.",
            );

            const clippedFromFts = buildCanonicalChunkTextFromFts(db, "ses-canon", 2, 3);
            const clippedFromMemory = canonicalizeInMemoryChunkTextForEmbedding(
                [
                    "[1-2] U: How should semantic search work? / Keep adjacent user lines grouped.",
                    "[3-4] A: Embed raw compartment chunks. / TC: read(packages/plugin/src/features/magic-context/search.ts)",
                ].join("\n"),
                2,
                3,
            );
            expect(clippedFromMemory).toBe(clippedFromFts);
            expect(clippedFromFts).toBe(
                "[2] U: Keep adjacent user lines grouped.\n[3] A: Embed raw compartment chunks.",
            );
        } finally {
            closeQuietly(db);
        }
    });

    test("chunker uses one whole-compartment row when it fits and windows on line boundaries otherwise", () => {
        const text = [
            "[1] U: alpha beta gamma",
            "[2] A: delta epsilon zeta",
            "[3] U: eta theta iota",
        ].join("\n");

        const whole = chunkCanonicalText(text, 1, 3, 10_000);
        expect(whole).toHaveLength(1);
        expect(whole[0]).toMatchObject({ windowIndex: 0, startOrdinal: 1, endOrdinal: 3 });
        expect(whole[0]?.text).toBe(text);

        // Budget that fits any single line but not two together → one window per
        // line on line boundaries. effectiveMax = floor(budget * 0.9); each line is
        // ~7 tokens, so a budget of ~9 (effective 8) holds exactly one line.
        const perLineBudget = Math.ceil(
            (estimateTokens("[1] U: alpha beta gamma") + 1) / CHUNK_WINDOW_SAFETY_RATIO,
        );
        const windowed = chunkCanonicalText(text, 1, 3, perLineBudget);
        expect(windowed.map((window) => window.windowIndex)).toEqual([0, 1, 2]);
        expect(windowed.map((window) => [window.startOrdinal, window.endOrdinal])).toEqual([
            [1, 1],
            [2, 2],
            [3, 3],
        ]);
    });

    test("chunker rejects canonical line ranges outside the compartment", () => {
        expect(() => chunkCanonicalText("[1-5] A: foreign text", 2, 4, 10_000)).toThrow(
            "Canonical chunk range 1-5 lies outside compartment 2-4",
        );
    });

    test("every window stays under the safety-margined budget (never exceeds the provider ceiling)", () => {
        // Many short lines so windowing is driven by the token budget, not by
        // line count. With a ceiling of 200, the effective budget is 180 (90%),
        // leaving headroom for cross-tokenizer drift below the hard ceiling.
        const maxInputTokens = 200;
        const effective = Math.floor(maxInputTokens * CHUNK_WINDOW_SAFETY_RATIO);
        const lines = Array.from(
            { length: 60 },
            (_, i) => `[${i + 1}] U: lorem ipsum dolor sit amet consectetur adipiscing elit ${i}`,
        );
        const windows = chunkCanonicalText(lines.join("\n"), 1, 60, maxInputTokens);
        expect(windows.length).toBeGreaterThan(1);
        for (const window of windows) {
            // Each window's own estimate stays at/under the 90% budget, so the
            // real provider count (which drifts only slightly) stays under the
            // configured ceiling.
            expect(estimateTokens(window.text)).toBeLessThanOrEqual(effective);
        }
    });

    test("splits a single oversized canonical line so no window exceeds the budget (#206)", () => {
        // One canonical line (a single A: span) far larger than the budget — e.g.
        // a big file dump rendered into one message. The old chunker emitted this
        // whole, producing one window that blew past the provider's context window.
        const maxInputTokens = 200;
        const effective = Math.floor(maxInputTokens * CHUNK_WINDOW_SAFETY_RATIO);
        const huge = Array.from(
            { length: 4000 },
            (_, i) => `word${i} alpha beta gamma delta epsilon`,
        ).join(" ");
        const line = `[1] A: ${huge}`;
        expect(estimateTokens(line)).toBeGreaterThan(effective * 10); // genuinely oversized

        const windows = chunkCanonicalText(line, 1, 1, maxInputTokens);

        expect(windows.length).toBeGreaterThan(1);
        // The invariant that #206 violated: NO window may exceed the budget.
        for (const window of windows) {
            expect(estimateTokens(window.text)).toBeLessThanOrEqual(effective);
        }
        // Sub-windows all carry the owning line's ordinal range.
        for (const window of windows) {
            expect(window.startOrdinal).toBe(1);
            expect(window.endOrdinal).toBe(1);
        }
        // windowIndex stays zero-based and contiguous.
        expect(windows.map((w) => w.windowIndex)).toEqual(windows.map((_, i) => i));
    });

    test("mixes split sub-windows with normal line windows without index gaps", () => {
        const maxInputTokens = 200;
        const effective = Math.floor(maxInputTokens * CHUNK_WINDOW_SAFETY_RATIO);
        const huge = Array.from({ length: 2000 }, (_, i) => `tok${i}`).join(" ");
        const text = ["[1] U: short opener", `[2] A: ${huge}`, "[3] U: short closer"].join("\n");

        const windows = chunkCanonicalText(text, 1, 3, maxInputTokens);

        expect(windows.length).toBeGreaterThan(2);
        for (const window of windows) {
            expect(estimateTokens(window.text)).toBeLessThanOrEqual(effective);
        }
        expect(windows.map((w) => w.windowIndex)).toEqual(windows.map((_, i) => i));
    });

    test("storage replaces chunks idempotently and clearSession removes rows", () => {
        const db = createDb();
        try {
            appendCompartments(db, "ses-store", [
                {
                    sequence: 0,
                    startMessage: 1,
                    endMessage: 2,
                    startMessageId: "u1",
                    endMessageId: "a2",
                    title: "Chunk storage",
                    content: "P1 content",
                    p1: "P1 content",
                },
            ]);
            const compartment = getCompartments(db, "ses-store")[0];
            expect(compartment).toBeDefined();
            const windows = chunkCanonicalText("[1] U: hello\n[2] A: world", 1, 2, 10_000);
            replaceCompartmentChunkEmbeddings(
                db,
                windows.map((window) => ({
                    compartmentId: compartment.id,
                    sessionId: "ses-store",
                    projectPath: "/repo/store",
                    window,
                    modelId: "mock:model",
                    vector: new Float32Array([1, 0]),
                })),
            );

            expect(chunkEmbeddingWindowsAreCurrent(db, compartment.id, "mock:model", windows)).toBe(
                true,
            );
            expect(
                loadCompartmentChunkEmbeddingsForSearch(
                    db,
                    "ses-store",
                    "/repo/store",
                    "mock:model",
                ),
            ).toHaveLength(1);

            clearSession(db, "ses-store");
            expect(
                loadCompartmentChunkEmbeddingsForSearch(
                    db,
                    "ses-store",
                    "/repo/store",
                    "mock:model",
                ),
            ).toHaveLength(0);
        } finally {
            closeQuietly(db);
        }
    });

    test("coverage stays read-only before the drain renumbers matching one-based rows", async () => {
        const tempDirectory = mkdtempSync(join(tmpdir(), "chunk-window-renumber-"));
        const databasePath = join(tempDirectory, "store.db");
        const db = createDb(databasePath);
        const embeddedTexts: string[] = [];
        const sessionId = "ses-shifted-window";
        const projectPath = "/repo/shifted-window";
        let observer: Database | null = null;
        try {
            _setTestProviderFactoryForProject(() => new CapturingEmbeddingProvider(embeddedTexts));
            registerProjectEmbedding(
                db,
                projectPath,
                { provider: "local", model: "mock-local", max_input_tokens: 64 },
                { memoryEnabled: true, gitCommitEnabled: false },
                projectPath,
            );
            recordSessionProjectIdentity(db, sessionId, projectPath);
            appendCompartments(db, sessionId, [
                {
                    sequence: 0,
                    startMessage: 1,
                    endMessage: 1,
                    startMessageId: "a1",
                    endMessageId: "a1",
                    title: "Legacy shifted keys",
                    content: "shifted",
                    p1: "shifted",
                },
            ]);
            insertFtsRow(
                db,
                sessionId,
                1,
                "assistant",
                Array.from({ length: 320 }, (_, index) => `legacy-token-${index}`).join(" "),
            );
            const [compartment] = getCompartments(db, sessionId);
            const modelId = currentChunkModelId(projectPath);
            const expectedWindows = chunkCanonicalText(
                buildCanonicalChunkTextFromFts(db, sessionId, 1, 1) ?? "",
                1,
                1,
                64,
            );
            expect(expectedWindows.length).toBeGreaterThan(1);
            replaceCompartmentChunkEmbeddings(
                db,
                expectedWindows.map((window) => ({
                    compartmentId: compartment.id,
                    sessionId,
                    projectPath,
                    window: { ...window, windowIndex: window.windowIndex + 1 },
                    modelId,
                    vector: new Float32Array([1, 0]),
                })),
            );

            observer = new Database(databasePath);
            const beforeDataVersion = (
                observer.prepare("PRAGMA data_version").get() as { data_version: number }
            ).data_version;
            expect(
                countSessionCompartmentEmbedCoverage(db, projectPath, sessionId, modelId, 64),
            ).toEqual({ embedded: 1, total: 1 });
            const afterDataVersion = (
                observer.prepare("PRAGMA data_version").get() as { data_version: number }
            ).data_version;
            expect(afterDataVersion).toBe(beforeDataVersion);

            expect(await embedSessionCompartmentChunks(db, projectPath, sessionId)).toEqual({
                status: "nothing",
                embedded: 0,
                total: 0,
            });
            expect(embeddedTexts).toEqual([]);
            const stored = loadCompartmentChunkEmbeddingsForSearch(
                db,
                sessionId,
                projectPath,
                modelId,
            );
            expect(stored.map((row) => row.windowIndex)).toEqual(
                expectedWindows.map((window) => window.windowIndex),
            );
            expect(stored.map((row) => row.chunkHash)).toEqual(
                expectedWindows.map((window) => window.chunkHash),
            );
            expect(stored.map((row) => [row.windowStartOrdinal, row.windowEndOrdinal])).toEqual(
                expectedWindows.map((window) => [window.startOrdinal, window.endOrdinal]),
            );
        } finally {
            _resetProjectEmbeddingRegistryForTests();
            if (observer) closeQuietly(observer);
            closeQuietly(db);
            rmSync(tempDirectory, { recursive: true, force: true });
        }
    });

    test("classification keeps a hash-mismatched one-based window set stale", () => {
        const db = createDb();
        const sessionId = "ses-shifted-stale";
        const projectPath = "/repo/shifted-stale";
        const modelId = "mock:shifted-stale";
        try {
            recordSessionProjectIdentity(db, sessionId, projectPath);
            appendCompartments(db, sessionId, [
                {
                    sequence: 0,
                    startMessage: 1,
                    endMessage: 1,
                    startMessageId: "a1",
                    endMessageId: "a1",
                    title: "Stale shifted keys",
                    content: "stale",
                    p1: "stale",
                },
            ]);
            insertFtsRow(
                db,
                sessionId,
                1,
                "assistant",
                Array.from({ length: 320 }, (_, index) => `stale-token-${index}`).join(" "),
            );
            const [compartment] = getCompartments(db, sessionId);
            const expectedWindows = chunkCanonicalText(
                buildCanonicalChunkTextFromFts(db, sessionId, 1, 1) ?? "",
                1,
                1,
                64,
            );
            expect(expectedWindows.length).toBeGreaterThan(1);
            replaceCompartmentChunkEmbeddings(
                db,
                expectedWindows.map((window, index) => ({
                    compartmentId: compartment.id,
                    sessionId,
                    projectPath,
                    window: {
                        ...window,
                        windowIndex: window.windowIndex + 1,
                        chunkHash: index === 0 ? `stale-${window.chunkHash}` : window.chunkHash,
                    },
                    modelId,
                    vector: new Float32Array([1, 0]),
                })),
            );

            expect(
                loadUnembeddedSessionChunkCandidates(
                    db,
                    projectPath,
                    sessionId,
                    modelId,
                    1,
                    undefined,
                    64,
                ).map((candidate) => candidate.id),
            ).toEqual([compartment.id]);
            expect(
                loadCompartmentChunkEmbeddingsForSearch(db, sessionId, projectPath, modelId).map(
                    (row) => row.windowIndex,
                ),
            ).toEqual(expectedWindows.map((window) => window.windowIndex + 1));
        } finally {
            closeQuietly(db);
        }
    });

    test("reuses decoded search vectors until the pool probe changes", () => {
        const db = createDb();
        try {
            appendCompartments(db, "ses-cache", [
                {
                    sequence: 0,
                    startMessage: 1,
                    endMessage: 2,
                    startMessageId: "u1",
                    endMessageId: "a2",
                    title: "Cached chunks",
                    content: "P1 content",
                    p1: "P1 content",
                },
            ]);
            const compartment = getCompartments(db, "ses-cache")[0];
            const [window] = chunkCanonicalText("[1] U: hello\n[2] A: world", 1, 2, 10_000);
            const writeVector = (vector: Float32Array) =>
                replaceCompartmentChunkEmbeddings(db, [
                    {
                        compartmentId: compartment.id,
                        sessionId: "ses-cache",
                        projectPath: "/repo/cache",
                        window,
                        modelId: "mock:model",
                        vector,
                    },
                ]);

            writeVector(new Float32Array([1, 0]));
            const first = loadCompartmentChunkEmbeddingsForSearch(
                db,
                "ses-cache",
                "/repo/cache",
                "mock:model",
            );
            const cached = loadCompartmentChunkEmbeddingsForSearch(
                db,
                "ses-cache",
                "/repo/cache",
                "mock:model",
            );
            expect(cached).toBe(first);

            // Replacement preserves the row count but advances the maximum id,
            // so the cheap probe must invalidate the decoded pool.
            writeVector(new Float32Array([0, 1]));
            const replaced = loadCompartmentChunkEmbeddingsForSearch(
                db,
                "ses-cache",
                "/repo/cache",
                "mock:model",
            );
            expect(replaced).not.toBe(first);
            expect([...replaced[0].vector]).toEqual([0, 1]);
        } finally {
            _resetCompartmentChunkSearchCacheForTests();
            closeQuietly(db);
        }
    });

    test("publish helper embeds chunks with TC lines stripped", async () => {
        const db = createDb();
        const embeddedTexts: string[] = [];
        try {
            _setTestProviderFactoryForProject(() => new CapturingEmbeddingProvider(embeddedTexts));
            registerProjectEmbedding(
                db,
                "/repo/publish",
                { provider: "local", model: "mock-local" },
                { memoryEnabled: true, gitCommitEnabled: false },
                "/repo/publish",
            );
            appendCompartments(db, "ses-publish", [
                {
                    sequence: 0,
                    startMessage: 1,
                    endMessage: 2,
                    startMessageId: "u1",
                    endMessageId: "a2",
                    title: "Publish chunks",
                    content: "P1 content",
                    p1: "P1 content",
                },
            ]);
            const compartment = getCompartments(db, "ses-publish")[0];

            await embedAndStoreCompartmentChunks(db, "ses-publish", "/repo/publish", [
                {
                    id: compartment.id,
                    startMessage: 1,
                    endMessage: 2,
                    sourceChunkText: "[1] U: Keep this line\n[2] A: TC: bash(Run tests)",
                },
            ]);

            expect(embeddedTexts).toEqual(["[1] U: Keep this line"]);
            expect(
                loadCompartmentChunkEmbeddingsForSearch(
                    db,
                    "ses-publish",
                    "/repo/publish",
                    currentChunkModelId("/repo/publish"),
                ),
            ).toHaveLength(1);
        } finally {
            _resetProjectEmbeddingRegistryForTests();
            closeQuietly(db);
        }
    });

    test("publish helper isolates five compartments from one unattributable runner block", async () => {
        const db = createDb();
        const embeddedTexts: string[] = [];
        const sessionId = "ses-publish-five";
        const projectPath = "/repo/publish-five";
        const ranges = [
            [35408, 35460],
            [35461, 35510],
            [35511, 35610],
            [35611, 35670],
            [35671, 35700],
        ] as const;
        try {
            _setTestProviderFactoryForProject(() => new CapturingEmbeddingProvider(embeddedTexts));
            registerProjectEmbedding(
                db,
                projectPath,
                { provider: "local", model: "mock-local", max_input_tokens: 64 },
                { memoryEnabled: true, gitCommitEnabled: false },
                projectPath,
            );
            appendCompartments(
                db,
                sessionId,
                ranges.map(([startMessage, endMessage], sequence) => ({
                    sequence,
                    startMessage,
                    endMessage,
                    startMessageId: `a${startMessage}`,
                    endMessageId: `a${endMessage}`,
                    title: `Published compartment ${sequence}`,
                    content: `Compartment ${sequence} content`,
                    p1: `Compartment ${sequence} content`,
                })),
            );
            for (const [sequence, [startMessage, endMessage]] of ranges.entries()) {
                for (let ordinal = startMessage; ordinal <= endMessage; ordinal++) {
                    insertFtsRow(
                        db,
                        sessionId,
                        ordinal,
                        "assistant",
                        `compartment-${sequence} ordinal-${ordinal}`,
                    );
                }
            }

            const historianBody = Array.from(
                { length: 320 },
                (_, index) => `merged-assistant-token-${index}`,
            ).join(" ");
            const sourceChunkText = formatBlock({
                role: "A",
                startOrdinal: 35409,
                endOrdinal: 35710,
                parts: [historianBody],
                meta: [],
                commitHashes: [],
                isToolOnly: false,
            });
            expect(sourceChunkText).toBe(`[35409-35710] A: ${historianBody}`);

            const compartments = getCompartments(db, sessionId);
            await embedAndStoreCompartmentChunks(
                db,
                sessionId,
                projectPath,
                compartments.map((compartment) => ({
                    id: compartment.id,
                    startMessage: compartment.startMessage,
                    endMessage: compartment.endMessage,
                    sourceChunkText,
                })),
            );

            const stored = loadCompartmentChunkEmbeddingsForSearch(
                db,
                sessionId,
                projectPath,
                currentChunkModelId(projectPath),
            );
            const rowsByCompartment = compartments.map((compartment) =>
                stored.filter((row) => row.compartmentId === compartment.id),
            );
            expect(rowsByCompartment.every((rows) => rows.length > 0)).toBe(true);
            expect(
                new Set(rowsByCompartment.map((rows) => rows.map((row) => row.chunkHash).join(",")))
                    .size,
            ).toBe(ranges.length);

            for (const [index, rows] of rowsByCompartment.entries()) {
                const [startMessage, endMessage] = ranges[index];
                expect(rows.map((row) => row.windowIndex)).toEqual(
                    rows.map((_, windowIndex) => windowIndex),
                );
                for (const row of rows) {
                    expect(row.windowStartOrdinal).toBeGreaterThanOrEqual(startMessage);
                    expect(row.windowEndOrdinal).toBeLessThanOrEqual(endMessage);
                }
            }
        } finally {
            _resetProjectEmbeddingRegistryForTests();
            closeQuietly(db);
        }
    });

    test("empty raw span falls back to embedding the compartment summary (title + p1)", async () => {
        const db = createDb();
        const embeddedTexts: string[] = [];
        try {
            _setTestProviderFactoryForProject(() => new CapturingEmbeddingProvider(embeddedTexts));
            registerProjectEmbedding(
                db,
                "/repo/fallback",
                { provider: "local", model: "mock-local" },
                { memoryEnabled: true, gitCommitEnabled: false },
                "/repo/fallback",
            );
            // A thin notification/tool-only compartment: no FTS rows for its span,
            // and the in-memory source strips to empty (system-reminder + TC line).
            appendCompartments(db, "ses-fallback", [
                {
                    sequence: 0,
                    startMessage: 5,
                    endMessage: 6,
                    startMessageId: "u5",
                    endMessageId: "a6",
                    title: "Executed background oracle audit for oxc engine",
                    content: "Ran the background oracle audit to verify the oxc cutover.",
                    p1: "Ran the background oracle audit to verify the oxc cutover.",
                },
            ]);
            const compartment = getCompartments(db, "ses-fallback")[0];

            await embedAndStoreCompartmentChunks(db, "ses-fallback", "/repo/fallback", [
                {
                    id: compartment.id,
                    startMessage: 5,
                    endMessage: 6,
                    // Both lines strip away: no [ord] U:/A: meaningful text survives.
                    sourceChunkText: "[5] A: TC: task(Audit oxc engine)",
                },
            ]);

            // Embedded the summary (title + p1), not the empty raw span.
            expect(embeddedTexts).toEqual([
                "Executed background oracle audit for oxc engine\nRan the background oracle audit to verify the oxc cutover.",
            ]);
            expect(
                loadCompartmentChunkEmbeddingsForSearch(
                    db,
                    "ses-fallback",
                    "/repo/fallback",
                    currentChunkModelId("/repo/fallback"),
                ),
            ).toHaveLength(1);
        } finally {
            _resetProjectEmbeddingRegistryForTests();
            closeQuietly(db);
        }
    });

    test("hash-complete drain cannot report vacuous coverage for missing-window or stale-hash rows", () => {
        const db = createDb();
        const projectPath = "/repo/hash-complete";
        const sessionId = "ses-hash-complete";
        const modelId = "mock:hash-complete";
        const maxInputTokens = 9;
        try {
            recordSessionProjectIdentity(db, sessionId, projectPath);
            appendCompartments(db, sessionId, [
                {
                    sequence: 0,
                    startMessage: 1,
                    endMessage: 2,
                    startMessageId: "u1",
                    endMessageId: "a2",
                    title: "Missing one expected window",
                    content: "missing",
                    p1: "missing",
                },
                {
                    sequence: 1,
                    startMessage: 3,
                    endMessage: 3,
                    startMessageId: "u3",
                    endMessageId: "u3",
                    title: "Clean current row",
                    content: "clean",
                    p1: "clean",
                },
                {
                    sequence: 2,
                    startMessage: 4,
                    endMessage: 4,
                    startMessageId: "u4",
                    endMessageId: "u4",
                    title: "Stale hash row",
                    content: "stale",
                    p1: "stale",
                },
            ]);
            insertFtsRow(db, sessionId, 1, "user", "alpha beta gamma");
            insertFtsRow(db, sessionId, 2, "assistant", "delta epsilon zeta");
            insertFtsRow(db, sessionId, 3, "user", "clean");
            insertFtsRow(db, sessionId, 4, "user", "stale");

            const [missing, clean, stale] = getCompartments(db, sessionId);
            const expectedWindows = (compartment: typeof missing) =>
                chunkCanonicalText(
                    buildCanonicalChunkTextFromFts(
                        db,
                        sessionId,
                        compartment.startMessage,
                        compartment.endMessage,
                    ) ?? "",
                    compartment.startMessage,
                    compartment.endMessage,
                    maxInputTokens,
                );
            const write = (
                compartment: typeof missing,
                windows: ReturnType<typeof chunkCanonicalText>,
            ) =>
                replaceCompartmentChunkEmbeddings(
                    db,
                    windows.map((window) => ({
                        compartmentId: compartment.id,
                        sessionId,
                        projectPath,
                        window,
                        modelId,
                        vector: new Float32Array([1, 0]),
                    })),
                );

            const missingWindows = expectedWindows(missing);
            const cleanWindows = expectedWindows(clean);
            const staleWindows = expectedWindows(stale);
            expect(missingWindows.length).toBeGreaterThan(1);
            write(missing, missingWindows.slice(0, 1));
            write(clean, cleanWindows);
            write(
                stale,
                staleWindows.map((window) => ({
                    ...window,
                    chunkHash: `stale-${window.chunkHash}`,
                })),
            );

            // Although the stale row sorts first, a result limited to one item
            // must select the missing window instead of the stale replacement.
            expect(
                loadUnembeddedCompartmentChunkCandidates(
                    db,
                    projectPath,
                    modelId,
                    1,
                    maxInputTokens,
                ).map((candidate) => candidate.id),
            ).toEqual([missing.id]);
            expect(
                loadUnembeddedSessionChunkCandidates(
                    db,
                    projectPath,
                    sessionId,
                    modelId,
                    3,
                    undefined,
                    maxInputTokens,
                ).map((candidate) => candidate.id),
            ).toEqual([missing.id, stale.id]);
            expect(
                countUnembeddedSessionCompartments(
                    db,
                    projectPath,
                    sessionId,
                    modelId,
                    maxInputTokens,
                ),
            ).toBe(2);
            expect(
                countSessionCompartmentEmbedCoverage(
                    db,
                    projectPath,
                    sessionId,
                    modelId,
                    maxInputTokens,
                ),
            ).toEqual({ embedded: 1, total: 3 });

            // Test each condition independently: repairing the missing windows
            // must leave the stale hash outstanding, and repairing the stale hash
            // must leave the missing window outstanding. Checking only whether a
            // model row exists would fail both assertions.
            write(missing, missingWindows);
            expect(
                countUnembeddedSessionCompartments(
                    db,
                    projectPath,
                    sessionId,
                    modelId,
                    maxInputTokens,
                ),
            ).toBe(1);
            write(missing, missingWindows.slice(0, 1));
            write(stale, staleWindows);
            expect(
                countUnembeddedSessionCompartments(
                    db,
                    projectPath,
                    sessionId,
                    modelId,
                    maxInputTokens,
                ),
            ).toBe(1);

            write(missing, missingWindows);
            expect(
                countUnembeddedSessionCompartments(
                    db,
                    projectPath,
                    sessionId,
                    modelId,
                    maxInputTokens,
                ),
            ).toBe(0);
            expect(
                countSessionCompartmentEmbedCoverage(
                    db,
                    projectPath,
                    sessionId,
                    modelId,
                    maxInputTokens,
                ),
            ).toEqual({ embedded: 3, total: 3 });
        } finally {
            closeQuietly(db);
        }
    });
});

describe("issue 564 coverage catch-up", () => {
    test("steady-state coverage and count do not re-tokenize unchanged compartments", async () => {
        const db = createDb();
        const sessionId = "ses-coverage-memo";
        const project = "/repo/coverage-memo";
        const model = "mock:coverage-memo";
        try {
            recordSessionProjectIdentity(db, sessionId, project);
            appendCompartments(db, sessionId, [
                {
                    sequence: 0,
                    startMessage: 1,
                    endMessage: 1,
                    startMessageId: "u1",
                    endMessageId: "u1",
                    title: "Memo",
                    content: "Memo",
                    p1: "Memo",
                },
            ]);
            insertFtsRow(db, sessionId, 1, "user", "A unique message for the coverage memo");
            const tokens = spyOn(formatting, "estimateTokens");
            try {
                expect(
                    (
                        await countSessionCompartmentEmbedCoveragePolite(
                            db,
                            project,
                            sessionId,
                            model,
                        )
                    ).total,
                ).toBe(1);
                expect(tokens.mock.calls.length).toBeGreaterThan(0);
                tokens.mockClear();
                expect(
                    await countUnembeddedSessionCompartmentsPolite(db, project, sessionId, model),
                ).toBe(1);
                expect(
                    (
                        await loadUnembeddedSessionChunkCandidatesPolite(
                            db,
                            project,
                            sessionId,
                            model,
                            1,
                        )
                    ).length,
                ).toBe(1);
                expect(
                    (
                        await countSessionCompartmentEmbedCoveragePolite(
                            db,
                            project,
                            sessionId,
                            model,
                        )
                    ).embedded,
                ).toBe(0);
                expect(tokens).toHaveBeenCalledTimes(0);
            } finally {
                tokens.mockRestore();
            }
            // Replacing indexed message text must invalidate cached window hashes
            // even when the owning compartment row remains unchanged.
            insertFtsRow(db, sessionId, 1, "assistant", "New text");
            expect(
                (await countSessionCompartmentEmbedCoveragePolite(db, project, sessionId, model))
                    .embedded,
            ).toBe(0);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("issue 564 failed-compartment backoff", () => {
    test("persists a content- and identity-scoped retry delay and removes it with the session", async () => {
        const db = createDb();
        const sessionId = "ses-backoff";
        const project = "/repo/backoff";
        try {
            recordSessionProjectIdentity(db, sessionId, project);
            appendCompartments(db, sessionId, [
                {
                    sequence: 0,
                    startMessage: 1,
                    endMessage: 1,
                    startMessageId: "u1",
                    endMessageId: "u1",
                    title: "Retry",
                    content: "Retry",
                    p1: "Retry",
                },
            ]);
            insertFtsRow(db, sessionId, 1, "user", "Original text");
            const candidate = getCompartments(db, sessionId)[0];
            expect(
                await countUnembeddedSessionCompartmentsPolite(db, project, sessionId, "model:a"),
            ).toBe(1);
            recordChunkEmbedBackoff(db, candidate, project, "model:a");
            expect(
                await countUnembeddedSessionCompartmentsPolite(db, project, sessionId, "model:a"),
            ).toBe(0);
            expect(
                await countUnembeddedSessionCompartmentsPolite(db, project, sessionId, "model:b"),
            ).toBe(1);
            insertFtsRow(db, sessionId, 1, "assistant", "Repaired text");
            expect(
                await countUnembeddedSessionCompartmentsPolite(db, project, sessionId, "model:a"),
            ).toBe(1);
            clearSession(db, sessionId);
            expect(
                db
                    .prepare("SELECT key FROM schema_migrations_meta WHERE key = ?")
                    .get(`chunk_embed_backoff:${candidate.id}`),
            ).toBeNull();
        } finally {
            closeQuietly(db);
        }
    });
});
