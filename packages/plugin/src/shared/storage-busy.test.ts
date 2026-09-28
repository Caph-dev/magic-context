import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { Database, isTransientSqliteError, withPrivilegedWriter } from "./sqlite";

const wait = spyOn(Atomics, "wait");
afterEach(() => wait.mockClear());
afterAll(() => wait.mockRestore());

describe("writer acquisition backoff", () => {
    for (const clearsOn of [2, 3]) {
        test(`acquisition clears on attempt ${clearsOn} and invokes callback exactly once`, () => {
            const db = new Database(":memory:");
            db.exec(
                "CREATE TABLE context_privilege_state(id INTEGER PRIMARY KEY, enabled INTEGER); CREATE TABLE result(value TEXT)",
            );
            const exec = db.exec.bind(db);
            let attempts = 0;
            let callbacks = 0;
            const delays: number[] = [];
            wait.mockImplementation((_array, _index, _value, timeout) => {
                delays.push(timeout!);
                return "timed-out";
            });
            const intercepted = spyOn(db, "exec").mockImplementation((sql) => {
                if (sql === "BEGIN IMMEDIATE" && ++attempts < clearsOn)
                    throw Object.assign(new Error("locked"), { code: "SQLITE_BUSY" });
                return exec(sql);
            });
            try {
                const result = withPrivilegedWriter(db, () => {
                    callbacks++;
                    db.prepare("INSERT INTO result VALUES (?)").run("managed");
                    return JSON.stringify(db.prepare("SELECT * FROM result").all());
                });
                expect(result).toBe('[{"value":"managed"}]');
                expect(attempts).toBe(clearsOn);
                expect(callbacks).toBe(1);
                expect(delays).toEqual([500, 1000].slice(0, clearsOn - 1));
            } finally {
                intercepted.mockRestore();
                db.close();
            }
        });
    }
    test("exhausted acquisition never invokes callback", () => {
        const db = new Database(":memory:");
        let calls = 0;
        wait.mockImplementation(() => "timed-out");
        const exec = spyOn(db, "exec").mockImplementation(() => {
            throw Object.assign(new Error("original lock"), { code: "SQLITE_LOCKED" });
        });
        try {
            expect(() => withPrivilegedWriter(db, () => calls++)).toThrow("after 3 attempts");
            expect(exec).toHaveBeenCalledTimes(3);
            expect(calls).toBe(0);
        } finally {
            exec.mockRestore();
            db.close();
        }
    });
    test("busy callback rolls back without retrying mutations", () => {
        const db = new Database(":memory:");
        db.exec(
            "CREATE TABLE context_privilege_state(id INTEGER PRIMARY KEY, enabled INTEGER); CREATE TABLE result(value TEXT)",
        );
        let calls = 0;
        try {
            expect(() =>
                withPrivilegedWriter(db, () => {
                    calls++;
                    db.exec("INSERT INTO result VALUES ('partial')");
                    throw Object.assign(new Error("after acquisition"), { code: "SQLITE_BUSY" });
                }),
            ).toThrow("after acquisition");
            expect(calls).toBe(1);
            expect(db.prepare("SELECT * FROM result").all()).toEqual([]);
            expect(wait).not.toHaveBeenCalled();
        } finally {
            db.close();
        }
    });
    test("recognizes Bun extended and Node numeric contention codes only", () => {
        expect(isTransientSqliteError({ code: "SQLITE_BUSY_SNAPSHOT" })).toBe(true);
        expect(isTransientSqliteError({ code: "ERR_SQLITE_ERROR", errcode: 5 })).toBe(true);
        expect(isTransientSqliteError({ code: "ERR_SQLITE_ERROR", errcode: 262 })).toBe(true);
        expect(isTransientSqliteError({ code: "SQLITE_CORRUPT" })).toBe(false);
    });
});
