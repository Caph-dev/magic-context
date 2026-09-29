import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    renameSync,
    writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { projectDirectoryKey } from "@magic-context/core/features/magic-context/memory/project-identity-cache";
import {
    auditIdentityMerge,
    type IdentityMergeReport,
    mergeProjectIdentities,
} from "@magic-context/core/features/magic-context/storage-identity-merge";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import { resolveOpenCodeDbPath } from "@magic-context/core/shared/opencode-db-path";
import type { Database } from "@magic-context/core/shared/sqlite";
import {
    CLI_SCHEMA_FLOOR_VERSION,
    openExistingContextDatabase,
    openExistingDatabase,
} from "../lib/database-access";
import { findIdentitySplits, type IdentitySplit } from "./doctor-identity-splits";
import { probeHostProcessesUsing } from "./doctor-opencode2-cache";
import {
    copyDatabaseBundle,
    type DatabaseHolderInspection,
    defaultInspectHolders,
} from "./doctor-repair-db";

export interface MergeIdentityCliOptions {
    from?: string;
    to?: string;
    dryRun: boolean;
    yes: boolean;
    force: boolean;
    dbPath?: string;
    hostPath?: string;
}

export function parseMergeIdentityArgs(args: string[]): MergeIdentityCliOptions {
    const values: Record<string, string> = {};
    const switches = new Set(["--apply", "--force", "--dry-run", "--yes"]);
    for (let i = 0; i < args.length; i++) {
        const flag = args[i];
        if (["--from", "--to", "--db", "--host-db"].includes(flag)) {
            const value = args[++i];
            if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
            if (values[flag]) throw new Error(`Repeated option: ${flag}`);
            values[flag] = value;
        } else if (!switches.has(flag))
            throw new Error(`Unknown doctor merge-identities option: ${flag}`);
    }
    if (Boolean(values["--from"]) !== Boolean(values["--to"]))
        throw new Error("Supply both --from and --to");
    const apply = args.includes("--apply") || args.includes("--yes");
    if (apply && (!values["--from"] || args.includes("--dry-run")))
        throw new Error("--apply requires --from/--to and cannot be combined with --dry-run");
    return {
        from: values["--from"],
        to: values["--to"],
        dbPath: values["--db"],
        hostPath: values["--host-db"],
        dryRun: !apply,
        yes: apply,
        force: args.includes("--force"),
    };
}

function printReport(report: IdentityMergeReport): void {
    console.log(
        `Identity merge ${report.dryRun ? "preview" : "complete"}: ${report.fromIdentity} → ${report.toIdentity}`,
    );
    for (const table of report.auditedTables) {
        console.log(
            `  ${table.tableName}: ${report.dryRun ? table.sourceRows : table.changedRows} row(s)${table.derived ? " (derived; maintained by triggers)" : ""}`,
        );
    }
    for (const change of report.changes) console.log(`  ${change}`);
    console.log(
        `  identical memories collapsed: ${report.duplicateMemoryIds.join(", ") || "none"}`,
    );
    console.log(
        `  potential content conflicts kept for review (same category): ${report.reviewMemoryIds.join(", ") || "none"}`,
    );
    console.log(
        "  Workspace aliases collapse; source-only membership transfers. Target schedules win; next_due_at is recomputed. Queued reasons deduplicate; run history and processed windows remain.",
    );
    console.log(
        "  Git indexes move; sweep leases reset for rebuilding. Existing memory embeddings remain valid (content unchanged); FTS triggers rekey indexes.",
    );
    if (!report.changedRows) console.log("  No-op: no source rows remain to move.");
    if (report.dryRun)
        console.log("  No writes. Review this preview, then repeat with --apply to confirm.");
}

/** Probe Git without populating the resolver's durable cache during a preview. */
function resolveReadOnly(directory: string): string | undefined {
    if (!existsSync(directory)) return undefined;
    try {
        const roots = execFileSync("git", ["rev-list", "--max-parents=0", "HEAD"], {
            cwd: directory,
            windowsHide: true,
            encoding: "utf8",
            timeout: 5000,
            stdio: ["ignore", "pipe", "pipe"],
        })
            .trim()
            .split(/\s+/)
            .filter((root) => /^[0-9a-f]{40,64}$/.test(root))
            .sort();
        if (roots[0]) return `git:${roots[0]}`;
    } catch {
        /* An unreadable repository is not proof of a directory identity. */
    }
    try {
        const result = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
            cwd: directory,
            windowsHide: true,
            encoding: "utf8",
            timeout: 5000,
            stdio: ["ignore", "pipe", "pipe"],
        });
        if (result.trim() === "true") return undefined;
    } catch (error) {
        if (String((error as { stderr?: unknown }).stderr).includes("not a git repository"))
            return `dir:${createHash("md5").update(projectDirectoryKey(directory)).digest("hex").slice(0, 12)}`;
    }
    return undefined;
}

function observations(db: Database, hostPath: string, storageDir: string): IdentitySplit[] {
    const host = openExistingDatabase(hostPath, { readonly: true });
    let rows: IdentitySplit[] = [];
    try {
        rows = host ? findIdentitySplits(db, host, true) : [];
    } finally {
        host?.close();
    }
    const add = (directory: string, identity: string) => {
        if (!/^(git|dir):/.test(identity)) return;
        directory = projectDirectoryKey(directory);
        let row = rows.find((item) => item.directory === directory);
        if (!row) {
            row = { directory, identities: [] };
            rows.push(row);
        }
        if (!row.identities.some((item) => item.identity === identity))
            row.identities.push({ identity, sessions: 0, memories: 0, notes: 0, dreamer: 0 });
    };
    const sidecars = join(storageDir, "project-identities");
    if (existsSync(sidecars))
        for (const file of readdirSync(sidecars)) {
            if (!file.endsWith(".json")) continue;
            try {
                const record = JSON.parse(readFileSync(join(sidecars, file), "utf8"));
                if (typeof record.directory === "string" && typeof record.identity === "string")
                    add(record.directory, record.identity);
            } catch {
                /* Corrupt sidecars cannot establish an identity's directory. */
            }
        }
    for (const row of db
        .prepare("SELECT project_path, display_path FROM workspace_members")
        .all() as Array<{ project_path: string; display_path: string }>)
        add(row.display_path, row.project_path);
    return rows;
}

export interface MergeIdentityDeps {
    inspectHolders: (storageDir: string) => DatabaseHolderInspection;
    probe: typeof probeHostProcessesUsing;
}

export function runMergeIdentityCli(args: string[], deps: Partial<MergeIdentityDeps> = {}): number {
    const options = parseMergeIdentityArgs(args);
    const dbPath = options.dbPath ?? join(getMagicContextStorageDir(), "context.db");
    const storageDir = dirname(dbPath);
    const hostPath =
        options.hostPath ??
        (options.dbPath ? join(storageDir, "host.db") : resolveOpenCodeDbPath().path);
    let db = openExistingContextDatabase(dbPath, {
        readonly: true,
        minimumSupportedVersion: CLI_SCHEMA_FLOOR_VERSION,
    });
    if (!db) throw new Error(`Context database does not exist: ${dbPath}`);
    let directories: string[] = [];
    try {
        const observed = observations(db, hostPath, storageDir);
        if (!options.from || !options.to) {
            for (const split of observed.filter((row) => row.identities.length > 1)) {
                const target =
                    resolveReadOnly(split.directory) ??
                    split.identities
                        .map((row) => row.identity)
                        .filter((id) => id.startsWith("git:"))
                        .sort()[0];
                console.log(`Project identity split: ${split.directory}`);
                for (const row of split.identities)
                    if (row.identity !== target)
                        console.log(`  ${row.identity} → ${target ?? "unresolved target"}`);
            }
            if (!observed.some((row) => row.identities.length > 1))
                console.log("No detected identity splits.");
            return 0;
        }
        if (options.from === options.to)
            throw new Error(`Source and target identities must differ: ${options.from}`);
        for (const identity of [options.from, options.to]) {
            const known =
                auditIdentityMerge(db, identity, options.to).changedRows > 0 ||
                db
                    .prepare(
                        "SELECT 1 FROM v22_identity_rekey_map WHERE old_project_path = ? OR new_project_path = ?",
                    )
                    .get(identity, identity);
            if (!known) throw new Error(`Unknown identity: ${identity}`);
        }
        const sourceDirs = observed
            .filter((row) => row.identities.some((item) => item.identity === options.from))
            .map((row) => row.directory);
        const targetDirs = observed
            .filter((row) => row.identities.some((item) => item.identity === options.to))
            .map((row) => row.directory);
        directories = [...new Set([...sourceDirs, ...targetDirs])];
        const alreadyMerged =
            auditIdentityMerge(db, options.from, options.to).changedRows === 0 &&
            db
                .prepare(
                    "SELECT 1 FROM v22_identity_rekey_map WHERE old_project_path = ? AND new_project_path = ?",
                )
                .get(options.from, options.to);
        if (
            !alreadyMerged &&
            options.from.startsWith("git:") &&
            options.to.startsWith("git:") &&
            (!sourceDirs.length ||
                !targetDirs.length ||
                sourceDirs.some((dir) => !targetDirs.includes(dir)) ||
                targetDirs.some((dir) => !sourceDirs.includes(dir)))
        )
            throw new Error(
                `Refusing different directories for ${options.from} (${sourceDirs.join(", ") || "unknown"}) and ${options.to} (${targetDirs.join(", ") || "unknown"})`,
            );
        if (
            !options.force &&
            !directories.some((directory) => resolveReadOnly(directory) === options.to)
        )
            throw new Error(
                `Target ${options.to} does not resolve for any observed directory on this machine; use --force only after reviewing the identity.`,
            );
        const preview = mergeProjectIdentities(db, options.from, options.to, { dryRun: true });
        printReport(preview);
        if (options.dryRun) return 0;
    } finally {
        db.close();
    }
    const { from, to } = options;
    if (!from || !to) return 0;
    console.log(
        "Checking database holders (bounded process inspection; no changes applied yet)...",
    );
    const holders = (deps.inspectHolders ?? defaultInspectHolders)(storageDir);
    const probe = (deps.probe ?? probeHostProcessesUsing)({
        files: [dbPath, `${dbPath}-wal`, `${dbPath}-shm`],
        directories: [],
    });
    if (!holders.safe || probe.status !== "free")
        throw new Error(
            `Refusing merge: close OpenCode, Pi, OpenCode 2 and ck-mc. ${holders.blockers.join(", ")} ${holders.uncertainty ?? ""} ${probe.status === "in_use" ? `context.db holders: ${probe.pids.join(", ")}` : probe.status === "unknown" ? probe.reason : ""}`,
        );
    const backup = mkdtempSync(join(storageDir, "identity-merge-backup-"));
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    console.log(`Backup directory: ${backup}`);
    console.log(
        `Restore with hosts closed: rm -f ${quote(`${dbPath}-wal`)} ${quote(`${dbPath}-shm`)}; cp ${quote(join(backup, "context.db"))} ${quote(dbPath)}; if test -f ${quote(join(backup, "context.db-wal"))}; then cp ${quote(join(backup, "context.db-wal"))} ${quote(`${dbPath}-wal`)}; fi`,
    );
    const sidecarRoot = join(storageDir, "project-identities");
    const sidecarBackup = join(backup, "project-identities");
    mkdirSync(sidecarBackup);
    if (existsSync(sidecarRoot)) cpSync(sidecarRoot, sidecarBackup, { recursive: true });
    console.log(
        `Restore identity sidecars too: rm -rf ${quote(sidecarRoot)}; cp -R ${quote(sidecarBackup)} ${quote(sidecarRoot)}`,
    );
    copyDatabaseBundle(dbPath, join(backup, "context.db"));
    // The read-only open already checked the schema version. Use the raw writable opener
    // because the context opener may create store metadata before the merge transaction.
    db = openExistingDatabase(dbPath, { readonly: false });
    if (!db) throw new Error(`Context database disappeared: ${dbPath}`);
    try {
        printReport(mergeProjectIdentities(db, from, to));
    } finally {
        db.close();
    }
    if (to.startsWith("git:"))
        for (const directory of directories) {
            const root = join(storageDir, "project-identities");
            mkdirSync(root, { recursive: true });
            const path = join(
                root,
                `${createHash("sha256").update(projectDirectoryKey(directory)).digest("hex")}.json`,
            );
            const temporary = `${path}.merge.tmp`;
            writeFileSync(
                temporary,
                JSON.stringify({ directory: projectDirectoryKey(directory), identity: options.to }),
                { mode: 0o600 },
            );
            renameSync(temporary, path);
        }
    return 0;
}
