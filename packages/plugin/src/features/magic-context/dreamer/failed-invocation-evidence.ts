import type { PluginContext } from "../../../plugin/types";
import * as shared from "../../../shared";
import { log } from "../../../shared/logger";

/** Bound on the read: the child may be wedged, and the ledger row is best-effort. */
const FAILED_CHILD_READ_TIMEOUT_MS = 5_000;

/**
 * Read an OpenCode 1 child session's messages after its dreamer batch failed, so
 * the failed ledger row carries the tokens spent and the model that answered,
 * as a completed row does. Pi rows already carry them per attempt. Without this
 * a failed OpenCode row has only its duration, and the child is torn down right
 * after, so nothing else keeps that evidence.
 *
 * Returns undefined when there is no child, the read fails, or it takes longer
 * than the bound; the row is then recorded without messages as before.
 */
export async function readFailedChildMessages(
    client: PluginContext["client"] | undefined,
    sessionId: string | null,
    directory: string,
): Promise<unknown[] | undefined> {
    if (!client || !sessionId) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        // No `limit`: a long tool loop can exceed the 100 messages the success path
        // reads for its final text, and every assistant message carries tokens.
        const response = await Promise.race([
            client.session.messages({ path: { id: sessionId }, query: { directory } }),
            new Promise<null>((resolve) => {
                timer = setTimeout(() => resolve(null), FAILED_CHILD_READ_TIMEOUT_MS);
            }),
        ]);
        if (response === null) return undefined;
        const messages = shared.normalizeSDKResponse(response, [] as unknown[], {
            preferResponseOnMissingData: true,
        });
        return Array.isArray(messages) ? messages : undefined;
    } catch (error) {
        log(`[dreamer] failed-child evidence read failed for ${sessionId}: ${String(error)}`);
        return undefined;
    } finally {
        if (timer) clearTimeout(timer);
    }
}
