import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AsyncProcessInspection } from "@magic-context/core/shared/rpc-utils";
import { Database } from "@magic-context/core/shared/sqlite";
import {
    assertHiddenChildStoresClosed,
    cleanupRetiredHiddenChildren,
} from "./doctor-hidden-children";

function fixture() {
    const dir = mkdtempSync(join(tmpdir(), "mc-doctor-hidden-"));
    const hostDbPath = join(dir, "opencode2.db");
    const contextDbPath = join(dir, "context.db");
    const host = new Database(hostDbPath);
    const context = new Database(contextDbPath);
    host.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT NOT NULL, metadata TEXT);
        CREATE TABLE instruction_entry (session_id TEXT REFERENCES session_v2(id) ON DELETE CASCADE);
        CREATE TABLE instruction_state (session_id TEXT REFERENCES session_v2(id) ON DELETE CASCADE);
        CREATE TABLE session_inbox (session_id TEXT REFERENCES session_v2(id) ON DELETE CASCADE);
        CREATE TABLE session_message (session_id TEXT REFERENCES session_v2(id) ON DELETE CASCADE);
        CREATE TABLE session_pending (session_id TEXT REFERENCES session_v2(id) ON DELETE CASCADE);`);
    context.exec("CREATE TABLE schema_migrations_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    for (const [id, metadata] of [
        ["listed-hidden", '{"magic_context":"hidden-run"}'],
        ["listed-user", "{}"],
        ["unlisted-hidden", '{"magic_context":"hidden-run"}'],
    ]) {
        host.prepare(
            "INSERT INTO session_v2 (id, directory, metadata) VALUES (?, '/fixture', ?)",
        ).run(id, metadata);
        host.prepare("INSERT INTO session_message (session_id) VALUES (?)").run(id);
    }
    context.prepare("INSERT INTO schema_migrations_meta (key, value) VALUES (?, ?)").run(
        "opencode2_hidden_children:/fixture",
        JSON.stringify({
            version: 1,
            active: {},
            retired_children: [
                { id: "listed-hidden", reason: "failed" },
                { id: "listed-user", reason: "failed" },
            ],
        }),
    );
    host.close();
    context.close();
    return {
        hostDbPath,
        contextDbPath,
        cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
}

test("doctor only deletes marked sessions listed as retired, with a backup and cascaded messages", async () => {
    const files = fixture();
    const options = { ...files, inspectHolders: () => {}, fix: true };
    const reports: string[] = [];
    try {
        expect(
            await cleanupRetiredHiddenChildren({
                ...options,
                fix: false,
                report: (line) => reports.push(line),
            }),
        ).toMatchObject({
            waiting: 2,
            deleted: 0,
        });
        expect(reports).toEqual([
            expect.stringContaining("2 retired hidden sessions are waiting for deletion"),
        ]);
        const result = await cleanupRetiredHiddenChildren(options);
        expect(result).toMatchObject({ waiting: 2, deleted: 1 });
        expect(existsSync(result.backup!)).toBe(true);
        const host = new Database(files.hostDbPath, { readonly: true });
        const context = new Database(files.contextDbPath, { readonly: true });
        try {
            expect(
                (
                    host.prepare("SELECT id FROM session_v2 ORDER BY id").all() as Array<{
                        id: string;
                    }>
                ).map((row) => row.id),
            ).toEqual(["listed-user", "unlisted-hidden"]);
            expect(
                (
                    host
                        .prepare("SELECT session_id FROM session_message ORDER BY session_id")
                        .all() as Array<{ session_id: string }>
                ).map((row) => row.session_id),
            ).toEqual(["listed-user", "unlisted-hidden"]);
            const state = JSON.parse(
                (
                    context.prepare("SELECT value FROM schema_migrations_meta").get() as {
                        value: string;
                    }
                ).value,
            );
            expect(state.retired_children.map((row: { id: string }) => row.id)).toEqual([
                "listed-user",
            ]);
        } finally {
            host.close();
            context.close();
        }
    } finally {
        files.cleanup();
    }
});

test("doctor refuses a live holder before backup or any mutation", async () => {
    const files = fixture();
    try {
        await expect(
            cleanupRetiredHiddenChildren({
                ...files,
                fix: true,
                inspectHolders: () => {
                    throw new Error("holder is present");
                },
            }),
        ).rejects.toThrow("holder is present");
        const host = new Database(files.hostDbPath, { readonly: true });
        try {
            expect(host.prepare("SELECT COUNT(*) AS count FROM session_v2").get()).toEqual({
                count: 3,
            });
        } finally {
            host.close();
        }
    } finally {
        files.cleanup();
    }
});

test("the default holder inspection refuses an open fixture database", async () => {
    const files = fixture();
    const held = new Database(files.hostDbPath);
    try {
        await expect(
            assertHiddenChildStoresClosed(files.contextDbPath, files.hostDbPath),
        ).rejects.toThrow("database holder");
    } finally {
        held.close();
        files.cleanup();
    }
}, 30_000);

test("doctor refuses an unknown cascade schema", async () => {
    const files = fixture();
    try {
        const host = new Database(files.hostDbPath);
        host.exec("DROP TABLE session_pending");
        host.close();
        await expect(
            cleanupRetiredHiddenChildren({ ...files, fix: true, inspectHolders: () => {} }),
        ).rejects.toThrow("cascade schema differs");
    } finally {
        files.cleanup();
    }
});

function windowsProbe(
    facts: Array<{ pid: number; imageName: string | null; commandLine: string | null }> = [],
): Promise<AsyncProcessInspection> {
    return Promise.resolve({
        pi: { state: "known", processIds: [] },
        processSnapshot: { source: "cim", facts },
        evidence: () => ({ startTime: null, commandLine: null }),
        liveness: () => "dead",
    });
}

test("Windows doctor refuses a running OpenCode process before backup", async () => {
    const files = fixture();
    try {
        await expect(
            cleanupRetiredHiddenChildren({
                ...files,
                fix: true,
                platform: "win32",
                processProbe: () =>
                    windowsProbe([
                        { pid: 1234, imageName: "opencode.exe", commandLine: "opencode serve" },
                    ]),
            }),
        ).rejects.toThrow("PID 1234");
        expect(existsSync(`${files.hostDbPath}.hidden-child-backup`)).toBe(false);
    } finally {
        files.cleanup();
    }
});

test("Windows doctor refuses an unreadable or image-only process snapshot", async () => {
    const files = fixture();
    try {
        await expect(
            cleanupRetiredHiddenChildren({
                ...files,
                fix: true,
                platform: "win32",
                processProbe: async () => ({
                    ...(await windowsProbe()),
                    processSnapshot: { source: "tasklist", facts: [] },
                }),
            }),
        ).rejects.toThrow("could not rule out");
        await expect(
            cleanupRetiredHiddenChildren({
                ...files,
                fix: true,
                platform: "win32",
                processProbe: async () => {
                    throw new Error("CIM denied");
                },
            }),
        ).rejects.toThrow("CIM denied");
    } finally {
        files.cleanup();
    }
});

test("Windows doctor refuses either held database lock and repairs once both are clear", async () => {
    const files = fixture();
    let held: Database | undefined;
    try {
        for (const path of [files.hostDbPath, files.contextDbPath]) {
            let scans = 0;
            await expect(
                cleanupRetiredHiddenChildren({
                    ...files,
                    fix: true,
                    platform: "win32",
                    processProbe: () => {
                        if (++scans === 2) {
                            held = new Database(path);
                            held.exec("BEGIN EXCLUSIVE");
                        }
                        return windowsProbe();
                    },
                }),
            ).rejects.toThrow("Cannot acquire exclusive locks");
            held?.exec("ROLLBACK");
            held?.close();
            held = undefined;
            // Backup names use millisecond timestamps; separate successive repair attempts.
            await Bun.sleep(2);
            const host = new Database(files.hostDbPath, { readonly: true });
            try {
                expect(host.prepare("SELECT COUNT(*) AS count FROM session_v2").get()).toEqual({
                    count: 3,
                });
            } finally {
                host.close();
            }
        }
        expect(
            await cleanupRetiredHiddenChildren({
                ...files,
                fix: true,
                platform: "win32",
                processProbe: windowsProbe,
            }),
        ).toMatchObject({ waiting: 2, deleted: 1 });
    } finally {
        if (held) {
            held.exec("ROLLBACK");
            held.close();
        }
        files.cleanup();
    }
});
