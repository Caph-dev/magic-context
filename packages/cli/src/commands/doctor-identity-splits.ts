import { realpathSync } from "node:fs";
import { join } from "node:path";
import { projectDirectoryKey } from "@magic-context/core/features/magic-context/memory/project-identity-cache";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import { resolveOpenCodeDbPath } from "@magic-context/core/shared/opencode-db-path";
import type { Database } from "@magic-context/core/shared/sqlite";
import { openExistingContextDatabase, openExistingDatabase } from "../lib/database-access";

export interface IdentitySplit {
    directory: string;
    identities: Array<{
        identity: string;
        sessions: number;
        memories: number;
        notes: number;
        dreamer: number;
    }>;
}

function tableExists(db: Database, table: string): boolean {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

/** Join only observed session bindings; never infer that two repositories should be merged. */
export function findIdentitySplits(
    db: Database,
    host: Database,
    includeSingles = false,
): IdentitySplit[] {
    if (!tableExists(db, "session_projects")) return [];
    const directories = new Map<string, Set<string>>();
    for (const table of ["session", "session_v2"]) {
        if (!tableExists(host, table)) continue;
        const rows = host
            .prepare(`SELECT id, directory FROM ${table} WHERE directory IS NOT NULL`)
            .all() as Array<{ id: string; directory: string }>;
        for (const row of rows) {
            if (!row.directory) continue;
            let canonical = row.directory;
            try {
                canonical = realpathSync.native(canonical);
            } catch {
                /* Historical paths need not still exist. */
            }
            const key = `${table === "session" ? "opencode" : "opencode2"}\0${row.id}`;
            const roots = directories.get(key) ?? new Set<string>();
            roots.add(projectDirectoryKey(canonical));
            directories.set(key, roots);
        }
    }
    const byDirectory = new Map<string, Set<string>>();
    const bindings = db
        .prepare(
            "SELECT session_id, harness, project_path FROM session_projects WHERE harness IN ('opencode', 'opencode2')",
        )
        .all() as Array<{ session_id: string; harness: string; project_path: string }>;
    for (const row of bindings) {
        if (!/^(git|dir):/.test(row.project_path)) continue;
        for (const directory of directories.get(`${row.harness}\0${row.session_id}`) ?? []) {
            const identities = byDirectory.get(directory) ?? new Set<string>();
            identities.add(row.project_path);
            byDirectory.set(directory, identities);
        }
    }
    const count = (table: string, identity: string): number =>
        tableExists(db, table)
            ? (
                  db
                      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_path = ?`)
                      .get(identity) as { n: number }
              ).n
            : 0;
    return [...byDirectory]
        .filter(([, identities]) => includeSingles || identities.size > 1)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([directory, identities]) => ({
            directory,
            identities: [...identities].sort().map((identity) => ({
                identity,
                sessions: count("session_projects", identity),
                memories: count("memories", identity),
                notes: count("notes", identity),
                dreamer: [
                    "dream_queue",
                    "dream_runs",
                    "task_schedule_state",
                    "retrospective_processed_windows",
                ].reduce((n, table) => n + count(table, identity), 0),
            })),
        }));
}

export function formatIdentitySplits(splits: IdentitySplit[]): string[] {
    return splits.flatMap((split) => [
        `Project identity split: ${split.directory} (read-only; no merge performed)`,
        ...split.identities.map(
            (row) =>
                `  ${row.identity}: ${row.sessions} sessions, ${row.memories} memories, ${row.notes} notes, ${row.dreamer} dreamer rows (identity-wide counts)`,
        ),
    ]);
}

export function diagnoseIdentitySplits(): string[] {
    const db = openExistingContextDatabase(join(getMagicContextStorageDir(), "context.db"), {
        readonly: true,
    });
    if (!db) return [];
    let host: Database | null = null;
    try {
        host = openExistingDatabase(resolveOpenCodeDbPath().path, { readonly: true });
        if (!host)
            return ["Identity split check skipped: OpenCode session directories unavailable."];
        return formatIdentitySplits(findIdentitySplits(db, host));
    } finally {
        host?.close();
        db.close();
    }
}
