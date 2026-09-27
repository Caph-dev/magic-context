import {
    createFailClosedBlockingError,
    type FailClosedReason,
} from "../../features/magic-context/fail-closed-block";
import {
    type ContextDatabase,
    getDatabasePersistenceError,
    isDatabasePersisted,
    openDatabase,
} from "../../features/magic-context/storage";
import { describeStorageUnavailability } from "../../features/magic-context/storage-unavailable-reason";
import { getErrorMessage } from "../../shared/error-message";

/**
 * The shortest time between two storage open attempts while the context database
 * is unavailable. A refused open is not free: the migration guard lists processes
 * and reads every RPC discovery file, so a session that sends turns quickly must
 * not repeat it on every pass. Five seconds still lets the first turn a user sends
 * after stopping the blocking host go through.
 */
export const V2_STORAGE_REOPEN_INTERVAL_MS = 5_000;

export interface V2StorageGate {
    /** The durable database once an open has succeeded; never attempts an open. */
    current(): ContextDatabase | undefined;
    /** Why the last attempt left no durable database, or null when none has failed. */
    reason(): FailClosedReason | null;
    /** Attempt an open now, whatever the interval, without throwing. */
    probe(): ContextDatabase | undefined;
    /**
     * The durable database. While storage is unavailable this re-attempts the open
     * at most once per interval and otherwise throws a `FailClosedBlockingError`
     * whose message names the recorded reason.
     */
    require(): ContextDatabase;
}

export interface V2StorageGateOptions {
    open?: () => ContextDatabase | null;
    now?: () => number;
    reopenIntervalMs?: number;
    /** Called when an attempt fails for a reason different from the previous one. */
    onUnavailable?: (reason: FailClosedReason) => void;
    /** Called when an attempt succeeds after an earlier one failed. */
    onRecovered?: (db: ContextDatabase) => void;
}

/**
 * Own the OpenCode 2 lane's context database handle across the life of the host
 * process. A refused open (a migration blocked by an older host, a database
 * newer than this build, an open error) is remembered with its reason and
 * retried on later turns, so the lane recovers without a host restart once the
 * cause is gone.
 */
export function createV2StorageGate(options: V2StorageGateOptions = {}): V2StorageGate {
    const open = options.open ?? (() => openDatabase());
    const now = options.now ?? (() => Date.now());
    const interval = options.reopenIntervalMs ?? V2_STORAGE_REOPEN_INTERVAL_MS;
    let db: ContextDatabase | undefined;
    let failure: FailClosedReason | null = null;
    let failureKey: string | null = null;
    let lastAttemptAt: number | undefined;

    const attempt = (): ContextDatabase | undefined => {
        lastAttemptAt = now();
        let next: FailClosedReason;
        try {
            const opened = open();
            if (opened && isDatabasePersisted(opened)) {
                db = opened;
                const recovered = failure !== null;
                failure = null;
                failureKey = null;
                if (recovered) options.onRecovered?.(opened);
                return db;
            }
            next = describeStorageUnavailability(
                getDatabasePersistenceError(opened) ?? "context storage is not durable",
            );
        } catch (error) {
            next = describeStorageUnavailability(getErrorMessage(error));
        }
        const key = JSON.stringify(next);
        failure = next;
        if (key !== failureKey) {
            failureKey = key;
            options.onUnavailable?.(next);
        }
        return undefined;
    };

    return {
        current: () => db,
        reason: () => failure,
        probe: () => db ?? attempt(),
        require: () => {
            if (db) return db;
            if (lastAttemptAt === undefined || now() - lastAttemptAt >= interval) {
                const opened = attempt();
                if (opened) return opened;
            }
            throw createFailClosedBlockingError(
                failure ?? { kind: "storage_failure", cause: "context storage is not durable" },
            );
        },
    };
}
