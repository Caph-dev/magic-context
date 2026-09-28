import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    clearDreamerTickFailure,
    formatDreamerTickFailure,
    getDreamerTickFailure,
} from "../features/magic-context/dreamer/tick-failure";
import { recordSessionProjectIdentity } from "../features/magic-context/session-project-storage";
import { markSessionCleanupPending, openDatabase } from "../features/magic-context/storage";
import { _resetHarnessForTesting, type HarnessId, setHarness } from "../shared/harness";
import type { StatusDetail } from "../shared/rpc-types";
import { statusSummaryFromDetail } from "../shared/status-summary";
import {
    _resetDreamTimerForTests,
    _setDreamTimerStagesForTests,
    startDreamScheduleTimer,
} from "./dream-timer";

/**
 * Regression coverage for the schema-fence / null-DB crash:
 *
 * When the on-disk cache schema is newer than this binary supports (e.g. a
 * stale OpenCode/Pi process still running an older dist after another process
 * migrated the shared DB forward), openDatabase() fails closed by returning a
 * typed-null instead of a live handle. The dream-timer used to drive that null
 * straight into `db.transaction(...)` inside embedding registration, producing
 * a confusing `null is not an object (evaluating 'db.transaction')` TypeError
 * on every 15-minute tick. The timer must instead skip gracefully.
 */
describe("schema-fence null-DB contract", () => {
    test("openDatabase returns falsy (never throws) when DB schema exceeds supported version", () => {
        const dir = mkdtempSync(join(tmpdir(), "mc-fence-"));
        const dbPath = join(dir, "context.db");
        try {
            // First open migrates the fresh DB to the current LATEST schema.
            const healthy = openDatabase({ dbPath });
            expect(healthy).toBeTruthy();

            // Re-open pretending this binary only supports schema v0 — any real
            // schema version (>=1) is "newer than supported", so the fence trips.
            // The contract the dream-timer relies on: this returns falsy, it
            // does NOT throw.
            let fenced: unknown;
            expect(() => {
                fenced = openDatabase({ dbPath, latestSupportedVersion: 0 });
            }).not.toThrow();
            expect(fenced).toBeFalsy();

            // A binary that DOES support the schema still opens normally.
            const supported = openDatabase({ dbPath, latestSupportedVersion: 999 });
            expect(supported).toBeTruthy();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("dream-timer registration cleanup", () => {
    afterEach(() => {
        _resetDreamTimerForTests();
    });
    test("stale same-directory cleanup preserves the replacement registration", async () => {
        const directory = mkdtempSync(join(tmpdir(), "mc-dream-timer-cleanup-"));
        const timerHandle = {
            unref: mock(() => {}),
        } as unknown as ReturnType<typeof setInterval>;
        const setIntervalSpy = spyOn(globalThis, "setInterval").mockImplementation(
            (() => timerHandle) as typeof setInterval,
        );
        const clearIntervalSpy = spyOn(globalThis, "clearInterval").mockImplementation(
            (() => undefined) as typeof clearInterval,
        );
        const base = {
            directory,
            projectIdentity: "git:dream-timer-cleanup",
            harness: "pi" as const,
            client: {} as never,
            ensureRegistered: async () => undefined,
        };
        let cleanupReplacement: (() => void) | undefined;

        try {
            const cleanupStale = await startDreamScheduleTimer({ ...base });
            cleanupReplacement = await startDreamScheduleTimer({ ...base });
            expect(cleanupStale).toBeFunction();
            expect(cleanupReplacement).toBeFunction();

            cleanupStale?.();
            expect(clearIntervalSpy).not.toHaveBeenCalled();

            cleanupReplacement?.();
            expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
        } finally {
            cleanupReplacement?.();
            setIntervalSpy.mockRestore();
            clearIntervalSpy.mockRestore();
            rmSync(directory, { recursive: true, force: true });
        }
    });

    // An unresolved project (home directory, filesystem root) has no identity.
    // Registering it under "" would run every per-project task for a blank
    // project key, so the timer refuses the registration outright.
    test("refuses a registration whose project identity is empty", async () => {
        const directory = mkdtempSync(join(tmpdir(), "mc-dream-timer-empty-identity-"));
        const setIntervalSpy = spyOn(globalThis, "setInterval");
        try {
            for (const projectIdentity of ["", "  "]) {
                const cleanup = await startDreamScheduleTimer({
                    directory,
                    projectIdentity,
                    harness: "pi" as const,
                    client: {} as never,
                    ensureRegistered: async () => undefined,
                });
                expect(cleanup).toBeUndefined();
            }
            expect(setIntervalSpy).not.toHaveBeenCalled();
        } finally {
            setIntervalSpy.mockRestore();
            rmSync(directory, { recursive: true, force: true });
        }
    });

    test("picks up a durable Rust deletion from the cold-boot startup tick", async () => {
        const directory = mkdtempSync(join(tmpdir(), "mc-dream-timer-rust-delete-"));
        const timerHandle = {
            unref: mock(() => {}),
        } as unknown as ReturnType<typeof setInterval>;
        const timeoutHandle = {
            unref: mock(() => {}),
        } as unknown as ReturnType<typeof setTimeout>;
        let startupCallback: (() => void) | undefined;
        const setTimeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
            callback: () => void,
        ) => {
            startupCallback ??= callback;
            return timeoutHandle;
        }) as typeof setTimeout);
        const setIntervalSpy = spyOn(globalThis, "setInterval").mockImplementation(
            (() => timerHandle) as typeof setInterval,
        );
        const deleteSession = mock(async () => {});
        const closeSession = mock(() => {});
        const projectIdentity = "git:dream-timer-rust-delete";
        const sessionId = "ses-dream-timer-rust-delete";
        const db = openDatabase();
        if (!db) throw new Error("test database unavailable");
        recordSessionProjectIdentity(db, sessionId, projectIdentity);
        markSessionCleanupPending(db, sessionId, true);
        let cleanup: (() => void) | undefined;

        try {
            cleanup = await startDreamScheduleTimer({
                directory,
                projectIdentity,
                harness: "opencode",
                client: {} as never,
                ensureRegistered: async () => undefined,
                sessionCleanupModuleClient: { deleteSession, closeSession },
            });
            startupCallback?.();
            const pendingCount = () =>
                db
                    .prepare(
                        "SELECT COUNT(*) AS count FROM pending_session_cleanup WHERE session_id = ?",
                    )
                    .get(sessionId) as { count: number };
            for (let attempt = 0; attempt < 100; attempt += 1) {
                if (pendingCount().count === 0) break;
                await Promise.resolve();
            }

            expect(deleteSession).toHaveBeenCalledWith(sessionId, directory);
            expect(closeSession).toHaveBeenCalledWith(sessionId);
            expect(pendingCount()).toEqual({ count: 0 });
        } finally {
            cleanup?.();
            setTimeoutSpy.mockRestore();
            setIntervalSpy.mockRestore();
            rmSync(directory, { recursive: true, force: true });
        }
    });

    test("stops the singleton when a tick removes the last dead directory", async () => {
        const directory = mkdtempSync(join(tmpdir(), "mc-dream-timer-dead-dir-"));
        const timerHandle = {
            unref: mock(() => {}),
        } as unknown as ReturnType<typeof setInterval>;
        const singletonStartupHandle = {
            unref: mock(() => {}),
        } as unknown as ReturnType<typeof setTimeout>;
        const projectStartupHandle = {
            unref: mock(() => {}),
        } as unknown as ReturnType<typeof setTimeout>;
        const startupHandles = [singletonStartupHandle, projectStartupHandle];
        let startupIndex = 0;
        const setTimeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(
            (() => startupHandles[startupIndex++] ?? projectStartupHandle) as typeof setTimeout,
        );
        const clearTimeoutSpy = spyOn(globalThis, "clearTimeout").mockImplementation(
            (() => undefined) as typeof clearTimeout,
        );
        let intervalCallback: (() => void) | undefined;
        const setIntervalSpy = spyOn(globalThis, "setInterval").mockImplementation(((
            callback: () => void,
        ) => {
            intervalCallback = callback;
            return timerHandle;
        }) as typeof setInterval);
        const clearIntervalSpy = spyOn(globalThis, "clearInterval").mockImplementation(
            (() => undefined) as typeof clearInterval,
        );
        let cleanupStale: (() => void) | undefined;
        let cleanup: (() => void) | undefined;

        try {
            const registration = {
                directory,
                projectIdentity: "git:dream-timer-dead-dir",
                harness: "pi" as const,
                client: {} as never,
                dreamerConfig: { disable: false } as never,
                ensureRegistered: async () => undefined,
            };
            cleanupStale = await startDreamScheduleTimer({ ...registration });
            cleanup = await startDreamScheduleTimer({ ...registration });
            rmSync(directory, { recursive: true, force: true });
            intervalCallback?.();
            for (let attempt = 0; attempt < 20; attempt += 1) {
                if (clearIntervalSpy.mock.calls.length > 0) break;
                await Promise.resolve();
            }

            expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
            expect(clearTimeoutSpy).toHaveBeenCalledWith(projectStartupHandle);
            expect(clearTimeoutSpy).toHaveBeenCalledWith(singletonStartupHandle);
        } finally {
            cleanupStale?.();
            cleanup?.();
            setTimeoutSpy.mockRestore();
            clearTimeoutSpy.mockRestore();
            setIntervalSpy.mockRestore();
            clearIntervalSpy.mockRestore();
            rmSync(directory, { recursive: true, force: true });
        }
    });
});

/**
 * Static guard: every openDatabase()/openTimerDatabaseOrNull() result in the
 * dream-timer must be null-checked before use, and sweepProject must not carry
 * an `openDatabase()` default param (which would re-introduce an unguarded
 * null). These assertions fail loudly if the guards are ever removed.
 */
describe("dream-timer null-DB guards (static)", () => {
    const source = readFileSync(join(import.meta.dir, "dream-timer.ts"), "utf8");

    test("defines the guarded open helper and uses it at both entry points", () => {
        expect(source).toContain("function openTimerDatabaseOrNull(");
        expect(source).toContain('openTimerDatabaseOrNull("schedule timer registration")');
        expect(source).toContain('openTimerDatabaseOrNull("maintenance tick")');
    });

    test("guards every guarded-open result with an early return", () => {
        // Count only INVOCATIONS (string-arg call sites), not the function
        // definition. Each must be backed by an `if (!db) return;` guard.
        const callSites = source.match(/openTimerDatabaseOrNull\("/g) ?? [];
        expect(callSites.length).toBeGreaterThanOrEqual(2);
        const guards = source.match(/if \(!db\) return;/g) ?? [];
        expect(guards.length).toBeGreaterThanOrEqual(callSites.length);
    });

    test("sweepProject has no unguarded openDatabase() default param", () => {
        expect(source).not.toContain("db: Database = openDatabase()");
    });

    test("openTimerDatabaseOrNull catches a FATAL openDatabase() throw and degrades to null", () => {
        // openDatabase() returns typed-null on the schema fence but THROWS on a
        // fatal open (corrupt/unwritable DB). openTimerDatabaseOrNull must catch
        // that throw too, so a fatal open can't escape the awaited startup
        // registration in index.ts and abort the whole plugin load.
        const helper = source.slice(
            source.indexOf("function openTimerDatabaseOrNull("),
            source.indexOf("const registeredProjects"),
        );
        expect(helper).toContain("try {");
        expect(helper).toContain("catch");
        expect(helper).toContain("storage fatal");
    });
});

describe("dream-timer startup is fail-open at the index.ts call site (static)", () => {
    // Startup must not await optional timer registration. Its promise still needs
    // a rejection handler so a late timer failure remains visible and contained.
    const indexSource = readFileSync(join(import.meta.dir, "../index.ts"), "utf8");

    test("starts registration fire-and-forget and observes late rejection", () => {
        const callIdx = indexSource.indexOf("void startDreamScheduleTimer(");
        expect(callIdx).toBeGreaterThan(0);
        expect(indexSource).not.toContain("await startDreamScheduleTimer(");
        const after = indexSource.slice(callIdx, callIdx + 500);
        expect(after).toContain(".catch((err)");
        expect(after).toContain("continuing without it");
    });
});

describe("dream-timer message-history maintenance (static)", () => {
    const source = readFileSync(join(import.meta.dir, "dream-timer.ts"), "utf8");

    test("runs durable cleanup retries and the orphan sweep from the global tick", () => {
        const tick = source.slice(
            source.indexOf("function runTick("),
            source.indexOf("function startupJitterMs("),
        );
        expect(tick).toContain("runMessageHistoryMaintenance(db)");
        expect(tick).toContain("retryPendingSessionCleanups(db)");
        expect(tick).toContain("sweepOrphanedOpenCodeMessageIndexes(db, openOpenCodeDb)");
    });
});

describe("dream-timer internal child maintenance (static)", () => {
    const source = readFileSync(join(import.meta.dir, "dream-timer.ts"), "utf8");

    test("runs the shared historian/privacy sweep before the dreamer-enabled guard", () => {
        const internalSweep = source.indexOf("await sweepOrphanedInternalChildren(");
        const dreamerGuard = source.indexOf("if (!dreamingEnabled || !dreamerConfig)");

        expect(internalSweep).toBeGreaterThan(0);
        expect(dreamerGuard).toBeGreaterThan(internalSweep);
        expect(source).toContain("reg.historianChildSweep !== undefined");
        expect(source).toContain("privacy: retrospectiveOrphanStaleMs(privacyTimeoutMinutes)");
        expect(source).toContain("historian: historianOrphanStaleMs");
    });
});

describe("dream-timer git commit backlog drain (static)", () => {
    const source = readFileSync(join(import.meta.dir, "dream-timer.ts"), "utf8");

    test("sweepGitCommits invokes coordinated backlog drain after the index sweep", () => {
        expect(source).toContain("drainCommitBacklogForProject");
        expect(source).toContain("memorySnapshot?.gitCommitEnabled");
        expect(source).toContain("backlogDrained");
    });
});

describe("dream-timer dead-directory guard (static)", () => {
    const source = readFileSync(join(import.meta.dir, "dream-timer.ts"), "utf8");

    test("sweepProject skips + unregisters when the directory is gone", () => {
        expect(source).toContain("directoryStillExists(reg.directory)");
        expect(source).toContain("registeredProjects.delete(reg.directory)");
    });

    test("only a dir: identity GCs its schedule rows (git: is shared, must not)", () => {
        // The GC call must be gated behind the dir:-prefix check so a single dead
        // worktree never deletes a shared git: project's schedule.
        const gcIdx = source.indexOf("deleteTaskScheduleRowsForProject(db, reg.projectIdentity)");
        const guardIdx = source.indexOf('reg.projectIdentity.startsWith("dir:")');
        expect(guardIdx).toBeGreaterThan(0);
        expect(gcIdx).toBeGreaterThan(guardIdx);
    });
});

/**
 * Issue 496: message-history maintenance ran before the per-project loop inside
 * one try, so a throw from it ended the tick before a single task could be
 * dispatched. On Pi and OMP the orphan sweep threw on every tick, which left
 * the dreamer completely dead on those hosts while looking idle from outside.
 * Each stage is now contained on its own, and a stage that fails is recorded so
 * the difference between "nothing to do" and "never ran" is visible.
 */
describe("dreamer tick stage containment", () => {
    interface TickFixture {
        /** Fire one interval tick and wait for its asynchronous body to settle. */
        tick: () => Promise<void>;
        dispose: () => void;
    }

    async function startTickFixture(projectIdentities: string[]): Promise<TickFixture> {
        const timerHandle = { unref: mock(() => {}) } as unknown as ReturnType<typeof setInterval>;
        const timeoutHandle = { unref: mock(() => {}) } as unknown as ReturnType<typeof setTimeout>;
        const setTimeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(
            (() => timeoutHandle) as typeof setTimeout,
        );
        const clearTimeoutSpy = spyOn(globalThis, "clearTimeout").mockImplementation(
            (() => undefined) as typeof clearTimeout,
        );
        let intervalCallback: (() => void) | undefined;
        const setIntervalSpy = spyOn(globalThis, "setInterval").mockImplementation(((
            callback: () => void,
        ) => {
            intervalCallback = callback;
            return timerHandle;
        }) as typeof setInterval);
        const clearIntervalSpy = spyOn(globalThis, "clearInterval").mockImplementation(
            (() => undefined) as typeof clearInterval,
        );
        const directories: string[] = [];
        const cleanups: Array<(() => void) | undefined> = [];
        for (const projectIdentity of projectIdentities) {
            const directory = mkdtempSync(join(tmpdir(), "mc-dream-tick-"));
            directories.push(directory);
            cleanups.push(
                await startDreamScheduleTimer({
                    directory,
                    projectIdentity,
                    harness: "pi",
                    client: {} as never,
                    dreamerConfig: { disable: false } as never,
                    ensureRegistered: async () => undefined,
                }),
            );
        }
        return {
            tick: async () => {
                intervalCallback?.();
                // The tick body is a detached async function; yielding the loop
                // repeatedly lets it run to completion before assertions.
                for (let attempt = 0; attempt < 50; attempt += 1) await Bun.sleep(0);
            },
            dispose: () => {
                for (const cleanup of cleanups) cleanup?.();
                setTimeoutSpy.mockRestore();
                clearTimeoutSpy.mockRestore();
                setIntervalSpy.mockRestore();
                clearIntervalSpy.mockRestore();
                for (const directory of directories) {
                    rmSync(directory, { recursive: true, force: true });
                }
            },
        };
    }

    function timerDb() {
        const db = openDatabase();
        if (!db) throw new Error("test database unavailable");
        return db;
    }

    afterEach(() => {
        _resetDreamTimerForTests();
        _resetHarnessForTesting();
        clearDreamerTickFailure(timerDb());
    });

    for (const harness of ["pi", "omp"] as const satisfies readonly HarnessId[]) {
        test(`dispatches per-project maintenance on ${harness}, where the orphan sweep cannot run`, async () => {
            setHarness(harness);
            clearDreamerTickFailure(timerDb());
            const maintained: string[] = [];
            // Only the project stage is replaced: the real message-history
            // stage has to run, because that is the stage whose throw used to
            // end the tick on this host.
            const restoreStages = _setDreamTimerStagesForTests({
                runProjectMaintenance: async (reg) => {
                    maintained.push(reg.projectIdentity);
                },
            });
            const fixture = await startTickFixture([
                `git:tick-${harness}-first`,
                `git:tick-${harness}-second`,
            ]);

            try {
                await fixture.tick();

                expect(maintained).toEqual([
                    `git:tick-${harness}-first`,
                    `git:tick-${harness}-second`,
                ]);
                // A sweep this host cannot run is parked, not failed, so the
                // tick is a clean one and reports nothing to the user.
                expect(getDreamerTickFailure(timerDb())).toBeNull();
            } finally {
                restoreStages();
                fixture.dispose();
            }
        });
    }

    test("keeps running the projects when message-history maintenance throws", async () => {
        const maintained: string[] = [];
        const restoreStages = _setDreamTimerStagesForTests({
            runMessageHistoryMaintenance: async () => {
                throw new Error("pending cleanup retry exploded");
            },
            runProjectMaintenance: async (reg) => {
                maintained.push(reg.projectIdentity);
            },
        });
        const fixture = await startTickFixture([
            "git:tick-throwing-first",
            "git:tick-throwing-second",
        ]);

        try {
            await fixture.tick();

            expect(maintained).toEqual(["git:tick-throwing-first", "git:tick-throwing-second"]);
            const failure = getDreamerTickFailure(timerDb());
            expect(failure?.stage).toBe("message-history maintenance");
            expect(failure?.message).toContain("pending cleanup retry exploded");
        } finally {
            restoreStages();
            fixture.dispose();
        }
    });

    test("keeps running the remaining projects when one project throws", async () => {
        const maintained: string[] = [];
        const restoreStages = _setDreamTimerStagesForTests({
            runMessageHistoryMaintenance: async () => undefined,
            runProjectMaintenance: async (reg) => {
                if (reg.projectIdentity === "git:tick-project-a") {
                    throw new Error("git sweep exploded");
                }
                maintained.push(reg.projectIdentity);
            },
        });
        const fixture = await startTickFixture(["git:tick-project-a", "git:tick-project-b"]);

        try {
            await fixture.tick();

            expect(maintained).toEqual(["git:tick-project-b"]);
            const failure = getDreamerTickFailure(timerDb());
            expect(failure?.stage).toBe("project git:tick-project-a");
            expect(failure?.message).toContain("git sweep exploded");
        } finally {
            restoreStages();
            fixture.dispose();
        }
    });

    test("shows a stopped pass on the status and doctor surfaces, and clears it after a good one", async () => {
        let stageThrows = true;
        const restoreStages = _setDreamTimerStagesForTests({
            runMessageHistoryMaintenance: async () => {
                if (stageThrows) throw new Error("orphan sweep cannot read this host store");
            },
            runProjectMaintenance: async () => undefined,
        });
        const fixture = await startTickFixture(["git:tick-surface"]);

        try {
            await fixture.tick();

            const failure = getDreamerTickFailure(timerDb());
            expect(failure).not.toBeNull();
            if (!failure) throw new Error("the stopped pass was not recorded");

            // Doctor prints one line naming the stage and its code.
            const doctorLine = formatDreamerTickFailure(failure);
            expect(doctorLine).toContain("MC-D09");
            expect(doctorLine).toContain("message-history maintenance");

            // /ctx-status raises the matching warning on both hosts, which
            // share this selector.
            const summary = statusSummaryFromDetail({
                ...STATUS_DETAIL_STUB,
                dreamerTickFailure: failure,
            } as unknown as StatusDetail);
            expect(summary.warnings).toContain("dreamer_tick_blocked");
            expect(
                statusSummaryFromDetail(STATUS_DETAIL_STUB as unknown as StatusDetail).warnings,
            ).not.toContain("dreamer_tick_blocked");

            // A pass that gets all the way through takes the warning back down.
            stageThrows = false;
            await fixture.tick();
            expect(getDreamerTickFailure(timerDb())).toBeNull();
        } finally {
            restoreStages();
            fixture.dispose();
        }
    });
});

/** The status fields the warning selector reads, at their empty-but-healthy values. */
const STATUS_DETAIL_STUB = {
    inputTokens: 0,
    contextLimit: 0,
    usagePercentage: 0,
    cacheTtl: "1h",
    cacheTtlSource: "default",
    executeThreshold: 65,
    compartmentCount: 0,
    historianRunning: false,
    compartmentInProgress: false,
    memoryCount: 0,
};
