/// <reference types="bun-types" />

// Adversarial checks for the pending-session-note heal that runs on every note
// read. Rows of a project whose notes the Rust module owns must be left alone
// (the notes authority triggers abort any unprivileged write to them); every
// other parked row must still heal, and a database without the ownership tables
// must heal exactly as before.

import { describe, expect, test } from "bun:test";

import { Database } from "../../shared/sqlite";
import { runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";
import { getNotes, getSessionNotes } from "./storage-notes";

function openDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function insertParkedSessionNote(
    db: Database,
    sessionId: string,
    projectPath: string | null = null,
): number {
    const row = db
        .prepare(
            "INSERT INTO notes (type, status, content, session_id, project_path, surface_condition, created_at, updated_at) VALUES ('session', 'pending', 'parked', ?, ?, 'orphaned condition', 1, 1) RETURNING id",
        )
        .get(sessionId, projectPath) as { id: number };
    return row.id;
}

function linkSession(db: Database, sessionId: string, projectPath: string): void {
    db.prepare(
        "INSERT INTO session_projects (session_id, harness, project_path, updated_at) VALUES (?, 'opencode', ?, 0)",
    ).run(sessionId, projectPath);
}

function markManaged(db: Database, projectPath: string): void {
    db.prepare(
        "INSERT INTO authority_managed (project_path, context_store_uuid, marked_at) VALUES (?, 'store', 1)",
    ).run(projectPath);
}

function markRepairPending(db: Database, projectPath: string): void {
    db.prepare("INSERT INTO authority_repair_pending (project_path, started_at) VALUES (?, 1)").run(
        projectPath,
    );
}

function state(db: Database, id: number): string {
    const row = db.prepare("SELECT status, surface_condition FROM notes WHERE id = ?").get(id) as {
        status: string;
        surface_condition: string | null;
    };
    return `${row.status}/${row.surface_condition ?? "null"}`;
}

const PARKED = "pending/orphaned condition";
const HEALED = "active/null";

describe("pending session note heal: ownership scoping", () => {
    test("a host-owned note heals while another project is module-owned", () => {
        const db = openDb();
        // Insert the rows before handing ownership to the module: the ownership
        // insert trigger refuses them afterwards.
        const owned = insertParkedSessionNote(db, "ses-owned");
        const host = insertParkedSessionNote(db, "ses-host");
        const unlinked = insertParkedSessionNote(db, "ses-unlinked");
        linkSession(db, "ses-owned", "git:owned");
        linkSession(db, "ses-host", "git:host");
        markManaged(db, "git:owned");

        expect(() => getSessionNotes(db, "ses-host")).not.toThrow();

        expect(state(db, owned)).toBe(PARKED);
        expect(state(db, host)).toBe(HEALED);
        expect(state(db, unlinked)).toBe(HEALED);
    });

    test("every row the authority triggers guard is skipped, and none of them throws", () => {
        const db = openDb();
        // Owned through the note's own project_path, with no session link.
        const direct = insertParkedSessionNote(db, "ses-direct", "git:direct");
        // Owned through a project whose repair is still pending, directly and by link.
        const repairDirect = insertParkedSessionNote(db, "ses-repair-direct", "git:repair");
        const repairLinked = insertParkedSessionNote(db, "ses-repair-linked");
        // A note that names an unmanaged project but belongs to a managed session.
        const cross = insertParkedSessionNote(db, "ses-cross", "git:elsewhere");
        const host = insertParkedSessionNote(db, "ses-host", "git:elsewhere");
        markManaged(db, "git:direct");
        markRepairPending(db, "git:repair");
        linkSession(db, "ses-repair-linked", "git:repair");
        linkSession(db, "ses-cross", "git:direct");

        expect(() => getNotes(db, { sessionId: "ses-host" })).not.toThrow();
        expect(() => getSessionNotes(db, "ses-direct")).not.toThrow();

        expect(state(db, direct)).toBe(PARKED);
        expect(state(db, repairDirect)).toBe(PARKED);
        expect(state(db, repairLinked)).toBe(PARKED);
        expect(state(db, cross)).toBe(PARKED);
        expect(state(db, host)).toBe(HEALED);
    });

    test("an unprivileged direct UPDATE of a skipped row is still refused (the skip is what avoids it)", () => {
        const db = openDb();
        const direct = insertParkedSessionNote(db, "ses-direct", "git:direct");
        markManaged(db, "git:direct");
        expect(() =>
            db
                .prepare(
                    "UPDATE notes SET status = 'active', surface_condition = NULL WHERE id = ?",
                )
                .run(direct),
        ).toThrow(/managed by the Rust module/);
    });

    test("a database without the ownership tables heals every parked row as before", () => {
        const db = openDb();
        db.exec(`
            DROP TRIGGER IF EXISTS notes_authority_guard_insert;
            DROP TRIGGER IF EXISTS notes_authority_guard_update;
            DROP TRIGGER IF EXISTS notes_authority_guard_delete;
            DROP TRIGGER IF EXISTS memories_authority_guard_insert;
            DROP TRIGGER IF EXISTS memories_authority_guard_update;
            DROP TRIGGER IF EXISTS memories_authority_guard_delete;
            DROP TABLE authority_managed;
            DROP TABLE authority_repair_pending;
        `);
        const first = insertParkedSessionNote(db, "ses-a", "git:a");
        const second = insertParkedSessionNote(db, "ses-b");

        expect(() => getSessionNotes(db, "ses-a")).not.toThrow();

        expect(state(db, first)).toBe(HEALED);
        expect(state(db, second)).toBe(HEALED);
    });
});
