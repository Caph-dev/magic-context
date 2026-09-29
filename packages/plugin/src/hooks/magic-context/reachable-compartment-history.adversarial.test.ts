import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage";
import { acquireCompartmentLease, releaseCompartmentLease } from "../../features/magic-context/compartment-lease";
import {
    truncateRemovedCompartmentAnchor,
    truncateUnreachableCompartmentHistory,
} from "./reachable-compartment-history";

const SID = "ses-wire-window";
let home: string;
let previousHome: string | undefined;

beforeEach(() => {
    previousHome = process.env.XDG_DATA_HOME;
    home = mkdtempSync(join(tmpdir(), "mc-wire-window-"));
    process.env.XDG_DATA_HOME = home;
    mkdirSync(join(home, "cortexkit", "magic-context"), { recursive: true });
    closeDatabase();
});

afterEach(() => {
    closeDatabase();
    if (previousHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
});

function seed() {
    const db = openDatabase();
    for (const [sequence, start, end] of [
        [1, "old-1", "old-2"],
        [2, "old-3", "old-4"],
    ] as const) {
        db.prepare(`INSERT INTO compartments (session_id, sequence, start_message, end_message,
            start_message_id, end_message_id, title, content, created_at)
            VALUES (?, ?, ?, ?, ?, ?, 'title', 'STILL-VALID', 1)`).run(
            SID, sequence, sequence * 2 - 1, sequence * 2, start, end,
        );
    }
    for (const [ordinal, id] of ["old-1", "old-2", "old-3", "old-4", "tail-1"].entries()) {
        db.prepare(`INSERT INTO message_history_source
            (session_id, message_id, message_ordinal, source_version, normalized_content_hash, role, updated_at)
            VALUES (?, ?, ?, 'v1', 'h', 'user', 1)`).run(SID, id, ordinal + 1);
    }
    db.prepare("INSERT INTO session_meta (session_id, cached_m0_bytes, cached_m1_bytes) VALUES (?, 'FROZEN', 'FROZEN')").run(SID);
    return db;
}

test("a store-present but wire-absent endpoint is not evidence of an undo", () => {
    const db = seed();
    // The host serves a filtered window: old-3 still exists in the raw store,
    // but the wire omitted it. The live tail after old-4 is not a new branch.
    const visible = new Set(["old-1", "old-2", "old-4", "tail-1"]);
    expect(truncateUnreachableCompartmentHistory(db, SID, visible)).toBe(false);
    expect(db.prepare("SELECT sequence FROM compartments WHERE session_id = ? ORDER BY sequence").all(SID))
        .toEqual([{ sequence: 1 }, { sequence: 2 }]);
    expect(db.prepare("SELECT cached_m0_bytes FROM session_meta WHERE session_id = ?").get(SID))
        .toEqual({ cached_m0_bytes: "FROZEN" });
});

test("an interior-only removal must retry after the historian releases its lease", () => {
    const db = seed();
    db.prepare(`INSERT INTO message_history_source
        (session_id, message_id, message_ordinal, source_version, normalized_content_hash, role, updated_at)
        VALUES (?, 'interior', 4, 'v1', 'h', 'user', 1)`).run(SID);
    // The event arrives while a historian owns the lease. The host then removes
    // only the interior message; all compartment endpoints remain visible.
    expect(acquireCompartmentLease(db, SID, "historian")).not.toBeNull();
    expect(() => truncateRemovedCompartmentAnchor(db, SID, "interior"))
        .toThrow("compartment_truncation_lease_busy");
    releaseCompartmentLease(db, SID, "historian");
    expect(truncateUnreachableCompartmentHistory(
        db, SID, new Set(["old-1", "old-2", "old-3", "old-4", "tail-1"]),
    )).toBe(false);
    expect(db.prepare("SELECT sequence FROM compartments WHERE session_id = ? ORDER BY sequence").all(SID))
        .toEqual([{ sequence: 1 }]);
});
