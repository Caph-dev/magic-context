import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    acquireCompartmentLease,
    releaseCompartmentLease,
} from "../../features/magic-context/compartment-lease";
import { clearSession, closeDatabase, openDatabase } from "../../features/magic-context/storage";
import { getPendingOps, queuePendingOp } from "../../features/magic-context/storage-ops";
import * as logger from "../../shared/logger";
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

    test("truncation refuses an active historian lease and preserves all rows until retry", () => {
        const db = seed();
        expect(acquireCompartmentLease(db, "ses-revert", "historian-holder")).not.toBeNull();
        expect(() => truncateRemovedCompartmentAnchor(db, "ses-revert", "old-3")).toThrow(
            "compartment_truncation_lease_busy",
        );
        expect(
            db
                .prepare("SELECT count(*) AS n FROM compartments WHERE session_id = 'ses-revert'")
                .get(),
        ).toEqual({ n: 3 });
        releaseCompartmentLease(db, "ses-revert", "historian-holder");
        expect(truncateRemovedCompartmentAnchor(db, "ses-revert", "old-3")).toBe(true);
        expect(
            db.prepare("SELECT sequence FROM compartments WHERE session_id = 'ses-revert'").all(),
        ).toEqual([{ sequence: 1 }]);
    });

    test("lease-busy interior cut survives restart and session deletion clears its marker", () => {
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
        db.prepare(
            "UPDATE session_meta SET deferred_execute_state = ? WHERE session_id = 'ses-revert'",
        ).run(JSON.stringify({ magicContextTokenizerCalibration: { hygieneUnitsVersion: 2 } }));
        acquireCompartmentLease(db, "ses-revert", "historian");
        expect(() => truncateRemovedCompartmentAnchor(db, "ses-revert", "middle")).toThrow(
            "compartment_truncation_lease_busy",
        );
        releaseCompartmentLease(db, "ses-revert", "historian");
        const marker = db
            .prepare(
                "SELECT deferred_execute_state FROM session_meta WHERE session_id = 'ses-revert'",
            )
            .get() as { deferred_execute_state: string };
        expect(
            JSON.parse(marker.deferred_execute_state).magicContextCoveredHistoryPendingCuts,
        ).toEqual(["middle"]);
        closeDatabase();
        const reopened = openDatabase();
        expect(
            truncateUnreachableCompartmentHistory(
                reopened,
                "ses-revert",
                new Set(["old-1", "old-2", "old-3", "old-4", "tail-1"]),
            ),
        ).toBe(false);
        expect(
            reopened
                .prepare("SELECT sequence FROM compartments WHERE session_id = 'ses-revert'")
                .all(),
        ).toEqual([{ sequence: 1 }]);
        const after = reopened
            .prepare(
                "SELECT deferred_execute_state FROM session_meta WHERE session_id = 'ses-revert'",
            )
            .get() as { deferred_execute_state: string };
        expect(JSON.parse(after.deferred_execute_state)).toEqual({
            magicContextTokenizerCalibration: { hygieneUnitsVersion: 2 },
        });
        clearSession(reopened, "ses-revert");
        expect(
            reopened
                .prepare(
                    "SELECT deferred_execute_state FROM session_meta WHERE session_id = 'ses-revert'",
                )
                .get(),
        ).toBeNull();
    });

    test("pending drops from the previous branch cannot run after truncation", () => {
        const db = seed();
        db.prepare(
            "INSERT INTO tags (session_id, message_id, type, tag_number) VALUES ('ses-revert', 'old-3', 'text', 42)",
        ).run();
        queuePendingOp(db, "ses-revert", 42, "drop");
        expect(getPendingOps(db, "ses-revert")).toHaveLength(1);
        expect(truncateRemovedCompartmentAnchor(db, "ses-revert", "old-3")).toBe(true);
        expect(getPendingOps(db, "ses-revert")).toEqual([]);
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
                // The host confirms the omitted endpoints were deleted, rather
                // than merely hidden by a filtered request window.
                (id) => id !== "old-3" && id !== "old-4",
            ),
        ).toBe(true);
        expect(
            db.prepare("SELECT sequence FROM compartments WHERE session_id = 'ses-revert'").all(),
        ).toEqual([{ sequence: 1 }]);
    });

    test("a wire-absent but store-present covered endpoint leaves frozen caches intact", () => {
        const db = seed();
        const ids = new Set(["old-1", "old-2", "old-4", "new-1"]);
        expect(truncateUnreachableCompartmentHistory(db, "ses-revert", ids, () => true)).toBe(
            false,
        );
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

    test("a short visible window ending at an old anchor is not a branch cut", () => {
        const db = seed();
        expect(truncateUnreachableCompartmentHistory(db, "ses-revert", new Set(["old-1"]))).toBe(
            false,
        );
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

    test("missing ancestry logs once per session without deleting stored history", () => {
        const db = seed();
        db.prepare(
            "UPDATE compartments SET session_id = 'ses-no-anchor' WHERE session_id = 'ses-revert'",
        ).run();
        const log = spyOn(logger, "sessionLog").mockImplementation(() => {});
        try {
            const visible = new Set(["compaction-summary", "new-1"]);
            expect(truncateUnreachableCompartmentHistory(db, "ses-no-anchor", visible)).toBe(false);
            expect(truncateUnreachableCompartmentHistory(db, "ses-no-anchor", visible)).toBe(false);
            expect(
                log.mock.calls.filter(([, text]) =>
                    String(text).includes("covered history ancestry unknown"),
                ),
            ).toHaveLength(1);
        } finally {
            log.mockRestore();
        }
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
