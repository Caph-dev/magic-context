import { log } from "../../shared/logger";
import { SqliteAcquisitionBusyError } from "../../shared/sqlite";

export const STORAGE_BUSY_MESSAGE =
    "Magic Context's database is busy (another process held it too long); send your message again.";

export class StorageBusyRefusalError extends Error {
    readonly code = "STORAGE_BUSY_REFUSAL";
    readonly recoverable = true;
    constructor(cause: unknown, stage: string) {
        super(STORAGE_BUSY_MESSAGE, { cause });
        this.name = "StorageBusyRefusalError";
        const original = cause instanceof SqliteAcquisitionBusyError ? cause.cause : cause;
        const detail =
            original instanceof Error ? (original.stack ?? original.message) : String(original);
        log(
            `[magic-context] storage-busy refusal stage=${stage}${cause instanceof SqliteAcquisitionBusyError ? ` acquisition=${cause.stage}` : ""}: ${detail}`,
        );
    }
}
