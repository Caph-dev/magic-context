import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
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

/** Report observed bindings and data left behind when a first commit changes the directory identity to git; never merge. */
export function findIdentitySplits(
    db: Database,
    host: Database,
    includeSingles = false,
): IdentitySplit[] {
    if (!tableExists(db, "session_projects")) return [];
    const directories = new Map<string, Set<string>>();
    const directorySpellings = new Map<string, Set<string>>();
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
            const directoryKey = projectDirectoryKey(canonical);
            roots.add(directoryKey);
            // Directory identities hash the original spelling, not the normalized grouping key.
            const spellings = directorySpellings.get(directoryKey) ?? new Set<string>();
            spellings.add(row.directory);
            spellings.add(canonical);
            directorySpellings.set(directoryKey, spellings);
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
    // A first commit can strand directory-scoped data before any git-bound session is recorded.
    for (const [directoryKey, spellings] of directorySpellings) {
        for (const directory of spellings) {
            const dirIdentity = `dir:${createHash("md5").update(resolve(directory), "utf8").digest("hex").slice(0, 12)}`;
            const hasData = [
                "memories",
                "notes",
                "dream_queue",
                "dream_runs",
                "task_schedule_state",
                "retrospective_processed_windows",
            ].some((table) => count(table, dirIdentity) > 0);
            if (!hasData) continue;
            try {
                // Probe git directly: doctor must not write the identity sidecar or migrate a store.
                const roots = execFileSync("git", ["rev-list", "--max-parents=0", "HEAD"], {
                    cwd: directory,
                    encoding: "utf8",
                    timeout: 5_000,
                    stdio: ["ignore", "pipe", "pipe"],
                    windowsHide: true,
                })
                    .trim()
                    .split(/\r?\n/)
                    .filter((root) => /^[0-9a-f]{7,64}$/.test(root))
                    .sort();
                if (!roots[0]) continue;
                const identities = byDirectory.get(directoryKey) ?? new Set<string>();
                identities.add(dirIdentity);
                identities.add(`git:${roots[0]}`);
                byDirectory.set(directoryKey, identities);
            } catch {
                // Missing paths, unborn repositories, and transient git failures are not split evidence.
            }
        }
    }
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
        "  Review with doctor merge-identities before choosing which identity to keep.",
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
