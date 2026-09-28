#!/usr/bin/env bun
/**
 * How many cached sessions of moved projects could carry their cached render state
 * across the single-store move exactly, measured on a copied store pair after a real move.
 *
 * Each session caches the history it last rendered. The "fold" below is the pass that
 * last rebuilt the cached baseline (the m0 message); it recorded two memory watermarks in
 * the `mc_cache_state.meta` JSON: `max_memory_id` (memories at or below it are already in
 * the baseline) and `memory_mutation_cursor` (mutation-log rows at or below it are already
 * applied). Both are store.db ids. After the move they have to be restated in context.db
 * ids. That is exact only when
 *   (1) every row store.db's mutation log gained after the fold is a
 *       host-id acknowledgement (category `__mc_visibility__`) for a memory added after
 *       that fold (the log's history is not copied, so any other pending correction
 *       cannot be restated; an acknowledgement of a newer memory needs no restating,
 *       because the memory is still "new since the fold" by id after the move), and
 *   (2) every memory added after the fold has a higher context.db id than every memory
 *       that existed at the fold (so one number still separates "already in m0" from
 *       "new since"). The store-to-context id pairs come from context.db's
 *       `mirror_identity`, which the move completes for every copied memory.
 * Sessions that fail either test are the ones the design marks due for one rebuild.
 *
 * Read-only. Refuses any path outside the system temp directory.
 *
 *   bun packages/e2e-tests/scripts/b2-rebase-precision.ts $TMPDIR/magic-context/<task>/drill
 */
import { Database } from "bun:sqlite";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) throw new Error("usage: b2-rebase-precision.ts <dir holding context.db and store.db>");
const resolved = realpathSync(dir);
if (!resolved.startsWith(realpathSync(tmpdir()))) {
    throw new Error(`refusing ${resolved}: only copies under ${tmpdir()} are read`);
}
const context = new Database(join(resolved, "context.db"), { readonly: true });
const store = new Database(join(resolved, "store.db"), { readonly: true });

const marked = (
    context.query("SELECT project_path FROM single_store_projects ORDER BY project_path").all() as {
        project_path: string;
    }[]
).map((row) => row.project_path);

type Totals = {
    sessions: number;
    initialized: number;
    memoryDisabled: number;
    exact: number;
    loggedAfterFold: number;
    nonMonotone: number;
    both: number;
    inWorkspace: number;
    /** Sessions whose mutation log gained any row after the fold (their cursor is below the
     * log's head), acknowledgements included. */
    anyLogAfterFold: number;
};
const report: Record<string, Totals> = {};

for (const project of marked) {
    const totals: Totals = {
        sessions: 0,
        initialized: 0,
        memoryDisabled: 0,
        exact: 0,
        loggedAfterFold: 0,
        nonMonotone: 0,
        both: 0,
        inWorkspace: 0,
        anyLogAfterFold: 0,
    };
    const inWorkspace =
        (
            store
                .query("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'mc_workspace_members'")
                .get() as { n: number }
        ).n > 0 &&
        (
            store
                .query("SELECT COUNT(*) AS n FROM mc_workspace_members WHERE project_path = ?1")
                .get(project) as { n: number }
        ).n > 0;
    // Store id -> context id for every copied memory of the project, in store id order.
    const pairs = context
        .query(
            `SELECT module_row_id AS store_id, context_row_id AS context_id
               FROM mirror_identity
              WHERE domain = 'memories' AND module_project = ?1
              ORDER BY module_row_id`,
        )
        .all(project) as { store_id: number; context_id: number }[];
    // prefixMax[i]: highest context id among pairs[0..=i]; suffixMin[i]: lowest among pairs[i..].
    const prefixMax: number[] = [];
    const suffixMin: number[] = new Array(pairs.length);
    let running = 0;
    for (const pair of pairs) {
        running = Math.max(running, pair.context_id);
        prefixMax.push(running);
    }
    let low = Number.POSITIVE_INFINITY;
    for (let index = pairs.length - 1; index >= 0; index -= 1) {
        low = Math.min(low, pairs[index].context_id);
        suffixMin[index] = low;
    }
    const monotoneAt = (watermark: number): boolean => {
        // First pair whose store id is above the watermark.
        let first = 0;
        let last = pairs.length;
        while (first < last) {
            const middle = (first + last) >> 1;
            if (pairs[middle].store_id <= watermark) first = middle + 1;
            else last = middle;
        }
        if (first === 0 || first === pairs.length) return true;
        return prefixMax[first - 1] < suffixMin[first];
    };
    const logHead = (
        store
            .query("SELECT COALESCE(MAX(id), 0) AS head FROM mc_memory_mutation_log WHERE project_path = ?1")
            .get(project) as { head: number }
    ).head;
    // Mutation-log rows past a session's cursor that have no context.db equivalent:
    // anything except an acknowledgement of a memory newer than the session's
    // `max_memory_id`.
    const unrestatable = store.query(
        `SELECT COUNT(*) AS n FROM mc_memory_mutation_log
          WHERE project_path = ?1 AND id > ?2
            AND NOT (category = '__mc_visibility__' AND target_memory_id > ?3)`,
    );
    const sessions = store
        .query(
            `SELECT DISTINCT cache.session_id AS session_id,
                    json_extract(cache.meta, '$.initialized') AS initialized,
                    json_extract(cache.meta, '$.memory_disabled') AS memory_disabled,
                    json_extract(cache.meta, '$.max_memory_id') AS max_memory_id,
                    json_extract(cache.meta, '$.memory_mutation_cursor') AS cursor
               FROM mc_cache_state AS cache
               JOIN mc_transform_session_roots AS roots ON roots.session_id = cache.session_id
               JOIN mc_authority_route_bindings AS binding
                 ON binding.route_project_root = roots.project_root
              WHERE binding.project = ?1`,
        )
        .all(project) as {
        session_id: string;
        initialized: number | null;
        memory_disabled: number | null;
        max_memory_id: number | null;
        cursor: number | null;
    }[];
    for (const session of sessions) {
        totals.sessions += 1;
        if (inWorkspace) totals.inWorkspace += 1;
        if (!session.initialized) continue;
        totals.initialized += 1;
        if (session.memory_disabled) {
            totals.memoryDisabled += 1;
            totals.exact += 1;
            continue;
        }
        if ((session.cursor ?? 0) !== logHead) totals.anyLogAfterFold += 1;
        const logged =
            (
                unrestatable.get(project, session.cursor ?? 0, session.max_memory_id ?? 0) as {
                    n: number;
                }
            ).n > 0;
        const nonMonotone = !monotoneAt(session.max_memory_id ?? 0);
        if (logged && nonMonotone) totals.both += 1;
        else if (logged) totals.loggedAfterFold += 1;
        else if (nonMonotone) totals.nonMonotone += 1;
        else totals.exact += 1;
    }
    report[project] = totals;
}
console.log(JSON.stringify({ projects: report }, null, 2));
