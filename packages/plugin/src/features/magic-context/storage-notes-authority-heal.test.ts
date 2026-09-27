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

function insertParkedSessionNote(db: Database, sessionId: string, content: string): number {
    const row = db
        .prepare(
            "INSERT INTO notes (type, status, content, session_id, surface_condition, created_at, updated_at) VALUES ('session', 'pending', ?, ?, 'orphaned condition', 1, 1) RETURNING id",
        )
        .get(content, sessionId) as { id: number };
    return row.id;
}

function noteState(db: Database, id: number): { status: string; surface_condition: string | null } {
    return db.prepare("SELECT status, surface_condition FROM notes WHERE id = ?").get(id) as {
        status: string;
        surface_condition: string | null;
    };
}

describe("pending session note heal under Rust note authority", () => {
    test("a note read skips module-owned rows instead of tripping the authority trigger", () => {
        const db = openDb();
        const managedId = insertParkedSessionNote(db, "ses-managed", "owned by the module");
        const localId = insertParkedSessionNote(db, "ses-local", "owned by TypeScript");
        // Link the first session to a project and hand that project's notes to the
        // module, which is the state of the host read model while Rust mode runs.
        db.prepare(
            "INSERT INTO session_projects (session_id, harness, project_path, updated_at) VALUES ('ses-managed', 'opencode', 'git:managed', 0)",
        ).run();
        db.prepare(
            "INSERT INTO authority_managed (project_path, context_store_uuid, marked_at) VALUES ('git:managed', 'store', 1)",
        ).run();

        // The note-nudge check and the smart-note sweeps both read through these.
        expect(() => getSessionNotes(db, "ses-managed")).not.toThrow();
        expect(() => getNotes(db, { sessionId: "ses-local" })).not.toThrow();

        // The module heals its own row and mirrors the result; the host leaves it.
        expect(noteState(db, managedId)).toEqual({
            status: "pending",
            surface_condition: "orphaned condition",
        });
        // A row TypeScript still owns is healed as before.
        expect(noteState(db, localId)).toEqual({ status: "active", surface_condition: null });
    });
});
