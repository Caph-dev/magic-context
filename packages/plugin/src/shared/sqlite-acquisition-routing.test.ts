import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database, withPrivilegedWriter, withSqliteTransformPass } from "./sqlite";
import { startSqliteWriteLocker } from "./sqlite-write-locker-test-support";

for (const mode of ["default", "immediate", "exclusive", "literal"] as const) {
    test(`shared SQLite retries ${mode} acquisition before running any writes`, async () => {
        const dir = mkdtempSync(join(tmpdir(), "mc-routed-acquisition-"));
        const path = join(dir, "context.db");
        const db = new Database(path);
        db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=50; CREATE TABLE result(value TEXT)");
        const locker = await startSqliteWriteLocker(path, 650);
        let calls = 0;
        const write = () => {
            calls++;
            db.prepare("INSERT INTO result VALUES (?)").run("once");
            return "managed";
        };
        try {
            withSqliteTransformPass(() => {
                if (mode === "literal") {
                    db.exec("BEGIN IMMEDIATE");
                    write();
                    db.exec("COMMIT");
                } else {
                    const transaction = db.transaction(write);
                    expect(mode === "default" ? transaction() : transaction[mode]()).toBe(
                        "managed",
                    );
                }
            });
            expect(calls).toBe(1);
            expect(db.prepare("SELECT * FROM result").all()).toEqual([{ value: "once" }]);
        } finally {
            await locker.exited;
            db.close();
            rmSync(dir, { recursive: true, force: true });
        }
    }, 30000);
}

test("routed transactions preserve nesting, receiver, arguments and rollback without callback retries", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE result(value TEXT)");
    let calls = 0;
    const transaction = db.transaction(function (this: { prefix: string }, value: string) {
        calls++;
        db.prepare("INSERT INTO result VALUES (?)").run(this.prefix + value);
        db.transaction(() => {
            db.exec("INSERT INTO result VALUES ('inner')");
        }).immediate();
        throw Object.assign(new Error("busy after writes"), { code: "SQLITE_BUSY" });
    });
    try {
        expect(() =>
            withSqliteTransformPass(() => transaction.call({ prefix: "outer-" }, "value")),
        ).toThrow("busy after writes");
        expect(calls).toBe(1);
        expect(db.prepare("SELECT * FROM result").all()).toEqual([]);
    } finally {
        db.close();
    }
});

test("exhausted routed acquisition never enters the callback or multiplies privileged retries", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-routed-exhaustion-"));
    const path = join(dir, "context.db");
    const blocker = new Database(path);
    const db = new Database(path);
    blocker.exec("PRAGMA journal_mode=WAL; CREATE TABLE result(value TEXT)");
    db.exec("PRAGMA busy_timeout=0");
    blocker.exec("BEGIN IMMEDIATE");
    const wait = spyOn(Atomics, "wait").mockReturnValue("timed-out");
    let callbacks = 0;
    try {
        for (const run of [
            () => db.transaction(() => callbacks++)(),
            () => withPrivilegedWriter(db, () => callbacks++),
        ]) {
            wait.mockClear();
            expect(() => withSqliteTransformPass(run)).toThrow("after 3 attempts");
            expect(wait).toHaveBeenCalledTimes(2);
            expect(callbacks).toBe(0);
        }
    } finally {
        wait.mockRestore();
        blocker.exec("ROLLBACK");
        blocker.close();
        db.close();
        rmSync(dir, { recursive: true, force: true });
    }
});
