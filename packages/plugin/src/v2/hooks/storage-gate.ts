import {
    createFailClosedBlockingError,
    type FailClosedReason,
} from "../../features/magic-context/fail-closed-block";
import {
    type ContextDatabase,
    getDatabasePersistenceError,
    isDatabasePersisted,
} from "../../features/magic-context/storage";
import { openDatabaseAsync } from "../../features/magic-context/storage-db";
import { describeStorageUnavailability } from "../../features/magic-context/storage-unavailable-reason";
import { getErrorMessage } from "../../shared/error-message";

/**
 * The shortest time between two storage open attempts while the context database
 * is unavailable. A refused open is not free: the migration guard lists processes
 * and reads every RPC discovery file, so a session that sends turns quickly must
 * not repeat it on every pass. The interval starts when an attempt finishes;
 * a later turn can join recovery without blocking the host event loop.
 */
export const V2_STORAGE_REOPEN_INTERVAL_MS = 5_000;

export interface V2StorageGate {
    /** The durable database once an open has succeeded; never attempts an open. */
    current(): ContextDatabase | undefined;
    /** Why the last attempt left no durable database, or null when none has failed. */
    reason(): FailClosedReason | null;
    /** Start or join a bounded open attempt, respecting the retry interval. */
    probe(): Promise<ContextDatabase | undefined>;
    /**
     * The durable database. While storage is unavailable this re-attempts the open
     * at most once per interval and otherwise throws a `FailClosedBlockingError`
     * whose message names the recorded reason.
     */
    require(): ContextDatabase;
}

export interface V2StorageGateOptions {
    open?: () => ContextDatabase | null | Promise<ContextDatabase | null>;
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
    const open = options.open ?? (() => openDatabaseAsync({ busyTimeoutMs: 0 }));
    const now = options.now ?? (() => Date.now());
    const interval = options.reopenIntervalMs ?? V2_STORAGE_REOPEN_INTERVAL_MS;
    let db: ContextDatabase | undefined;
    let failure: FailClosedReason | null = null;
    let failureKey: string | null = null;
    let lastAttemptAt: number | undefined;
    let pending: Promise<ContextDatabase | undefined> | undefined;

    const attempt = async (): Promise<ContextDatabase | undefined> => {
        let next: FailClosedReason;
        try {
            const opened = await open();
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

    const probe = (): Promise<ContextDatabase | undefined> => {
        if (db) return Promise.resolve(db);
        if (pending) return pending;
        if (lastAttemptAt !== undefined && now() - lastAttemptAt < interval)
            return Promise.resolve(undefined);
        // Defer even injected synchronous openers until after the caller returns.
        // The production opener uses asynchronous process probes, not this deferral,
        // to keep the event loop responsive while discovery is running.
        pending = Promise.resolve()
            .then(attempt)
            .finally(() => {
                lastAttemptAt = now();
                pending = undefined;
            });
        return pending;
    };

    return {
        current: () => db,
        reason: () => failure,
        probe,
        require: () => {
            if (db) return db;
            void probe();
            throw createFailClosedBlockingError(
                failure ?? { kind: "storage_failure", cause: "context storage is not durable" },
            );
        },
    };
}

/** Allow a healthy open to finish without waiting for storage recovery at setup. */
export async function probeV2StorageAtBoot(
    storage: V2StorageGate,
): Promise<ContextDatabase | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            storage.probe(),
            new Promise<undefined>((resolve) => {
                timer = setTimeout(() => resolve(undefined), 100);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}
