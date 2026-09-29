import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage";
import {
    firstUnreachableCompartment,
    truncateRemovedCompartmentAnchor,
    truncateUnreachableCompartmentHistory,
} from "./reachable-compartment-history";

const compartments = [
    { startMessageId: "old-1", endMessageId: "old-2" },
    { startMessageId: "old-3", endMessageId: "old-4" },
    { startMessageId: "old-5", endMessageId: "old-6" },
];

let dataHome: string;
let previousDataHome: string | undefined;
beforeEach(() => {
    previousDataHome = process.env.XDG_DATA_HOME;
    dataHome = mkdtempSync(join(tmpdir(), "mc-reachable-"));
    process.env.XDG_DATA_HOME = dataHome;
    mkdirSync(join(dataHome, "cortexkit", "magic-context"), { recursive: true });
    closeDatabase();
});
afterEach(() => {
    closeDatabase();
    if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousDataHome;
    rmSync(dataHome, { recursive: true, force: true });
});

function seed() {
    const db = openDatabase();
    for (let i = 0; i < compartments.length; i++) {
        db.prepare(`INSERT INTO compartments (session_id, sequence, start_message, end_message,
            start_message_id, end_message_id, title, content, created_at)
            VALUES (?, ?, ?, ?, ?, ?, 'title', 'OLD', 1)`).run(
            "ses-revert",
            i + 1,
            i * 2 + 1,
            i * 2 + 2,
            compartments[i].startMessageId,
            compartments[i].endMessageId,
        );
    }
    db.prepare(
        "INSERT INTO session_facts (session_id, category, content, created_at, updated_at) VALUES ('ses-revert', 'x', 'OLD', 1, 1)",
    ).run();
    db.prepare(
        "INSERT INTO session_meta (session_id, cached_m0_bytes, cached_m1_bytes) VALUES ('ses-revert', 'OLD', 'OLD')",
    ).run();
    return db;
}

describe("covered branch ancestry", () => {
    test("a reachable prefix followed by an unreachable compartment cuts at its stable IDs", () => {
        expect(
            firstUnreachableCompartment(compartments, new Set(["old-1", "old-2", "new-1"])),
        ).toBe(1);
    });

    test("removing an ordinary or protected tail does not touch covered history", () => {
        expect(
            firstUnreachableCompartment(
                compartments,
                new Set(["old-1", "old-2", "old-3", "old-4", "old-5", "old-6", "new-2"]),
            ),
        ).toBeNull();
    });

    test("an entirely hidden prefix is not proof of deletion", () => {
        expect(
            firstUnreachableCompartment(compartments, new Set(["compaction-summary", "new-1"])),
        ).toBeNull();
    });

    test("a covered endpoint removal cuts its compartment and later state atomically", () => {
        const db = seed();
        expect(truncateRemovedCompartmentAnchor(db, "ses-revert", "old-3")).toBe(true);
        expect(
            db.prepare("SELECT sequence FROM compartments WHERE session_id = 'ses-revert'").all(),
        ).toEqual([{ sequence: 1 }]);
        expect(
            db
                .prepare("SELECT count(*) AS n FROM session_facts WHERE session_id = 'ses-revert'")
                .get(),
        ).toEqual({ n: 0 });
        expect(
            db
                .prepare(
                    "SELECT cached_m0_bytes, cached_m1_bytes FROM session_meta WHERE session_id = 'ses-revert'",
                )
                .get(),
        ).toEqual({ cached_m0_bytes: null, cached_m1_bytes: null });
    });

    test("removing an indexed interior ID uses anchored lineage, not ordinal alone", () => {
        const db = seed();
        for (const [id, ordinal] of [
            ["old-3", 3],
            ["middle", 4],
            ["old-4", 5],
        ] as const) {
            db.prepare(`INSERT INTO message_history_source
                (session_id, message_id, message_ordinal, source_version, normalized_content_hash, role, updated_at)
                VALUES ('ses-revert', ?, ?, 'v1', 'h', 'user', 1)`).run(id, ordinal);
        }
        expect(truncateRemovedCompartmentAnchor(db, "ses-revert", "middle")).toBe(true);
        expect(
            db.prepare("SELECT sequence FROM compartments WHERE session_id = 'ses-revert'").all(),
        ).toEqual([{ sequence: 1 }]);
    });

    test("next-pass ancestry detects the stale covered suffix even when removal event was missed", () => {
        const db = seed();
        expect(
            truncateUnreachableCompartmentHistory(
                db,
                "ses-revert",
                new Set(["old-1", "old-2", "new-1"]),
            ),
        ).toBe(true);
        expect(
            db.prepare("SELECT sequence FROM compartments WHERE session_id = 'ses-revert'").all(),
        ).toEqual([{ sequence: 1 }]);
    });

    test("a compaction-hidden prefix does not delete stored rows or cached bytes", () => {
        const db = seed();
        expect(
            truncateUnreachableCompartmentHistory(
                db,
                "ses-revert",
                new Set(["compaction-summary", "new-1"]),
            ),
        ).toBe(false);
        expect(
            db
                .prepare("SELECT count(*) AS n FROM compartments WHERE session_id = 'ses-revert'")
                .get(),
        ).toEqual({ n: 3 });
        expect(
            db
                .prepare("SELECT cached_m0_bytes FROM session_meta WHERE session_id = 'ses-revert'")
                .get(),
        ).not.toEqual({ cached_m0_bytes: null });
    });

    test("ordinary tail removal does not truncate or bust the frozen baseline", () => {
        const db = seed();
        expect(truncateRemovedCompartmentAnchor(db, "ses-revert", "tail-1")).toBe(false);
        expect(
            truncateUnreachableCompartmentHistory(
                db,
                "ses-revert",
                new Set(["old-1", "old-2", "old-3", "old-4", "old-5", "old-6"]),
            ),
        ).toBe(false);
        expect(
            db
                .prepare("SELECT count(*) AS n FROM compartments WHERE session_id = 'ses-revert'")
                .get(),
        ).toEqual({ n: 3 });
        expect(
            db
                .prepare("SELECT cached_m0_bytes FROM session_meta WHERE session_id = 'ses-revert'")
                .get(),
        ).not.toEqual({ cached_m0_bytes: null });
    });
});
