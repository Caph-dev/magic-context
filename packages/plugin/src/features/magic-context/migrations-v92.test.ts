/// <reference types="bun-types" />
import { expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { MIGRATIONS, runMigrations } from "./migrations";
import { insertMemory } from "./memory/storage-memory";
import { initializeDatabase } from "./storage-db";

test("v92 steps over populated v91 without changing domain or mirror rows", () => {
    const db = new Database(":memory:");
    try {
        // The migration chain assumes the bootstrap tables already exist.
        initializeDatabase(db);
        db.exec(
            "DROP TABLE single_store_state; CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL, description TEXT)",
        );
        for (const migration of MIGRATIONS.filter((m) => m.version <= 91)) {
            migration.up(db);
            db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, 0)").run(
                migration.version,
            );
        }
        insertMemory(db, {
            projectPath: "git:populated",
            category: "ARCHITECTURE",
            content: "Preserve domain rows through v92",
        });
        const memoriesBefore = db.prepare("SELECT * FROM memories").all();
        db.exec("INSERT INTO memory_embedding_watermarks VALUES ('git:p', 42, 7, 100)");
        db.exec(
            "INSERT INTO authority_managed(project_path, context_store_uuid, marked_at) VALUES ('git:p', 'uuid', 100)",
        );
        const before = db.prepare("SELECT * FROM authority_managed").all();
        expect(
            db.prepare("SELECT name FROM sqlite_master WHERE name='single_store_state'").get(),
        ).toBeNull();
        runMigrations(db);
        expect(db.prepare("SELECT * FROM single_store_state").get()).toEqual({
            id: 1,
            state: "required",
            migrated_at: null,
            migrated_by: null,
            backup_dir: null,
            report_json: null,
        });
        expect(db.prepare("SELECT * FROM authority_managed").all()).toEqual(before);
        expect(db.prepare("SELECT * FROM memories").all()).toEqual(memoriesBefore);
        expect(db.prepare("SELECT * FROM memory_embedding_watermarks").get()).toEqual({
            project_path: "git:p",
            written_memory_id: 42,
            embedded_memory_id: 7,
            updated_at: 100,
        });
        expect(() =>
            db.exec("INSERT INTO single_store_state(id,state) VALUES (2,'required')"),
        ).toThrow();
        expect(() => db.exec("UPDATE single_store_state SET state='other'")).toThrow();
        db.exec(
            "UPDATE single_store_state SET state='migrated', migrated_at=123, migrated_by='build', backup_dir='/backup', report_json='{}'",
        );
        MIGRATIONS.find((m) => m.version === 92)!.up(db);
        expect(db.prepare("SELECT state, migrated_at FROM single_store_state").get()).toEqual({
            state: "migrated",
            migrated_at: 123,
        });
    } finally {
        db.close();
    }
});

test("fresh schema includes the required singleton", () => {
    const db = new Database(":memory:");
    try {
        initializeDatabase(db);
        expect(db.prepare("SELECT id, state FROM single_store_state").get()).toEqual({
            id: 1,
            state: "required",
        });
    } finally {
        db.close();
    }
});
