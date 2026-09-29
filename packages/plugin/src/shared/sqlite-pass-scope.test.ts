import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    Database,
    SqliteAcquisitionBusyError,
    withAsyncPrivilegedWriter,
    withPrivilegedWriter,
    withSqliteTransformPass,
} from "./sqlite";
import { startSqliteWriteLocker } from "./sqlite-write-locker-test-support";

function fixture() {
    const dir = mkdtempSync(join(tmpdir(), "mc-busy-yield-"));
    const path = join(dir, "context.db");
    const db = new Database(path);
    db.exec(
        "PRAGMA journal_mode=WAL; CREATE TABLE context_privilege_state(id INTEGER PRIMARY KEY, enabled INTEGER)",
    );
    db.exec("PRAGMA busy_timeout=5000");
    return {
        db,
        path,
        close: () => {
            db.close();
            rmSync(dir, { recursive: true, force: true });
        },
    };
}

test("background acquisition yields quickly and restores the original timeout", () => {
    const { db, path, close } = fixture();
    const blocker = new Database(path);
    blocker.exec("BEGIN IMMEDIATE");
    let calls = 0;
    try {
        const start = performance.now();
        expect(() => db.transaction(() => calls++)()).toThrow();
        expect(performance.now() - start).toBeLessThan(250);
        expect(calls).toBe(0);
        expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
    } finally {
        blocker.exec("ROLLBACK");
        blocker.close();
        close();
    }
});

test("foreground admission keeps the loop ticking while a separate writer holds the lock", async () => {
    const { db, path, close } = fixture();
    const locker = await startSqliteWriteLocker(path, 650);
    let timerFired = false;
    let calls = 0;
    try {
        setTimeout(() => {
            timerFired = true;
        }, 100);
        await withSqliteTransformPass(() =>
            withAsyncPrivilegedWriter(db, () => {
                calls++;
            }),
        );
        expect(timerFired).toBe(true);
        expect(calls).toBe(1);
        expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
    } finally {
        await locker.exited;
        close();
    }
}, 30000);

test("a foreground synchronous writer refuses busy without blocking the loop", () => {
    const { db, path, close } = fixture();
    const blocker = new Database(path);
    blocker.exec("BEGIN IMMEDIATE");
    try {
        const start = performance.now();
        expect(() =>
            withSqliteTransformPass(() => withPrivilegedWriter(db, () => undefined)),
        ).toThrow(SqliteAcquisitionBusyError);
        expect(performance.now() - start).toBeLessThan(250);
        expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
    } finally {
        blocker.exec("ROLLBACK");
        blocker.close();
        close();
    }
});
