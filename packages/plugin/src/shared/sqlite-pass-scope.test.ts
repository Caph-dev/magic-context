import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    Database,
    withoutSqliteTransformPass,
    withPrivilegedWriter,
    withSqliteTransformPass,
} from "./sqlite";

test("background privileged acquisition attempts once without backoff", () => {
    const db = new Database(":memory:");
    const error = Object.assign(new Error("original busy"), { code: "SQLITE_BUSY" });
    const exec = spyOn(db, "exec").mockImplementation(() => {
        throw error;
    });
    const wait = spyOn(Atomics, "wait").mockReturnValue("timed-out");
    let callbacks = 0;
    try {
        expect(() => withPrivilegedWriter(db, () => callbacks++)).toThrow("original busy");
        expect(exec).toHaveBeenCalledTimes(1);
        expect(wait).not.toHaveBeenCalled();
        expect(callbacks).toBe(0);
    } finally {
        exec.mockRestore();
        wait.mockRestore();
        db.close();
    }
});

test("background transaction exhausts one five-second busy timeout", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-background-busy-"));
    const path = join(dir, "context.db");
    const blocker = new Database(path);
    const writer = new Database(path);
    blocker.exec("PRAGMA journal_mode=WAL; CREATE TABLE result(value TEXT)");
    writer.exec("PRAGMA busy_timeout=5000");
    blocker.exec("BEGIN IMMEDIATE");
    let callbacks = 0;
    try {
        const start = performance.now();
        expect(() => writer.transaction(() => callbacks++)()).toThrow();
        const elapsed = performance.now() - start;
        expect(callbacks).toBe(0);
        expect(elapsed).toBeGreaterThanOrEqual(4500);
        expect(elapsed).toBeLessThan(7500);
    } finally {
        blocker.exec("ROLLBACK");
        blocker.close();
        writer.close();
        rmSync(dir, { recursive: true, force: true });
    }
}, 30000);

test("foreground retry scope crosses awaits, nests and excludes detached maintenance", async () => {
    const db = new Database(":memory:");
    const error = Object.assign(new Error("busy"), { code: "SQLITE_BUSY" });
    const exec = spyOn(db, "exec").mockImplementation(() => {
        throw error;
    });
    const wait = spyOn(Atomics, "wait").mockReturnValue("timed-out");
    const acquire = () =>
        withPrivilegedWriter(db, () => {
            throw new Error("callback must not run");
        });
    let late: Promise<void> | undefined;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    try {
        await withSqliteTransformPass(async () => {
            await Promise.resolve();
            expect(() => withSqliteTransformPass(acquire)).toThrow("after 3 attempts");
            expect(exec).toHaveBeenCalledTimes(3);
            exec.mockClear();
            wait.mockClear();
            withoutSqliteTransformPass(() => {
                expect(acquire).toThrow("busy");
                expect(exec).toHaveBeenCalledTimes(1);
                expect(wait).not.toHaveBeenCalled();
            });
            exec.mockClear();
            expect(acquire).toThrow("after 3 attempts");
            expect(exec).toHaveBeenCalledTimes(3);
            late = (async () => {
                await gate;
                exec.mockClear();
                wait.mockClear();
                expect(acquire).toThrow("busy");
                expect(exec).toHaveBeenCalledTimes(1);
                expect(wait).not.toHaveBeenCalled();
            })();
        });
        release();
        await late;
        exec.mockClear();
        expect(acquire).toThrow("busy");
        expect(exec).toHaveBeenCalledTimes(1);
    } finally {
        release();
        exec.mockRestore();
        wait.mockRestore();
        db.close();
    }
});

test("throwing foreground passes cannot leak retry policy to later work", async () => {
    const db = new Database(":memory:");
    const exec = spyOn(db, "exec").mockImplementation(() => {
        throw Object.assign(new Error("busy"), { code: "SQLITE_BUSY" });
    });
    const wait = spyOn(Atomics, "wait").mockReturnValue("timed-out");
    try {
        await expect(
            withSqliteTransformPass(async () => {
                throw new Error("pass failed");
            }),
        ).rejects.toThrow("pass failed");
        expect(() => withPrivilegedWriter(db, () => undefined)).toThrow("busy");
        expect(exec).toHaveBeenCalledTimes(1);
        expect(wait).not.toHaveBeenCalled();
    } finally {
        exec.mockRestore();
        wait.mockRestore();
        db.close();
    }
});

test("explicit deferred reads on a writable handle do not contend with the writer", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-deferred-read-"));
    const path = join(dir, "context.db");
    const writer = new Database(path);
    const reader = new Database(path);
    writer.exec(
        "PRAGMA journal_mode=WAL; CREATE TABLE result(value TEXT); INSERT INTO result VALUES ('committed')",
    );
    reader.exec("PRAGMA busy_timeout=0");
    writer.exec("BEGIN IMMEDIATE");
    writer.exec("INSERT INTO result VALUES ('uncommitted')");
    try {
        const rows = withSqliteTransformPass(() =>
            reader.transaction(() => reader.prepare("SELECT value FROM result").all()).deferred(),
        );
        expect(rows).toEqual([{ value: "committed" }]);
    } finally {
        writer.exec("ROLLBACK");
        writer.close();
        reader.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("an explicitly started foreground pass owns its lifetime independently", async () => {
    const db = new Database(":memory:");
    const exec = spyOn(db, "exec").mockImplementation(() => {
        throw Object.assign(new Error("busy"), { code: "SQLITE_BUSY" });
    });
    const wait = spyOn(Atomics, "wait").mockReturnValue("timed-out");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    let child!: Promise<void>;
    try {
        await withSqliteTransformPass(async () => {
            child = withSqliteTransformPass(async () => {
                await gate;
                expect(() => withPrivilegedWriter(db, () => undefined)).toThrow("after 3 attempts");
                expect(exec).toHaveBeenCalledTimes(3);
            });
        });
        release();
        await child;
    } finally {
        release();
        exec.mockRestore();
        wait.mockRestore();
        db.close();
    }
});
