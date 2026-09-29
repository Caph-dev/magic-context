import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import {
    type AsyncProcessInspection,
    inspectProcessesAsync,
} from "@magic-context/core/shared/rpc-utils";
import { Database } from "@magic-context/core/shared/sqlite";
import { copyDatabaseBundle, defaultInspectHolders } from "./doctor-repair-db";
import { assertWindowsStoresClosed } from "./doctor-windows-holders";

const PREFIX = "opencode2_hidden_children:";
const CASCADE_TABLES = [
    "instruction_entry",
    "instruction_state",
    "session_inbox",
    "session_message",
    "session_pending",
] as const;

export interface HiddenChildCleanupOptions {
    contextDbPath: string;
    hostDbPath: string;
    fix?: boolean;
    inspectHolders?: (contextDbPath: string, hostDbPath: string) => void | Promise<void>;
    platform?: NodeJS.Platform;
    processProbe?: () => Promise<AsyncProcessInspection>;
    report?: (message: string) => void;
}

/** A failed process inspection must never be interpreted as a store with no holders. */
export async function assertHiddenChildStoresClosed(
    contextDbPath: string,
    hostDbPath: string,
    platform: NodeJS.Platform = process.platform,
    processProbe: () => Promise<AsyncProcessInspection> = () => inspectProcessesAsync(true),
): Promise<void> {
    if (platform === "win32") {
        assertWindowsStoresClosed([contextDbPath, hostDbPath], await processProbe());
        return;
    }
    const inspection = defaultInspectHolders(dirname(contextDbPath));
    if (!inspection.safe) {
        throw new Error(
            `database holders cannot be ruled out: ${[...inspection.blockers, inspection.uncertainty].filter(Boolean).join("; ")}`,
        );
    }
    const paths = [contextDbPath, hostDbPath].flatMap((path) =>
        [path, `${path}-wal`, `${path}-shm`].filter(existsSync).map((file) => realpathSync(file)),
    );
    const result = spawnSync("lsof", ["-Fn", "--", ...paths], {
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
    });
    if (
        result.error ||
        result.stderr?.trim() ||
        (result.status !== 0 && !(result.status === 1 && !result.stdout?.trim()))
    ) {
        throw new Error(
            `lsof could not inspect database holders: ${result.error?.message ?? result.stderr ?? result.status}`,
        );
    }
    const opened = result.stdout.split("\n").filter((line) => line.startsWith("n"));
    if (opened.length)
        throw new Error(
            `database holder is present: ${opened.map((line) => line.slice(1)).join(", ")}`,
        );
    if (result.status === 0) throw new Error("lsof returned success without any file evidence");
}

function assertVerifiedV2Schema(db: Database): void {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
    }>;
    const names = new Set(table.map((row) => row.name));
    if (
        !names.has("session_v2") ||
        !names.has("session_message") ||
        names.has("message") ||
        names.has("part")
    ) {
        throw new Error("OpenCode store is not the verified OpenCode 2 session_v2 schema");
    }
    const fields = db.prepare("PRAGMA table_info('session_v2')").all() as Array<{
        name: string;
        pk: number;
    }>;
    if (
        !fields.some((field) => field.name === "id" && field.pk === 1) ||
        !fields.some((field) => field.name === "metadata") ||
        !fields.some((field) => field.name === "directory")
    ) {
        throw new Error("OpenCode session_v2 columns differ from the verified schema");
    }
    const dependents = table.flatMap(({ name }) => {
        const foreignKeys = db
            .prepare(`PRAGMA foreign_key_list('${name.replaceAll("'", "''")}')`)
            .all() as Array<{
            table: string;
            from: string;
            to: string;
            on_delete: string;
        }>;
        return foreignKeys
            .filter((key) => key.table === "session_v2")
            .map((key) => ({ name, ...key }));
    });
    if (
        dependents.length !== CASCADE_TABLES.length ||
        dependents.some(
            (key) =>
                !CASCADE_TABLES.includes(key.name as (typeof CASCADE_TABLES)[number]) ||
                key.from !== "session_id" ||
                key.to !== "id" ||
                key.on_delete !== "CASCADE",
        )
    ) {
        throw new Error("OpenCode session_v2 cascade schema differs from the verified 2.0.18 host");
    }
}

interface HiddenState {
    version: number;
    retired_children: Array<{ id: string; [key: string]: unknown }>;
    [key: string]: unknown;
}

export async function cleanupRetiredHiddenChildren(options: HiddenChildCleanupOptions): Promise<{
    waiting: number;
    deleted: number;
    backup?: string;
}> {
    const { contextDbPath, hostDbPath, fix = false } = options;
    if (!existsSync(contextDbPath) || !existsSync(hostDbPath)) return { waiting: 0, deleted: 0 };
    const context = new Database(contextDbPath, { readonly: true, fileMustExist: true });
    const host = new Database(hostDbPath, { readonly: true, fileMustExist: true });
    let states: Array<{ key: string; state: HiddenState }>;
    let candidates: string[];
    let waiting: number;
    try {
        assertVerifiedV2Schema(host);
        const rows = context
            .prepare("SELECT key, value FROM schema_migrations_meta WHERE substr(key, 1, ?) = ?")
            .all(PREFIX.length, PREFIX) as Array<{ key: string; value: string }>;
        states = rows.map(({ key, value }) => {
            const state = JSON.parse(value) as HiddenState;
            if (
                state.version !== 1 ||
                !Array.isArray(state.retired_children) ||
                state.retired_children.some((child) => typeof child.id !== "string")
            ) {
                throw new Error(`Invalid hidden-child state at ${key}`);
            }
            return { key, state };
        });
        const ids = [
            ...new Set(
                states.flatMap(({ state }) => state.retired_children.map((child) => child.id)),
            ),
        ];
        waiting = ids.length;
        candidates = ids.filter((id) => {
            const row = host.prepare("SELECT metadata FROM session_v2 WHERE id = ?").get(id) as
                | { metadata: string | null }
                | undefined;
            if (!row) return false;
            let marker: unknown;
            try {
                marker = JSON.parse(row.metadata ?? "null");
            } catch {
                return false;
            }
            return (marker as { magic_context?: unknown } | null)?.magic_context === "hidden-run";
        });
    } finally {
        context.close();
        host.close();
    }
    options.report?.(
        `${waiting} retired hidden sessions are waiting for deletion${fix ? "" : "; run `doctor --fix` with OpenCode closed"}`,
    );
    if (!fix || candidates.length === 0) return { waiting, deleted: 0 };

    const inspect =
        options.inspectHolders ??
        ((context: string, host: string) =>
            assertHiddenChildStoresClosed(context, host, options.platform, options.processProbe));
    await inspect(contextDbPath, hostDbPath);
    const backup = `${hostDbPath}.hidden-child-backup-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
    copyDatabaseBundle(hostDbPath, backup);
    options.report?.(`OpenCode store backup: ${backup}`);
    await inspect(contextDbPath, hostDbPath);
    const writableHost = new Database(hostDbPath);
    let writableContext: Database | undefined;
    const deletedIds: string[] = [];
    let hostLocked = false;
    let contextLocked = false;
    try {
        writableHost.exec("PRAGMA busy_timeout = 250");
        writableHost.exec("PRAGMA foreign_keys = ON");
        writableContext = new Database(contextDbPath);
        writableContext.exec("PRAGMA busy_timeout = 250");
        try {
            writableHost.exec("BEGIN EXCLUSIVE");
            hostLocked = true;
            writableContext.exec("BEGIN EXCLUSIVE");
            contextLocked = true;
        } catch (error) {
            throw new Error(
                `Cannot acquire exclusive locks on ${hostDbPath} and ${contextDbPath}: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
        assertVerifiedV2Schema(writableHost);
        for (const id of candidates) {
            const result = writableHost
                .prepare(
                    "DELETE FROM session_v2 WHERE id = ? AND json_valid(metadata) AND json_extract(metadata, '$.magic_context') = 'hidden-run'",
                )
                .run(id);
            if (result.changes > 0) deletedIds.push(id);
        }
        for (const { key } of states) {
            const current = writableContext
                .prepare("SELECT value FROM schema_migrations_meta WHERE key = ?")
                .get(key) as { value: string } | undefined;
            if (!current) throw new Error(`Hidden-child state ${key} disappeared during repair`);
            const state = JSON.parse(current.value) as HiddenState;
            if (state.version !== 1 || !Array.isArray(state.retired_children)) {
                throw new Error(`Hidden-child state ${key} changed during repair`);
            }
            state.retired_children = state.retired_children.filter(
                (child) => !deletedIds.includes(child.id),
            );
            writableContext
                .prepare("UPDATE schema_migrations_meta SET value = ? WHERE key = ?")
                .run(JSON.stringify(state), key);
        }
        writableHost.exec("COMMIT");
        hostLocked = false;
        writableContext.exec("COMMIT");
        contextLocked = false;
    } finally {
        if (contextLocked) writableContext?.exec("ROLLBACK");
        if (hostLocked) writableHost.exec("ROLLBACK");
        writableContext?.close();
        writableHost.close();
    }
    options.report?.(`Deleted ${deletedIds.length} marked, recorded hidden sessions`);
    return { waiting, deleted: deletedIds.length, backup };
}
