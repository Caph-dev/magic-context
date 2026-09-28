import { expect, test } from "bun:test";
import { Database } from "@magic-context/core/shared/sqlite";
import { findIdentitySplits, formatIdentitySplits } from "./doctor-identity-splits";

test("reports dir/git and two-git splits from both host generations without changing rows", () => {
    const db = new Database(":memory:");
    const host = new Database(":memory:");
    try {
        db.exec(`CREATE TABLE session_projects(session_id TEXT, harness TEXT, project_path TEXT);
            CREATE TABLE memories(project_path TEXT); CREATE TABLE notes(project_path TEXT);
            CREATE TABLE task_schedule_state(project_path TEXT);
            INSERT INTO session_projects VALUES ('a','opencode','dir:aaa'), ('b','opencode2','git:bbb'), ('c','opencode','git:ccc'), ('d','opencode2','git:ddd'), ('a','pi','git:unrelated');
            INSERT INTO memories VALUES ('dir:aaa'), ('dir:aaa');
            INSERT INTO notes VALUES ('git:bbb');
            INSERT INTO task_schedule_state VALUES ('git:ccc');`);
        host.exec(`CREATE TABLE session(id TEXT, directory TEXT); CREATE TABLE session_v2(id TEXT, directory TEXT);
            INSERT INTO session VALUES ('a','G:/Phoenix/markt.de'), ('c','G:/Phoenix/Proteus');
            INSERT INTO session_v2 VALUES ('b','g:/phoenix/markt.de/'), ('d','g:/phoenix/Proteus');`);
        db.exec("PRAGMA query_only = ON");
        host.exec("PRAGMA query_only = ON");
        const before = db.prepare("SELECT total_changes() AS n").get();
        const splits = findIdentitySplits(db, host);
        expect(splits).toEqual([
            {
                directory: "g:/phoenix/markt.de",
                identities: [
                    { identity: "dir:aaa", sessions: 1, memories: 2, notes: 0, dreamer: 0 },
                    { identity: "git:bbb", sessions: 1, memories: 0, notes: 1, dreamer: 0 },
                ],
            },
            {
                directory: "g:/phoenix/proteus",
                identities: [
                    { identity: "git:ccc", sessions: 1, memories: 0, notes: 0, dreamer: 1 },
                    { identity: "git:ddd", sessions: 1, memories: 0, notes: 0, dreamer: 0 },
                ],
            },
        ]);
        expect(formatIdentitySplits(splits).join("\n")).toContain("read-only; no merge performed");
        expect(db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
    } finally {
        host.close();
        db.close();
    }
});
