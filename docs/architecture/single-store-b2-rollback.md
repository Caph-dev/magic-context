# Rolling back the single-store move (B2)

B2 lets the module move one project's rows from its `store.db` into the host's `context.db`. The operator runs it with `magic-context doctor single-store migrate` from the project's directory. After a project is moved, `context.db` is the only place its memories, notes, compartments, events, primer candidates and user-memory candidates are current. `store.db` keeps its old copy, and nothing serves that copy again.

B2 adds no `context.db` migration. The plugin fence stays at 93, the same as B0 (see [single-store-b0-rollback.md](single-store-b0-rollback.md)). It adds two `store.db` migrations:

- 61 creates `mc_single_store_migrations`, one progress row per project;
- 62 creates `mc_single_store_pending_publish`, which the publish-resumption slice uses.

Paths are relative to the repository root.

## What a move leaves behind

A completed move leaves three facts:

1. **The `context.db` marker.** A `single_store_projects` row for the project, written in the same transaction as the last copied rows (`crates/mc-module/src/single_store_migrate.rs`, the final transaction of `run`). It is the completion fact, and it is one-way: nothing removes it.
2. **`store.db` authority.** Both of the project's `mc_authority` rows (`memories`, `notes`) are handed back to `TS`, committed after the marker in a separate transaction.
3. **The store-wide marker.** `mc_privilege_state.single_store` is set to 1, and `single_store_set_by` records the build that ran the move. It is set in that same `store.db` transaction.

If the process dies between (1) and (2), the marker is present while both domains still read `MODULE`. A build that can serve moved projects finishes (2) and (3) at its next start (`complete_pending_neutralisations`), without copying anything again.

## Before the move: nothing to roll back

A refused or interrupted run leaves no marker. Its committed chunks are ordinary rows in `context.db`, the same rows the mirror would write, and `store.db` stays the source of truth. A re-run continues from where the last one stopped. A run refused with `single_store_verify_mismatch` is repeated only with `--retry`.

## Plugin rollback (B2 → B0): supported

The file stays at lane 93, so a B0 plugin opens it. For a moved project:

- the B0 plugin's drain, reconcile and mirror pull see the marker and refuse with `single_store_tripwire`;
- the module's refusal of `authority.prepare`/`seed`/`drain` for a marked project arrives with the read/write cutover. Once it is in, a B0 plugin cannot hand authority back to the store.

No domain row changes in either file.

## `ck-mc` rollback across B2: unsupported

Once any project has been moved, `store.db` carries the store-wide marker. A `ck-mc` built before B2 has `SINGLE_STORE_CAPABLE = false`, and it refuses to open that `store.db` with `single_store_marker`, naming the build that ran the move. The refusal is deliberate. The old module would otherwise serve the moved project's frozen `store.db` copy and write its new folds where no later build reads them.

The refusal covers every harness on the box, because one `store.db` serves them all. That includes projects that were never moved.

To go back, go forward: run the build named in the refusal, or a newer one. There is no supported way to clear the store-wide marker. Clearing it by hand makes an old module serve stale rows for every moved project.

## The move itself refuses in a build that cannot serve a moved project

`single_store.migrate` refuses with `single_store_cutover_absent` unless the module reads moved projects from `context.db`. The flag is `mc_store::SINGLE_STORE_CAPABLE`, which the read/write cutover sets. A build where the executor exists but the readers do not therefore cannot write a marker.

## Checking a box

`magic-context doctor` lists every project that has either an `authority_managed` row or a marker, with its marker, and with the per-domain authority for the project in the current directory. A marked project whose store still claims either domain is reported as a single-store authority mismatch. In a build that can serve moved projects, restarting the module clears it, because the start finishes the store half. Re-running `doctor single-store migrate` does the same in any build that accepts the move.
