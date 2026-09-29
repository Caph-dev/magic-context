/**
 * SQLite chokepoint — runtime-detected backend selection.
 *
 * The same shipped plugin artifact must run under two different runtimes:
 *   - Bun (current OpenCode releases) → uses `bun:sqlite` (built-in, fast)
 *   - Node / Electron (Pi plugin, OpenCode Desktop) → uses `node:sqlite`
 *     (`DatabaseSync`, built into Node 22.5+ / Electron 41+, stable-enough and
 *     flag-free since Node 22.13/23.4).
 *
 * Bun has no `node:sqlite`, and Node/Electron have no `bun:sqlite`. Static
 * imports of either would crash at parse time in the wrong runtime, so we use
 * dynamic imports gated by runtime detection.
 *
 * Why `node:sqlite` instead of `better-sqlite3`: better-sqlite3 is a native
 * module requiring per-ABI prebuilds, and Electron's ABI never matches the npm
 * Node prebuild — which forced a runtime download of an Electron-matched
 * `.node` binary (a supply-chain + maintenance liability). `node:sqlite` is
 * built into the runtime, so there is NOTHING to download or rebuild. Both Pi
 * (plain Node 24) and OpenCode Desktop (Electron 41 → Node 24.14.1) ship it.
 *
 * API surface we use (common across both backends, modulo the shims below):
 *   - new Database(path, { readonly?: boolean })   ← we map readonly→readOnly
 *   - db.prepare(sql).run/get/all
 *   - db.exec(multistatement)
 *   - db.transaction(fn) → wrapped function        ← shimmed for node:sqlite
 *   - db.close()
 *
 * The three backend differences we bridge for node:sqlite:
 *   1. node:sqlite has no `db.transaction(fn)` helper — we add a savepoint-aware
 *      shim (below) that matches better-sqlite3/bun semantics.
 *   2. node:sqlite's constructor option is `readOnly` (camel-case), not
 *      better-sqlite3/bun's `readonly` — we translate it so call sites are
 *      unchanged.
 *   3. node:sqlite reads a lone array bind arg (`.run([a,b])`) as NAMED params
 *      and throws `Unknown named parameter '0'`; bun binds it positionally. We
 *      normalize it in the `prepare()` override (below) so the bind surface is
 *      identical (issue #151 / Pi /ctx-dream).
 * Everything else (named params with bare keys, ATTACH under defensive mode,
 * `run()` → {changes,lastInsertRowid}) is identical and was verified directly.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { statSync } from "node:fs";
// Type import only — runtime is loaded dynamically below. @types/better-sqlite3
// has the richest definitions and is a structural superset of the API surface
// we use, so calls typed against BetterSqlite3 work under bun:sqlite and
// node:sqlite at runtime (both expose prepare/run/get/all/exec/close).
import type BetterSqlite3 from "better-sqlite3";

/**
 * Slow-write reporting is injected rather than imported: this module is also
 * executed directly by Node (the `node:sqlite` smoke in CI, Pi, Desktop), and
 * Node's type-stripping loader does not resolve extensionless imports, so any
 * static import of the plugin's logging chain here breaks that path. The
 * storage bootstrap registers the real reporter; until then slow privileged
 * writes are simply not logged.
 */
type SlowWriteReporter = (site: string, transactionStartedAt: number) => void;
let reportSlowPrivilegedWrite: SlowWriteReporter | undefined;

export function registerSlowWriteReporter(reporter: SlowWriteReporter): void {
    reportSlowPrivilegedWrite = reporter;
}

export type SqliteRuntime = "Bun" | "Node.js";

type SqliteModule = {
    Database?: unknown;
    DatabaseSync?: unknown;
};

export function detectSqliteRuntime(): SqliteRuntime {
    // process.versions.bun is the least ambiguous marker, but some launchers
    // proxy or partially sandbox process. Keep globalThis.Bun as a fallback so
    // a Bun process does not accidentally select node:sqlite just because its
    // process compatibility surface was trimmed.
    const hasBunVersion =
        typeof process !== "undefined" && typeof process.versions?.bun === "string";
    const hasBunGlobal =
        typeof globalThis !== "undefined" &&
        typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
    return hasBunVersion || hasBunGlobal ? "Bun" : "Node.js";
}

// IMPORTANT: bundler-evading dynamic imports.
//
// We can't write `await import("node:sqlite")` directly because esbuild/bun
// would try to resolve both modules at build time, and one of them won't exist
// in the build runtime (bun:sqlite is missing in Node, node:sqlite is missing
// in Bun). Earlier versions used `new Function("p", "return import(p)")(...)`
// to defeat static analysis, but that breaks Pi's vm-based extension loader: a
// Function constructed at runtime has no module record, so `import()` inside it
// has no referrer module and Node throws "A dynamic import callback was not
// specified".
//
// The /* @vite-ignore */ + variable indirection pattern hides the specifier
// from static analyzers while keeping a real referrer module for the
// dynamic import — Pi's loader, esbuild, and bun build all accept it.
const bunSpec = "bun:" + "sqlite";
const nodeSpec = "node:" + "sqlite";

async function importSqliteModule(specifier: string): Promise<SqliteModule> {
    // The runtime chooses this specifier; Vite must not resolve it as a
    // build-time dependency because the other runtime's backend is absent.
    return (await import(
        /* @vite-ignore -- keep the runtime-selected backend unresolved */ specifier
    )) as SqliteModule;
}

function isModuleNotFoundError(error: unknown, specifier: string): boolean {
    const candidate = error as { code?: unknown; name?: unknown } | null;
    const code = typeof candidate?.code === "string" ? candidate.code : "";
    const name = typeof candidate?.name === "string" ? candidate.name : "";
    const message = error instanceof Error ? error.message : String(error ?? "");
    const details = `${code} ${name} ${message}`.toLowerCase();
    const mentionsSpecifier = details.includes(specifier.toLowerCase());
    if (!mentionsSpecifier) return false;

    return (
        code === "ERR_MODULE_NOT_FOUND" ||
        code === "ERR_UNKNOWN_BUILTIN_MODULE" ||
        code === "MODULE_NOT_FOUND" ||
        name === "ResolveMessage" ||
        details.includes("module not found") ||
        details.includes("cannot find module") ||
        details.includes("cannot find package") ||
        details.includes("no such built-in module")
    );
}

export class SqliteRuntimeUnavailableError extends Error {
    readonly runtime: SqliteRuntime;
    readonly specifier: string;

    constructor(runtime: SqliteRuntime, specifier: string, cause: unknown) {
        const requirement =
            specifier === nodeSpec
                ? "Requires Node.js >= 24, or Bun with bun:sqlite — this Bun build lacks node:sqlite."
                : "Requires Bun with bun:sqlite, or Node.js >= 24 — this Bun build lacks bun:sqlite.";
        super(
            `Magic Context detected ${runtime}, but could not load ${specifier}. ${requirement}`,
            { cause },
        );
        this.name = "SqliteRuntimeUnavailableError";
        this.runtime = runtime;
        this.specifier = specifier;
    }
}

export async function loadSqliteModule(
    runtime: SqliteRuntime = detectSqliteRuntime(),
    importer: (specifier: string) => Promise<SqliteModule> = importSqliteModule,
): Promise<SqliteModule> {
    const specifier = runtime === "Bun" ? bunSpec : nodeSpec;
    try {
        return await importer(specifier);
    } catch (error) {
        if (isModuleNotFoundError(error, specifier)) {
            throw new SqliteRuntimeUnavailableError(runtime, specifier, error);
        }
        throw error;
    }
}

const detectedRuntime = detectSqliteRuntime();
const isBun = detectedRuntime === "Bun";
const sqliteModule = await loadSqliteModule(detectedRuntime);

// Different export shapes between the two backends:
//   - bun:sqlite  → named export `Database` (has its own .transaction, accepts
//     `{ readonly }`) — usable as-is.
//   - node:sqlite → named export `DatabaseSync` (no .transaction, option is
//     `readOnly`) — wrapped below.
const DatabaseImpl: typeof BetterSqlite3 = isBun
    ? (sqliteModule.Database as typeof BetterSqlite3)
    : buildNodeSqliteDatabaseClass(sqliteModule.DatabaseSync);

interface TrackedSqliteConnection {
    sequence: number;
    filename: string;
    readonly: boolean;
    reference: WeakRef<BetterSqlite3.Database>;
}

export interface SqliteConnectionMemoryStats {
    sequence: number;
    filename: string;
    readonly: boolean;
    pageSize: number | null;
    pageCount: number | null;
    freelistCount: number | null;
    cacheSize: number | null;
    cacheSizeUnit: "pages" | "kib" | null;
    cacheUpperBoundBytes: number | null;
    mmapSizeBytes: number | null;
    walFileBytes: number | null;
    shmFileBytes: number | null;
    fts5TableCount: number | null;
    journalMode: string | null;
}

export interface SqliteMemoryStats {
    connectionCount: number;
    cacheUpperBoundBytes: number;
    mmapUpperBoundBytes: number;
    walFileBytes: number;
    shmFileBytes: number;
    sqliteStatusApi: "unavailable";
    connections: SqliteConnectionMemoryStats[];
}

const trackedSqliteConnections = new Map<number, TrackedSqliteConnection>();
let nextSqliteConnectionSequence = 1;

/** Route native Bun and Node transaction entry through the same acquisition retry.
 * Native Bun transaction wrappers execute BEGIN internally, bypassing an exec override,
 * so both runtimes use this small synchronous wrapper instead. Writable handles
 * default to IMMEDIATE; explicit deferred calls and readonly handles keep read
 * snapshots without acquiring the writer lock. */
function installTransactionRouting(db: BetterSqlite3.Database, readonly: boolean): void {
    const nativeExec = db.exec.bind(db);
    Object.defineProperty(db, "exec", {
        configurable: true,
        writable: true,
        value: (sql: string) => {
            if (/^\s*BEGIN\s+(?:IMMEDIATE|EXCLUSIVE)(?:\s+TRANSACTION)?\s*;?\s*$/i.test(sql)) {
                if (transformPassScope.getStore()?.active || backgroundWriterScope.getStore())
                    acquireShort(db, () => nativeExec(sql), sql.trim());
                else nativeExec(sql);
                return db;
            }
            return nativeExec(sql);
        },
    });
    Object.defineProperty(db, "transaction", {
        configurable: true,
        writable: true,
        // biome-ignore lint/suspicious/noExplicitAny: preserve the native callback's receiver and argument types.
        value: (fn: (...args: any[]) => any) => {
            const make = (mode: "IMMEDIATE" | "EXCLUSIVE" | "DEFERRED") =>
                function (this: unknown, ...args: unknown[]): unknown {
                    const nested = isInTransaction(db);
                    // Equal savepoint names stack LIFO, matching both native backends.
                    const savepoint = "mc_tx_sp";
                    db.exec(nested ? `SAVEPOINT ${savepoint}` : `BEGIN ${mode}`);
                    try {
                        const result = fn.apply(this, args);
                        db.exec(nested ? `RELEASE ${savepoint}` : "COMMIT");
                        return result;
                    } catch (error) {
                        if (isInTransaction(db)) {
                            if (nested) {
                                db.exec(`ROLLBACK TO ${savepoint}`);
                                db.exec(`RELEASE ${savepoint}`);
                            } else db.exec("ROLLBACK");
                        }
                        throw error;
                    }
                };
            const defaultTransaction = make(readonly ? "DEFERRED" : "IMMEDIATE");
            const variants = {
                default: defaultTransaction,
                deferred: make("DEFERRED"),
                immediate: make("IMMEDIATE"),
                exclusive: make("EXCLUSIVE"),
                database: db,
            };
            for (const transaction of [
                variants.default,
                variants.deferred,
                variants.immediate,
                variants.exclusive,
            ]) {
                Object.assign(transaction, variants);
            }
            return defaultTransaction;
        },
    });
}

function trackSqliteConnection(
    db: BetterSqlite3.Database,
    filename: unknown,
    options: unknown,
): BetterSqlite3.Database {
    const originalClose = db.close.bind(db) as (...args: unknown[]) => unknown;
    const sequence = nextSqliteConnectionSequence++;
    const metadata = {
        sequence,
        filename:
            typeof filename === "string"
                ? filename
                : Buffer.isBuffer(filename)
                  ? "<buffer>"
                  : ":memory:",
        readonly:
            Boolean(options) &&
            typeof options === "object" &&
            ((options as { readonly?: unknown }).readonly === true ||
                (options as { readOnly?: unknown }).readOnly === true),
    };
    installTransactionRouting(db, metadata.readonly);
    Object.defineProperty(db, "close", {
        configurable: true,
        value: (...args: unknown[]) => {
            try {
                return originalClose(...args);
            } finally {
                trackedSqliteConnections.delete(sequence);
            }
        },
    });
    trackedSqliteConnections.set(sequence, {
        ...metadata,
        reference: new WeakRef(db),
    });
    return db;
}

const TrackedDatabase = new Proxy(DatabaseImpl, {
    construct(target, args) {
        const db = Reflect.construct(target, args, target) as BetterSqlite3.Database;
        return trackSqliteConnection(db, args[0], args[1]);
    },
}) as typeof BetterSqlite3;

/**
 * Wrap node:sqlite's `DatabaseSync` so it presents the better-sqlite3/bun
 * surface the rest of the codebase calls:
 *   - translate the `{ readonly }` constructor option → node:sqlite's `readOnly`
 * Transaction routing is installed for both runtimes by trackSqliteConnection.
 */
// biome-ignore lint/suspicious/noExplicitAny: node:sqlite has no shipped types here; the public export is cast to the better-sqlite3 shape.
function buildNodeSqliteDatabaseClass(DatabaseSync: any): typeof BetterSqlite3 {
    class NodeSqliteDatabase extends DatabaseSync {
        constructor(filename?: string | Buffer, options?: BetterSqlite3.Options) {
            const translated: Record<string, unknown> = { ...options };
            if (options && "readonly" in options) {
                translated.readOnly = (options as { readonly?: boolean }).readonly;
                delete translated.readonly;
            }
            super(typeof filename === "string" ? filename : ":memory:", translated);
        }

        // Normalize a single ARRAY bind arg to spread positional, matching
        // bun:sqlite. bun's `.run([a,b])` binds positionally; node:sqlite instead
        // reads a lone array as NAMED params with keys "0","1" and throws
        // `Unknown named parameter '0'`. That divergence let an array-form bind
        // (e.g. `.run([x, y])`) silently work on OpenCode/Bun yet break Pi and
        // OpenCode Desktop (both node:sqlite) — issue #151 (/ctx-dream). Wrapping
        // every prepared statement here keeps the two backends' bind surface
        // truly identical so this whole class is impossible regardless of how a
        // call site writes its bind. Named-object binds (`.run({k:v})`), no-arg
        // calls, and already-spread positional args are passed through unchanged;
        // the normalization only triggers on the exact 1-array shape. Overhead
        // measured at ~12ns/call against real node:sqlite (negligible).
        // biome-ignore lint/suspicious/noExplicitAny: node:sqlite StatementSync has no shipped types here.
        prepare(sql: string): any {
            const stmt = super.prepare(sql);
            for (const method of ["run", "get", "all"] as const) {
                const original = stmt[method].bind(stmt);
                stmt[method] = (...args: unknown[]): unknown =>
                    args.length === 1 && Array.isArray(args[0])
                        ? original(...args[0])
                        : original(...args);
            }
            return stmt;
        }
    }

    return NodeSqliteDatabase as unknown as typeof BetterSqlite3;
}

export const Database: typeof BetterSqlite3 = TrackedDatabase;

function pragmaValue(db: BetterSqlite3.Database, name: string): unknown {
    const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return row[name] ?? Object.values(row)[0];
}

function pragmaNumber(db: BetterSqlite3.Database, name: string): number | null {
    try {
        const value = pragmaValue(db, name);
        return typeof value === "number" && Number.isFinite(value) ? value : null;
    } catch {
        return null;
    }
}

function pragmaString(db: BetterSqlite3.Database, name: string): string | null {
    try {
        const value = pragmaValue(db, name);
        return typeof value === "string" ? value : null;
    } catch {
        return null;
    }
}

function sqliteSidecarBytes(filename: string, suffix: "-wal" | "-shm"): number | null {
    if (filename === ":memory:" || filename === "<buffer>") return 0;
    try {
        return statSync(`${filename}${suffix}`).size;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ENOENT" ? 0 : null;
    }
}

function fts5TableCount(db: BetterSqlite3.Database): number | null {
    try {
        const row = db
            .prepare(
                "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND sql LIKE '%USING fts5%'",
            )
            .get() as { count?: unknown } | undefined;
        return typeof row?.count === "number" ? row.count : null;
    } catch {
        return null;
    }
}

/**
 * Read the SQLite memory bounds that Bun/node:sqlite expose without native FFI.
 * SQLite's sqlite3_status()/sqlite3_db_status() counters are not surfaced by
 * either runtime, so cache and mmap values are configured upper bounds rather
 * than resident-byte measurements.
 */
export function getSqliteMemoryStats(): SqliteMemoryStats {
    const connections: SqliteConnectionMemoryStats[] = [];
    for (const [sequence, tracked] of trackedSqliteConnections) {
        const db = tracked.reference.deref();
        if (!db) {
            trackedSqliteConnections.delete(sequence);
            continue;
        }
        const pageSize = pragmaNumber(db, "page_size");
        const cacheSize = pragmaNumber(db, "cache_size");
        const cacheSizeUnit = cacheSize === null ? null : cacheSize < 0 ? "kib" : "pages";
        const cacheUpperBoundBytes =
            cacheSize === null
                ? null
                : cacheSize < 0
                  ? Math.abs(cacheSize) * 1024
                  : pageSize === null
                    ? null
                    : cacheSize * pageSize;
        connections.push({
            sequence: tracked.sequence,
            filename: tracked.filename,
            readonly: tracked.readonly,
            pageSize,
            pageCount: pragmaNumber(db, "page_count"),
            freelistCount: pragmaNumber(db, "freelist_count"),
            cacheSize,
            cacheSizeUnit,
            cacheUpperBoundBytes,
            mmapSizeBytes: pragmaNumber(db, "mmap_size"),
            walFileBytes: sqliteSidecarBytes(tracked.filename, "-wal"),
            shmFileBytes: sqliteSidecarBytes(tracked.filename, "-shm"),
            fts5TableCount: fts5TableCount(db),
            journalMode: pragmaString(db, "journal_mode"),
        });
    }
    const sumKnown = (select: (connection: SqliteConnectionMemoryStats) => number | null): number =>
        connections.reduce((sum, connection) => sum + (select(connection) ?? 0), 0);
    return {
        connectionCount: connections.length,
        cacheUpperBoundBytes: sumKnown((connection) => connection.cacheUpperBoundBytes),
        mmapUpperBoundBytes: sumKnown((connection) => connection.mmapSizeBytes),
        walFileBytes: sumKnown((connection) => connection.walFileBytes),
        shmFileBytes: sumKnown((connection) => connection.shmFileBytes),
        sqliteStatusApi: "unavailable",
        connections,
    };
}

/** Instance type alias used by helpers and storage modules. */
export type Database = BetterSqlite3.Database;

/**
 * Statement instance type used for WeakMap caches throughout the codebase.
 *
 * We deliberately use the variadic Statement<unknown[], unknown> shape rather
 * than `ReturnType<Database["prepare"]>` because the latter resolves through
 * a conditional return type in @types/better-sqlite3 that confuses TypeScript
 * about how many arguments .run/.get/.all accept. With this explicit type,
 * cached statements accept any number of bind args (matching bun:sqlite's
 * historical behavior in this codebase).
 */
export type Statement = BetterSqlite3.Statement<unknown[], unknown>;

const privilegeDepth = new WeakMap<Database, number>();
const transformPassScope = new AsyncLocalStorage<{ active: boolean } | undefined>();
const admissionScope = new AsyncLocalStorage<boolean>();
const backgroundWriterScope = new AsyncLocalStorage<boolean>();

/** Opt in only a writer that can safely defer its work after a busy acquisition. */
export function withSqliteBackgroundWriter<T>(operation: () => T): T {
    return backgroundWriterScope.run(true, operation);
}

/** Only an awaited foreground transform may spend the extra acquisition budget.
 * The mutable lease also expires for detached descendants when that pass ends. */
export function withSqliteTransformPass<T>(operation: () => T): T {
    const lease = { active: true };
    return transformPassScope.run(lease, () => {
        try {
            const result = operation();
            if (result && typeof (result as { then?: unknown }).then === "function") {
                return Promise.resolve(result).finally(() => {
                    lease.active = false;
                }) as T;
            }
            lease.active = false;
            return result;
        } catch (error) {
            lease.active = false;
            throw error;
        }
    });
}

/** Start detached maintenance work without borrowing a foreground pass's budget. */
export function withoutSqliteTransformPass<T>(operation: () => T): T {
    return transformPassScope.run(undefined, operation);
}

/** Bun names SQLite codes; node:sqlite exposes the numeric (possibly extended) errcode. */
export function isTransientSqliteError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const value = error as { code?: unknown; errcode?: unknown };
    return (
        (typeof value.code === "string" && /^(SQLITE_BUSY|SQLITE_LOCKED)(_|$)/.test(value.code)) ||
        (typeof value.errcode === "number" && [5, 6].includes(value.errcode & 0xff))
    );
}

export class SqliteAcquisitionBusyError extends Error {
    readonly code = "SQLITE_BUSY";
    readonly stage: string;
    constructor(cause: unknown, stage = "BEGIN IMMEDIATE") {
        super("SQLite writer acquisition remained busy", { cause });
        this.name = "SqliteAcquisitionBusyError";
        this.stage = stage;
    }
}

const SHORT_BUSY_TIMEOUT_MS = 25;
const FOREGROUND_IN_PASS_BUSY_TIMEOUT_MS = 250;
const FOREGROUND_ACQUISITION_BUDGET_MS = 16_500;

/** The connection is never handed back to another caller with a shortened timeout. */
function acquireShort(db: Database, acquire: () => unknown, site: string): void {
    const started = performance.now();
    const previous = pragmaNumber(db, "busy_timeout");
    let acquired = false;
    try {
        // Async admission retries after yielding, so each of its BEGIN attempts
        // stays short. An ordinary BEGIN inside a transform pass cannot yield;
        // give that single attempt enough time for a brief writer to finish.
        const timeout =
            transformPassScope.getStore()?.active &&
            !admissionScope.getStore() &&
            !backgroundWriterScope.getStore()
                ? FOREGROUND_IN_PASS_BUSY_TIMEOUT_MS
                : SHORT_BUSY_TIMEOUT_MS;
        db.exec(`PRAGMA busy_timeout=${timeout}`);
        acquire();
        acquired = true;
    } catch (error) {
        if (transformPassScope.getStore()?.active && isTransientSqliteError(error))
            throw new SqliteAcquisitionBusyError(error, site);
        throw error;
    } finally {
        if (previous !== null) db.exec(`PRAGMA busy_timeout=${previous}`);
        const elapsed = performance.now() - started;
        if (elapsed >= 250)
            console.warn(
                `[${new Date().toISOString()}] [magic-context] sqlite acquisition site=${site} lane=${transformPassScope.getStore()?.active ? "foreground" : "background"} elapsed=${Math.round(elapsed)}ms attempts=1 outcome=${acquired ? "acquired" : "busy"}`,
            );
    }
}

/** Begin an immediate transaction with bounded asynchronous retries on writer contention.
 * Callers must recheck any lease or source snapshot after this function returns. */
export async function beginSqliteWriterAsync(db: Database, site: string): Promise<void> {
    const started = performance.now();
    let attempts = 0;
    for (;;) {
        attempts++;
        try {
            withSqliteBackgroundWriter(() => db.exec("BEGIN IMMEDIATE"));
            const elapsed = performance.now() - started;
            if (elapsed >= 250)
                console.warn(
                    `[${new Date().toISOString()}] [magic-context] sqlite acquisition site=${site} lane=background elapsed=${Math.round(elapsed)}ms attempts=${attempts} outcome=acquired`,
                );
            return;
        } catch (error) {
            if (!isTransientSqliteError(error)) throw error;
            const elapsed = performance.now() - started;
            if (elapsed >= FOREGROUND_ACQUISITION_BUDGET_MS) {
                console.warn(
                    `[${new Date().toISOString()}] [magic-context] sqlite acquisition site=${site} lane=background elapsed=${Math.round(elapsed)}ms attempts=${attempts} outcome=busy`,
                );
                throw error;
            }
            await new Promise<void>((resolve) =>
                setTimeout(
                    resolve,
                    Math.min(
                        attempts === 1 ? 500 : 1000,
                        FOREGROUND_ACQUISITION_BUDGET_MS - elapsed,
                    ),
                ),
            );
        }
    }
}

/** Retry admission before any turn work, yielding between short lock attempts. */
export async function withAsyncPrivilegedWriter<T>(db: Database, operation: () => T): Promise<T> {
    const started = performance.now();
    let attempts = 0;
    for (;;) {
        attempts++;
        try {
            const result = admissionScope.run(true, () =>
                withSqliteTransformPass(() => withPrivilegedWriter(db, operation)),
            );
            const elapsed = performance.now() - started;
            if (elapsed >= 250)
                console.warn(
                    `[${new Date().toISOString()}] [magic-context] sqlite acquisition site=privileged_writer lane=foreground elapsed=${Math.round(elapsed)}ms attempts=${attempts} outcome=acquired`,
                );
            return result;
        } catch (error) {
            // A callback failure can occur after writes; only retry a failed BEGIN.
            if (!(error instanceof SqliteAcquisitionBusyError)) throw error;
            const elapsed = performance.now() - started;
            if (elapsed >= FOREGROUND_ACQUISITION_BUDGET_MS) {
                if (elapsed >= 250)
                    console.warn(
                        `[${new Date().toISOString()}] [magic-context] sqlite acquisition site=privileged_writer lane=foreground elapsed=${Math.round(elapsed)}ms attempts=${attempts} outcome=busy`,
                    );
                throw error instanceof SqliteAcquisitionBusyError
                    ? error
                    : new SqliteAcquisitionBusyError(error);
            }
            await new Promise<void>((resolve) =>
                setTimeout(
                    resolve,
                    Math.min(
                        attempts === 1 ? 500 : 1000,
                        FOREGROUND_ACQUISITION_BUDGET_MS - elapsed,
                    ),
                ),
            );
        }
    }
}

function isInTransaction(db: Database): boolean {
    const candidate = db as unknown as { inTransaction?: unknown; isTransaction?: unknown };
    return candidate.inTransaction === true || candidate.isTransaction === true;
}

/**
 * Run a storage operation with the managed-write privilege enabled.
 *
 * The privilege is recorded in the durable `context_privilege_state` table (row
 * id=1, enabled=1) so the guard triggers — which reference that table, never a
 * connection-local UDF — stand down for this connection's writes. The write happens
 * inside a BEGIN IMMEDIATE transaction (single writer), and enabled is cleared back
 * to 0 before commit, so no second connection can ever observe enabled=1. Nesting is
 * tracked by privilegeDepth (outside SQLite): only the outermost scope clears the
 * flag, so an inner scope releasing does not drop permission out from under its caller.
 */
export function withPrivilegedWriter<T>(db: Database, operation: () => T): T {
    const previousDepth = privilegeDepth.get(db) ?? 0;
    const nested = isInTransaction(db);
    const savepoint = "mc_privilege_scope";
    const transactionStartedAt = nested ? undefined : performance.now();
    if (nested) {
        db.exec(`SAVEPOINT ${savepoint}`);
    } else {
        try {
            db.exec("BEGIN IMMEDIATE");
        } catch (error) {
            if (transformPassScope.getStore()?.active && isTransientSqliteError(error))
                throw new SqliteAcquisitionBusyError(error);
            throw error;
        }
    }
    privilegeDepth.set(db, previousDepth + 1);
    try {
        db.prepare(
            "INSERT INTO context_privilege_state(id, enabled) VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET enabled = 1",
        ).run();
        const result = operation();
        if (previousDepth === 0) {
            db.prepare("UPDATE context_privilege_state SET enabled = 0 WHERE id = 1").run();
        }
        if (nested) {
            db.exec(`RELEASE ${savepoint}`);
        } else {
            db.exec("COMMIT");
            if (transactionStartedAt !== undefined) {
                reportSlowPrivilegedWrite?.("privileged_writer", transactionStartedAt);
            }
        }
        if (previousDepth > 0) privilegeDepth.set(db, previousDepth);
        else privilegeDepth.delete(db);
        return result;
    } catch (error) {
        try {
            if (nested) {
                db.exec(`ROLLBACK TO ${savepoint}`);
                db.exec(`RELEASE ${savepoint}`);
            } else {
                db.exec("ROLLBACK");
            }
        } finally {
            if (previousDepth > 0) privilegeDepth.set(db, previousDepth);
            else privilegeDepth.delete(db);
        }
        throw error;
    }
}
