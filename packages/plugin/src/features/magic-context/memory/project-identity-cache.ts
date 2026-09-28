import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getMagicContextStorageDir } from "../../../shared/data-path";

/** Normalize Windows-formatted directory paths consistently, even on a non-Windows OS. */
export function projectDirectoryKey(directory: string): string {
    const slashed = directory
        .replaceAll("\\", "/")
        .replace(/^\/\/\?\/UNC\//i, "//")
        .replace(/^\/\/\?\//, "");
    if (/^[a-z]:\//i.test(slashed) || slashed.startsWith("//")) {
        return path.win32.normalize(slashed).replaceAll("\\", "/").replace(/\/$/, "").toLowerCase();
    }
    return path.resolve(directory);
}

function cachePath(directory: string): string {
    const hash = createHash("sha256").update(projectDirectoryKey(directory)).digest("hex");
    return path.join(getMagicContextStorageDir(), "project-identities", `${hash}.json`);
}

/** A small atomic sidecar avoids opening or migrating the store during plugin boot. */
export function rememberGitIdentity(directory: string, identity: string): void {
    try {
        const destination = cachePath(directory);
        mkdirSync(path.dirname(destination), { recursive: true });
        const temporary = `${destination}.${randomUUID()}.tmp`;
        writeFileSync(
            temporary,
            JSON.stringify({ directory: projectDirectoryKey(directory), identity }),
            { mode: 0o600 },
        );
        renameSync(temporary, destination);
    } catch {
        // Read-only storage must not turn a successful git probe into a failure.
    }
}

export function readRememberedGitIdentity(directory: string): string | undefined {
    try {
        const record = JSON.parse(readFileSync(cachePath(directory), "utf8"));
        if (
            record.directory === projectDirectoryKey(directory) &&
            /^git:[0-9a-f]{7,64}$/.test(record.identity)
        )
            return record.identity;
    } catch {
        // Missing or damaged cache entries defer resolution rather than inventing an identity.
    }
    return undefined;
}
