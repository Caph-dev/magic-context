# Single-store B2 cutover, steps 2 to 6: design

This document is the implementation design for the rest of the B2 cutover: after a project's domain rows move from the module's `store.db` into the host's `context.db`, the Rust module must read, compare and write them there without ever serving a stale row, without touching the wrong row, and without costing a cache bust the ARCHITECTURE.md cache contract does not allow.

It is written against branch `window/b2-slice-b1` at `3d70b7a235`. Line numbers are on that commit. It is bound by:

- the B2 draft, `.cortexkit/alfonso/drafts/2026-09-26-standalone-rust-b2-one-time-move-of-domain-rows-into-context-db-and-module-read-.md` (cited as **draft**, with its bold mechanism names);
- its companion `.cortexkit/alfonso/plans/b2-proposals.md` (cited as **Q1**..**Q12**) and the owner rulings recorded at its end;
- the two rulings given with this task: compartment dates live in a `store.db` derived cache created by store migration 63 (`mc_compartment_dates`), and a workspace moves all its members in one run, with a marked reader's union dropping an unmarked foreign member under one warning and one doctor line;
- the protected cache section of ARCHITECTURE.md (the pass taxonomy SOFT+/SOFT/HARD, the mutation gates, and the four load-bearing invariants).

Nothing here changes served bytes, render tiers, the m0/m1 taxonomy or cache behaviour for an unmarked project (draft non-goals). No `context.db` migration is added (draft non-goals, R-rulings). Choices that need the owner are collected in [section 12](#12-owner-decisions); every other choice is made here.

## 0. Where the branch is

Done on the branch:

- **Slice A**: `single_store.migrate` (`crates/mc-module/src/single_store_migrate.rs`), drilled on the real specimen pair; all five `authority_managed` projects move (`$TMPDIR/magic-context/b2/drill.jsonl`).
- **Cutover step 1**: the `SingleStoreDomain` seam (`crates/mc-store/src/single_store_domain.rs`), installed by the module as `ContextDomainReader` (`crates/mc-module/src/single_store_reads.rs`, installed at `crates/mc-module/src/lib.rs:4623-4631`, outside tests only). It serves four reads from `context.db` for a marked project: `load_active_memories` (the historian's memory block, `crates/mc-store/src/lib.rs:14842`), `load_compartment_events` (`:14749`), `load_primer_candidates` (`:14776`), `load_user_memory_candidates`. Each call resolves the route itself: `marked_project_domain` (`lib.rs:8090`) or `marked_session_domain` (`lib.rs:8101`), which reads the marker fresh every time.
- The orphan-event ruling (`cf103ea66a`) and the workspace-partial refusal (`3d70b7a235`, `single_store_migrate.rs:2332-2349`).
- `SINGLE_STORE_CAPABLE` is `false` (`crates/mc-store/src/lib.rs:3146`), and `single_store.migrate` refuses with `single_store_cutover_absent` unless a test sets `assume_cutover` (`single_store_migrate.rs:2276-2281`).

This document numbers the remaining work **S2** to **S6** ([section 10](#10-implementation-order)). The handoff's eight findings map onto it as follows: finding 1 (revision CAS) and 2 (fused m1 snapshot) are S2; 5 (rebase) is S3; 3 and 4 (id space, tools read and write together) are S4; 7 (dates) and the publish half of the write paths are S5; 8 (workspaces) and the capability flip are S6; 6 (ordering) is settled in [section 6](#6-render-ordering) and lands in S2.

## 1. Terms and invariants

- **P**: a project with a row in `context.db`'s `single_store_projects` (a **marked** project). **Q**: an unmarked project.
- **S(P)**: P's session set, exactly as the move defines it (draft "Session attribution"): `context.db` `session_projects` rows for P, union the `store.db` sessions bound to P through `mc_transform_session_roots` joined with `mc_authority_route_bindings`.
- **Domain rows**: rows of the tables the move copied (`memories`, `notes`, `compartments`, `compartment_events`, `primer_candidates`, `user_memory_candidates`) and the tables the module writes beside them (`session_facts`, `memory_embedding_watermarks`, and, from S4 on, `memory_mutation_log` and `domain_mutation_epoch`). In `store.db` they are the `mc_*` twins.
- **Cache rows**: everything else in `store.db`: `mc_cache_state` (core + meta, `row_version`), tags, pass traces, drops, hints, chunk transcripts, the facade ledger, workspace tables, the user-profile projection `mc_user_memories`, authority tables, and the new `mc_compartment_dates` and `mc_single_store_pending_publish`. Cache rows never move.
- **Route**: which file serves a domain read or takes a domain write. `Store` or `Context`.
- **Space**: which file's id numbering a stored number is in. `meta.max_memory_id`, `meta.memory_mutation_cursor` and `meta.m1_revision` are space-dependent; compartment sequences, message ordinals, expiry cutoffs and profile versions are not.

Invariants every step must keep:

- **I1 (one route per operation).** A transform pass, a facade call, a historian fire or publish, and a state sync resolve the route once and use it for every domain read and write they make. No operation reads some domain rows from one file and some from the other.
- **I2 (space follows route).** A space-dependent number is only compared with, or used to filter, rows of the file whose space it is in. A mismatch is a conflict, never a comparison.
- **I3 (retained rows are dead).** For a marked project, no module path reads or writes a `store.db` domain row after the marker commits, except the move itself and the rebase in the neutralisation commit, which read them once.
- **I4 (lock order).** The module never holds a `context.db` write transaction while acquiring the `store.db` write lock, and never opens a `context.db` write inside a `store.db` write transaction. Opening a `context.db` read transaction inside a `store.db` write transaction is allowed (WAL readers never wait on writers, so no cycle can form).
- **I5 (replay stays byte-identical).** Nothing in this design causes a render on a pass the scheduler would have deferred. Any re-render this design causes rides a pass that already had a bust opportunity (ARCHITECTURE.md invariants 2 and 4).
- **I6 (no guessing).** Where the two files disagree about attribution, the operation refuses with a stable code rather than picking one.

## 2. Routing

### 2.1 The route value

`mc-store` gains a plain value type:

```rust
pub enum DomainRoute {
    Store,
    Context { project: String },
}
```

and one resolver per operation shape, both built on the step-1 seam and both reading the marker fresh (the draft: "The marker read is never cached"):

- `McStore::route_for_project(project) -> Result<DomainRoute>`: `marked_project_domain(project)` (`lib.rs:8090`).
- `McStore::route_for_session(project, session_id) -> Result<DomainRoute>`: resolves both `route_for_project(project)` (`marked_project_domain`, `lib.rs:8090`) and `marked_session_domain(session_id)` (`lib.rs:8101`, which reads `store_projects_for_session` at `lib.rs:8116` and `session_projects` through `ContextDomainReader::marked_project_for_session`, `single_store_reads.rs:181-217`), and:
  - both unmarked → `Store`;
  - both say marked project P → `Context { project: P }`;
  - the session is attributed to marked P but the operation's project is another project, or the project is marked but the session is attributed to a different marked project → refuse with `single_store_scope_violation` (I6). The session's history is in one file and the operation's memories in the other; there is no correct mixed answer;
  - the project is marked and the session has no attribution yet (a brand-new session whose `session_projects` row the host has not written and whose root binding has not been committed) → `Context { project }`. The first `commit_transform` writes the root binding (`lib.rs:11612-11623`), so the next resolution agrees.

### 2.2 Per-pass pinning

The transform resolves `route_for_session(ctx.project_path, session_id)` once, before `m1_revision_signal_parts_for_pass_timed` (`transform.rs:2894` in the compaction-off pipeline and its twin in the main pipeline), and threads the value through every store read the pass makes. The step-1 per-call resolution stays for callers that are one operation (facade calls, historian reads), where resolving once per call already is resolving once per operation.

The store methods that the pass calls gain routed variants taking `&DomainRoute` (listed in [section 7](#7-the-split-of-each-fused-transaction)). The unrouted originals remain and mean `Store`; for a marked project they must not be reachable, which S2 proves with a test that installs a domain reporting every project marked and asserts no `mc_memories`/`mc_compartments`/`mc_memory_mutation_log`/`mc_notes` statement runs during a pass (an `sqlite3_trace` hook on the store connection in test builds).

### 2.3 The commit-time route check

A move can commit its marker while a pass is between its reads and its commit (transform passes do not enter the project write gate; only publishes and facade writes do, `lib.rs:14263`, `lib.rs:8455`). `commit_transform` therefore re-resolves the route inside its fenced `store.db` transaction (a marker read on the reader connection, allowed by I4) and returns `CasConflict` when it differs from the route the pass was pinned to. The caller already re-loads and re-steps on `CasConflict` (`lib.rs:11419-11422`, "the caller re-loads and re-steps").

## 3. The revision model for a marked project

### 3.1 What the revision is made of today

Two numbers carry "what the cached prefix already reflects":

- **`MemoryRevision`** (`crates/mc-store/src/lib.rs:5258-5265`): `project_paths` (the reader's union), `reader_project_path`, `expiry_cutoff_ms`, `max_memory_id` (MAX `mc_memories.id` under the render-pool filter, `memory_render_pool_filter_for_column`, `lib.rs:20240-20263`) and `mutation_cursor` (MAX `mc_memory_mutation_log.id` over the union). It is produced by `load_memory_render_snapshot` together with the rows it describes (`lib.rs:15213-15293`, one read transaction) and by `memory_revision_fence` from the m1 signal (`transform.rs:6830-6847`). `commit_transform` re-reads both heads inside its fenced transaction and conflicts on any difference (`lib.rs:11423-11465`), and also re-reads the session's compartment MAX(sequence) against `compartment_max_seq` (`lib.rs:11466-11475`).
- **The m1 revision** (`M1RevisionSignal`, `crates/mc-module/src/m1_compose.rs:144-160`): `revision = in_session_revision(max_memory_id, max_memory_mutation_id, max_compartment_seq, user_profile_version)` (`m1_compose.rs:63-76`, a `DefaultHasher` digest, always odd), plus `external_revision` (workspace fingerprint). The heads come from one read transaction, `load_m1_revision_snapshot` (`lib.rs:13177-13250`), which also reads `MAX(mc_notes.status_version)`. That note watermark feeds only `legacy_note_revision`, the digest older builds stored (`m1_compose.rs:78-96`, `:162-178`); it does not feed `revision` (`m1_compose.rs:154`). The applied value is `meta.m1_revision`, compared at `transform.rs:2904` and written after every HARD and SOFT (`transform.rs:3113`, `:3163`, `:5340`).

The m0 fold also freezes, in `meta`: `max_memory_id` and `memory_mutation_cursor` (the m0 watermarks m1 composes against, `transform.rs:3109-3110`, `:5324-5325`), `rendered_memory_ids` (host ids for every harness except Claude Code, `m0_compose.rs:495-508`), `expiry_cutoff_ms`, and the compartment sequences `folded_compartment_seq`, `m1_compartment_seq`, `coverage_compartment_seq`.

### 3.2 The same model, routed

For a route `Context { project: P }` every domain part is read from `context.db`, in one read transaction per read, with the same predicates:

| part | route `Store` (unchanged) | route `Context { P }` |
|---|---|---|
| memory head | `MAX(mc_memories.id)` under the pool filter | `MAX(memories.id)` under the same filter text, column `project_path`, same union, same cutoff |
| mutation head | `MAX(mc_memory_mutation_log.id)` over the union | `MAX(memory_mutation_log.id)` over the union (`context-db-schema.sql:303-312`, index `idx_memory_mutation_log_project`) |
| compartment head | `MAX(mc_compartments.sequence)` for the session | `MAX(compartments.sequence)` for the session |
| note status watermark | `MAX(mc_notes.status_version)` | the constant `0` (see below) |
| profile version | `meta.user_profile_version` (a cache row) | same |
| workspace membership | `mc_workspace_members` (a cache row, `lib.rs:3398`) | same, then filtered by [section 9](#9-workspaces) |

The note watermark is `0` for a marked route because (a) it feeds no current revision, only the legacy-digest equivalence; (b) `context.db` has no `status_version` column, and the handoff's candidate `domain_mutation_epoch` would feed nothing either; (c) the rebase ([section 4](#4-the-rebase)) writes every marked session's `m1_revision` in the current digest format, so no marked session can hold a legacy digest. With the watermark `0`, `legacy_note_revision` is `None` (`m1_compose.rs:264`) and `equivalent_applied_revision` returns the stored value unchanged.

`MemoryRevision` gains one field, `space: DomainSpace { Store, Context }`, set by whichever routed read produced it. `M1RevisionSignal` gains the same field. `ModuleMeta` gains `single_store_space: Option<String>` (`None` = store space, `Some(context_store_uuid)` = context space of that file) and `single_store_refold_due: bool` ([section 4](#4-the-rebase)). Both are `#[serde(default)]`, so older rows read as store space and not due.

### 3.3 `commit_transform` across two files

The compare-and-set keeps its shape (`lib.rs:11407-11475`); only where the heads are read changes. Inside the fenced `store.db` transaction, after the `row_version` check:

1. Re-resolve the route (2.3). A route different from the pass's pinned route → `CasConflict`.
2. If `memory_revision.space` differs from the route's space → `CasConflict` (I2).
3. Route `Store`: unchanged.
4. Route `Context`: open one read transaction on the `ContextDomainReader` connection and read, in it, the memory head (pool filter over `revision.project_paths`, reader `revision.reader_project_path`, cutoff `revision.expiry_cutoff_ms`), the mutation head, and, when `compartment_max_seq` is set, the session's compartment head. Compare with `revision.max_memory_id`, `revision.mutation_cursor` and `compartment_max_seq`. Any difference → `CasConflict`. Close the read transaction, then continue exactly as today (block identities, row digests, cache row, pass trace, roots, overlays).

The expected values are the heads the pass's composition read in its own `context.db` snapshot (`load_memory_render_snapshot` returns rows and heads from one transaction, `lib.rs:15213`; the routed variant does the same on the reader connection). The pass never reads heads from one file and rows from the other, so the expected value always describes the bytes it rendered.

Why this is sound although the check and the commit are on different files: heads are monotone (`MAX(id)` of AUTOINCREMENT tables, and `MAX(sequence)` of a session whose rewrites are serialised through this same `row_version`, [section 8.5](#85-every-other-compartment-writer)). The check proves "nothing the bytes do not reflect had committed when the cache row committed". A `context.db` write that commits after the check but before the `store.db` commit is not reflected in the bytes and is also not reflected in the stored revision (the stored revision is the checked value), so the next pass's signal differs from the stored revision and reports it as pending work, exactly as a write landing just after a single-file commit does today.

### 3.4 Torn-read hazards between the two files, and what prevents each

- **H1: domain write between compose and commit.** A pass composes from `context.db` snapshot A, a memory write commits to `context.db`, the pass commits its cache row to `store.db` claiming snapshot A's heads. Prevented by the in-transaction head re-read of 3.3 step 4: the heads it reads are newer than A's → `CasConflict` → re-step. This is the hazard the single-file CAS already covers; the design keeps the coverage by reading the other file inside the same `store.db` write transaction.
- **H2: route flip mid-pass.** A pass reads `store.db` heads, the move's marker commits, the pass commits. Prevented by 3.3 steps 1 and 2 (route and space rechecked at commit).
- **H3: revision read in the wrong space.** A marked session whose `meta` is still in store space (the window between the marker commit and the neutralisation commit, or a boot before neutralisation completes) compares a context-space signal with a store-space `meta.m1_revision`, or composes m1 with store-space watermarks against context ids. Prevented by the **compose guard**: a pass whose route is `Context` and whose `meta.single_store_space` is not that file's uuid may not compose. It replays (`PassPlan::Defer`, the frozen units are served verbatim, `transform.rs:3192-3233`) when `meta.initialized` and the frozen shape is valid; otherwise it returns the retryable `single_store_copy_in_progress`, which the host already treats as a module failure (LKG replay or a refused turn, ARCHITECTURE.md "Transform modes"). The guard also writes nothing space-dependent: the Defer commit carries `memory_revision: None` and `compartment_max_seq: None` (`transform.rs:3255-3256`, `:6421-6422` with `is_bust_pass` false). The reverse case (route `Store`, meta in context space) cannot arise because the marker is one-way; if it does, the pass refuses with `single_store_tripwire`.
- **H4: cache meta says published, `context.db` does not have the fold yet.** The historian publish commits its `store.db` meta first and its `context.db` chunks after ([section 8.4](#84-fold-publish-with-pending-publish-resumption)). A reader between the two sees the historian idle and the compartment set without the fold. Harmless: nothing renders from the historian phase, the compartment head (and so the m1 signal) only moves when the visibility chunk commits, and a new fire is refused while the pending row exists, so no firing can assemble from a set that is missing a published fold.
- **H5: facade write between its two files.** The ledger row (`store.db`) and the domain row (`context.db`) cannot commit together. Covered by the pending-ledger protocol of [section 8.1](#81-facade-memory-writes).

### 3.5 Rejected alternatives

- **One cursor in `context.db`** (a per-project change counter the CAS compares). It needs a `context.db` table or column, which B2 excludes (draft non-goals), and the existing `domain_mutation_epoch` is bumped only by privileged writers (`packages/plugin/src/features/magic-context/context-authority.ts:518-527`), so it would not cover compartments.
- **`ATTACH` both files into one transaction.** Forbidden by the draft ("`ATTACH`ing both files into one transaction is forbidden").
- **Carrying the pass's first `context.db` snapshot open until the `store.db` commit.** A read transaction held across the whole pass pins the WAL for the pass's duration on a 6.9 GB file shared with the host; the re-read in 3.3 costs one indexed read (measured in [section 11](#11-cost)) and gives the same guarantee.

## 4. The rebase

### 4.1 Why the cached state must be restated

After the marker commits, every revision the module reads for P is in context space. Each P session's cache row still holds store-space numbers: `meta.max_memory_id` and `meta.memory_mutation_cursor` (the m0 watermarks m1 composes against, `m1_compose.rs:394-398`, `:439`), and `meta.m1_revision` (a digest of store heads). Left alone, the first pass compares a context-space signal with a store-space digest, sees pending work on every P session, and the first opportunity pass composes m1 against store-space watermarks: memories whose context id is below the store watermark vanish from m1, others appear twice. **Q10** rejected leaving them ("Every P session would see a revision mismatch"), and the draft assigns the rewrite to the neutralisation commit.

Numbers that do **not** need restating: compartment sequences (copied verbatim, `(session_id, sequence)` is the compartment key, draft "Id mapping"), message ordinals and coverage, `expiry_cutoff_ms`, profile versions, and `rendered_memory_ids` for every host-backed session, because the m0 render already writes host ids there (`m0_compose.rs:495-508`, `transform.rs:2766-2780`) and a host id is the `context.db` id.

The mutation log history is not copied (draft non-goals, **Q10**). So a store-space cursor with store log rows after it (a correction m1 would render as `<memory-updates>`) cannot be restated in context space. The design restates what can be restated exactly and marks every other session **due** for one rebuild on its next materialising pass, as **Q10** prescribes ("flagged due, so its next materialising pass re-renders as it would have before").

### 4.2 Per-session classification

For every `mc_cache_state` row whose session is in S(P) (all moved members' sessions, for a workspace), with its `meta` still in store space (`single_store_space` is `None`):

Inputs, all read while the move's hold is still in place (so `store.db` domain rows of P cannot change, `single_store_migrate.rs:425-466`):

- from `meta`: `M = max_memory_id`, `C = memory_mutation_cursor`, `R = m1_revision`, `cutoff = expiry_cutoff_ms`, `profile = user_profile_version`, `memory_disabled`, `initialized`, `last_serializer_profile`, `rendered_memory_ids`;
- **store heads** for the session, read the way `load_m1_revision_snapshot` reads them (`lib.rs:13177-13250`) with `now = cutoff` (the value a pass uses once initialized, `transform.rs:2889-2893`): `HsMem`, `HsMut`, `HsSeq`, `HsNote`;
- **context heads** for the session, read with the routed variant of the same function: `HcMem`, `HcMut`, `HcSeq` (equal to `HsSeq`, since the verified copy made the compartment sets equal);
- the store-to-context id pairs of the union's memories from `context.db` `mirror_identity` (`domain = 'memories'`), which the move completes for every copied memory (draft "Id mapping", and the final transaction's "the `mirror_identity` rows for any fresh ids");
- the `store.db` log rows of the union with `id > C` (`mc_memory_mutation_log`, created at `lib.rs:587`).

Definitions:

- **current**: `signal_store.equivalent_applied_revision(R) == signal_store.revision`, where `signal_store` is `M1RevisionSignal` built from `(HsMem, HsMut, HsSeq, profile)` with `HsNote` for the legacy digest. This is exactly the test a pass would have made before the move.
- **restatable**, all of:
  1. every store log row with `id > C` is a host-id acknowledgement (`category = '__mc_visibility__'`, written by `acknowledge_host_memory_ids`, `lib.rs:13619-13667`) whose target store id is `> M`. An acknowledgement of a memory newer than the fold only exists to show that memory's id; after the move the memory is still newer than the fold by context id (condition 2), so m1 renders it as an addition with its context id. Any other row (an update, archive, merge, or an acknowledgement of a memory the fold already covered) is a correction that has no context-space counterpart;
  2. **monotone split**: every union memory with store id `<= M` maps to a context id lower than every union memory with store id `> M`. Then one number, `M' = max(context id of store ids <= M)` (0 when none), separates "already folded" from "new since the fold" in context space exactly as `M` did in store space;
  3. every mapped pair exists (a store memory with no `mirror_identity` row is not restatable);
  4. for a session whose `last_serializer_profile` is the Claude Code profile, every id in `rendered_memory_ids` (module ids there, `m1_compose.rs:381-389`) has a pair. Host-backed sessions need no check: their ids are already context ids.

Classification:

| session | written into `meta` |
|---|---|
| not `initialized` | `single_store_space = uuid`. Nothing else: its first pass is a bootstrap HARD (`mc-core` `classify` rule 1, `crates/mc-core/src/lib.rs:116-118`) that reads context |
| `memory_disabled` | `single_store_space = uuid`; `max_memory_id = 0`, `memory_mutation_cursor = 0` (both spaces read `(0, 0)` for a memory-disabled pass, `lib.rs:13198-13199`); `m1_revision` = context digest if **current**, else `0` |
| **restatable** | `single_store_space = uuid`; `max_memory_id = M'`; `memory_mutation_cursor = HcMut`; `rendered_memory_ids` translated through the pairs when Claude Code, unchanged otherwise; `m1_revision = digest(HcMem, HcMut, HcSeq, profile)` if **current**, else `0` |
| otherwise (**due**) | `single_store_space = uuid`; `max_memory_id = 0`; `memory_mutation_cursor = 0`; `m1_revision = 0`; `single_store_refold_due = true` |

`digest` is `in_session_revision` (`m1_compose.rs:63-76`), so the value is in the current format. `m1_revision = 0` never equals a digest (every digest has its low bit set, `m1_compose.rs:121`), so it reads as "pending m1 work", which a pass defers until an independent render (`M1RevisionSignal` doc, `m1_compose.rs:124-143`; `classify` rule 7 needs `bust_opportunity`, `crates/mc-core/src/lib.rs:147-155`).

`single_store_refold_due` is consumed right after classification in both pipelines (`transform.rs:2989` and `:4679`): a plan of `PassPlan::Soft` becomes `PassPlan::Hard` with `materialize_reason = "single_store_rebase"`, before any m1 composition runs. Every HARD branch clears the flag. The upgrade happens only on a pass that was already going to render (a `Soft` needs `bust_opportunity`), so it never creates a bust (I5, ARCHITECTURE.md invariant 4). It is the same move the existing pressure refold makes on a SOFT pass (`transform.rs:5390-5397`), except that it is decided before composing m1, because a due session's m0 watermarks mean nothing in context space.

### 4.3 What the neutralisation commit writes

The rebase is computed by the module (the digest function lives in `mc-module`) and applied by `mc-store` inside the neutralisation transaction, which today flips authority, records the phase and sets the file-level marker (`neutralize_single_store_project`, `lib.rs:8334-8381`). The new signature takes a list of patches:

```rust
pub struct SingleStoreRebasePatch {
    pub session_id: String,
    /// The space-dependent fields the module read; the patch applies only if they are unchanged.
    pub expect_max_memory_id: i64,
    pub expect_memory_mutation_cursor: i64,
    pub expect_m1_revision: u64,
    /// What to write when the expectation holds.
    pub write: SingleStoreRebaseWrite,
}
pub struct SingleStoreRebaseWrite {
    pub max_memory_id: i64,
    pub memory_mutation_cursor: i64,
    pub m1_revision: u64,
    pub rendered_memory_ids: Option<Vec<i64>>,
    pub refold_due: bool,
}
```

In the one `store.db` transaction, after the three existing statements, for each patch:

1. Read the session's `mc_cache_state` row. No row, or `meta.single_store_space` already set → skip (repeating the neutralisation is harmless, like the rest of it).
2. If `meta.max_memory_id`, `meta.memory_mutation_cursor` and `meta.m1_revision` equal the patch's expectation → apply `write`. Otherwise a pass committed a render between the module's read and this transaction (only possible before the marker, see 4.5) → apply the **due** row of the table instead, which is always safe.
3. Set `meta.single_store_space = Some(context_store_uuid)`.
4. Write the row with `row_version = row_version + 1` and `last_activity_at` unchanged. The bump makes any pass that loaded the old row conflict at its own commit (`lib.rs:11415-11422`) and re-step against the restated row.
5. Upsert the session's `mc_compartment_dates` rows from its `mc_compartments` rows ([section 8.4](#84-fold-publish-with-pending-publish-resumption)).

The same transaction also refuses any later `acknowledge_host_memory_ids` for P (by recording nothing: the ack handler checks the route first, [section 8.6](#86-storedb-writers-that-must-stop-for-a-marked-project)).

### 4.4 Worked example: a current session, no pending work

Session `s` of P. Before the move: P's memories have store ids 1..100 and context ids 5001..5100 in the same order; `s` folded m0 at `M = 100`, `C = 40`, `HsSeq = 7`, profile 0, and nothing happened since, so `R = digest(100, 40, 7, 0)` and `s` is **current**. `context.db`'s log head for P is 9000 (TS-era rows).

The rebase: condition 1 holds (no store log row after 40), condition 2 holds, so `s` is **restatable**. It writes `max_memory_id = 5100`, `memory_mutation_cursor = 9000`, `m1_revision = digest(5100, 9000, 7, 0)`, `single_store_space = uuid`, `row_version + 1`.

First pass after the move: the pinned route is `Context`, the space matches, so the compose guard is open. The signal is `digest(5100, 9000, 7, 0)`, equal to the stored revision: `m1_revision_changed = false`. `classify` returns `Defer` unless a HARD trigger fired independently (rule 4) or reductions are pending; on `Defer` the frozen m0 and m1 are served verbatim (`transform.rs:3192-3233`). Same bytes, no HARD render: acceptance item 9, first half.

### 4.5 Worked example: a pending memory mutation

Same session, but after the fold the agent archived memory 17: store log row 41 (`archive`). The stored `R = digest(100, 40, 7, 0)` differs from `digest(100, 41, 7, 0)`, so `s` is not current, and row 41 is not an acknowledgement, so `s` is not restatable: it is **due**. The rebase writes `m1_revision = 0`, `single_store_refold_due = true`, both watermarks 0, `single_store_space = uuid`.

- Every defer pass: signal ≠ 0 → pending, logged by `log_pending_m1_delta` (`transform.rs:3183-3185`); no bust opportunity → `Defer` → frozen bytes. The prefix stays cached, as it did before the move while row 41 was pending.
- The first pass with a bust opportunity (execute, `/ctx-flush`, force or emergency band, first reduction): `classify` returns `Soft` (pending m1 work, opportunity open); the refold flag upgrades it to `Hard`; m0 is composed from `context.db` (memory 17 archived, so absent), m1 resets to the placeholder, `meta` is rewritten entirely in context space (`transform.rs:3094-3122` / `:5290-5346`), the flag is cleared.
- The next pass: the stored revision equals the signal; `Defer` again.

Exactly one re-render, on the first materialising pass: acceptance item 9, second half. Without the move that pass would have been a SOFT carrying `<removed id="…"/>` in m1; after it, it is a HARD. The difference is that m0 re-renders on a pass that was already busting at the m1 breakpoint, which costs the m0 portion of the cached prefix once per due session.

A pending **addition** instead of a correction (a memory written after the fold, store id 101 → context id 5101, plus its acknowledgement row 41 targeting 101) is restatable: `M' = 5100`, `memory_mutation_cursor = 9000`, `m1_revision = 0`. Defer passes replay; the first materialising pass is a normal SOFT whose m1 lists `#5101` as a new memory (id 5101 > 5100). Also exactly one re-render, and the same kind as without the move.

### 4.6 The move window and boot completion

Between the final `context.db` commit (`single_store_migrate.rs:2462-2488`) and the neutralisation commit (`:2503-2508`) P is marked but its sessions' meta is still in store space. Passes for P's sessions in that window hit the compose guard (H3) and replay. Passes that composed before the marker and commit after it conflict on the route check (2.3). A pass that composed and committed entirely before the marker changes `M`/`C`/`R`, which the patch expectation catches (4.3 step 2 → due).

The context heads must be the heads at the marker commit. The final transaction already recomputes `drift_snapshot` (`single_store_migrate.rs:2463`); it is extended to take the snapshot again after the held chunk is applied, and to return it (`D_T`). The run then:

1. records the `marked` phase row (`single_store_migrate.rs:2496-2501`) with `cursor_json = {"drift": D_T}`;
2. opens one `context.db` read transaction, recomputes `drift_snapshot` and compares it with `D_T`; equal means no writer touched P since the marker (privileged writers bump `domain_mutation_epoch`, `context-authority.ts:518-527`, unprivileged ones are aborted by the authority guards that the final transaction keeps armed through `authority_managed`, and the module's own writers are held; per-session `(max sequence, count)` covers compartments). It then reads the context heads of every P session and the id pairs in that same transaction;
3. reads the store inputs in one `store.db` read transaction;
4. builds the patches, and calls the neutralisation with them.

If step 2's drift differs, every session is patched **due**. At boot, `complete_pending_neutralisations` (`single_store_migrate.rs:2519-2556`) runs the same steps 2-4 with `D_T` taken from the phase row; a missing `cursor_json` drift (a crash between the marker commit and step 1) also patches every session **due**. Due is always correct; it only costs the one rebuild of 4.5.

### 4.7 Measured on the drill pair

`packages/e2e-tests/scripts/b2-rebase-precision.ts`, run on a copy of the post-move drill pair (`$TMPDIR/magic-context/b2-design/drill`, cloned from `$TMPDIR/magic-context/b2/drill`), applies conditions 1 and 2 to every cached session of the five moved projects (condition "current" needs the Rust digest and is not measured here):

| project | cached sessions | initialized | restatable | due (a correction after the fold) | non-monotone |
|---|---|---|---|---|---|
| `1e394c24…` | 2 | 2 | 2 | 0 | 0 |
| `3fba0e3d…` | 328 | 3 | 1 | 2 | 0 |
| `8170cb12…` | 1 | 1 | 1 | 0 | 0 |
| `aa13a259…` | 20 | 13 | 1 | 12 | 0 |
| `af4ffa3a…` | 5 | 1 | 1 | 0 | 0 |

- 19 of the 20 initialized sessions have store log rows after their fold, but for 5 of those the rows are acknowledgements of newer memories only; the refinement in condition 1 is what makes them restatable.
- The monotone split held for every session.
- All 14 due sessions last committed a pass between 2026-08-31 and 2026-09-23, days before the specimen was taken; every one of them is idle past any cache TTL, so its next pass is an idle-TTL HARD (`scheduler_outcome.idle_ttl_fired`, `transform.rs:2972`) regardless of the move. On this specimen, the refold costs no extra render. The 6 restatable sessions are exactly the sessions that ran in the specimen's last two days (2026-09-26 and 2026-09-27).

## 5. The id space

### 5.1 The rule

For a marked project there is one id space: `context.db`'s. Every memory and note id the module accepts, renders or returns for a `Context` route is a `context.db` row id, and it is resolved only in `context.db`, only under the operation's project and visibility predicate. The route is decided from the operation's project before any id is interpreted (2.1), which is what removes the ambiguity the handoff found: today `get_memory_full(id)` (`lib.rs:13605`) and `host_memory_ids_for_module_ids(ids)` (`lib.rs:14921`) take no project, so an id alone cannot say which file it belongs to.

The step-1 reader already returns `StoredMemory { id, host_row_id: Some(id) }` for context rows (`single_store_reads.rs:224-241`: "context.db ids are the ids agents see, so a moved project's memory id and its host id are the same number"). Every path below keeps that identity.

### 5.2 The id lanes

The module accepts ids in lanes (`memory_id_lane`, `lib.rs:13462-13498`; `note_id_lane` with `NoteIdSpace`, `lib.rs:17978-18093`). A new lane value `"context"` is added to both. For a `Context` route:

| lane | who sends it | what the ids are | module behaviour |
|---|---|---|---|
| `"context"` | the B2 plugin, for a project its marker read (`readSingleStoreMarker`, draft Q4) says is marked | `context.db` ids, exactly what the agent saw | resolved in `context.db` |
| `"module"` (or absent) | direct callers: Claude Code, Thalamus, a Pi Rust adapter | what the module rendered to that caller, which for a marked project is the `context.db` id (the reader sets `id` to the context id) | resolved in `context.db`, as `"context"` |
| `"host"` | a plugin older than B2, which translates the agent's host ids to store ids through `mirror_identity` before calling (`translateHostMemoryIds`, `packages/plugin/src/plugin/memory-id-translation.ts:195`; the note map, `packages/plugin/src/plugin/rust-note-backend.ts:195`) | the translated `ids`/`note_id_map` point at retained `store.db` rows | refused with `single_store_tripwire` before any read or write: "this plugin predates the move of `<project>`; upgrade the plugin" |

For a `Store` route the lanes behave exactly as today, and `"context"` is refused with `invalid_params` ("the context id lane is only valid for a moved project"). A B2 plugin that read "unmarked" just before a move committed sends `"host"` and gets the tripwire once; its next call re-reads the marker and sends `"context"`. The reverse race cannot happen (the marker is one-way).

### 5.3 Every module path that takes or returns a memory or note id

| path | today | `Context` route |
|---|---|---|
| `ctx_memory` host-lane verification (`lib.rs:13469-13494`) | `get_memory_full(module_id).host_row_id == host_id` | not reached (`"host"` refused); `"context"` needs no pairing |
| `ctx_memory update` / `archive` / `merge` (`memory_tool.rs:183`, `:256`, `:277`, `:302`, all through `load_owned_memory`, `memory_tool.rs:575-585`) | `get_memory_full(id)` then a project filter, then `update_memory_content` / `archive_memory` / `archive_memories` / `merge_memories` on `mc_memories` (`lib.rs:13793`, `:13867`, `:13947`) | `get_memory_full_routed(route, project, id)` reads `memories WHERE id = ? AND project_path = ?`; the write is the context writer of [section 8.1](#81-facade-memory-writes) |
| `ctx_memory get` (`lib.rs:13868` → `memory_tool::get_memories`, `memory_tool.rs:220-252`) | `get_visible_memories_by_ids` (`lib.rs:13676-13727`) | the same visibility filter over `memories` |
| `ctx_memory write` reply (`lib.rs:13568-13577`) | module id, or "Its id will appear in `<project-memory>` on the next pass" in the host lane | always `Saved memory [ID: <context id>] in <CATEGORY>.`; structured `{ "action": "write", "context_id": N, "module_id": N, "id_space": "context", "category": … }` |
| `ctx_search` id query (`lib.rs:13979-14007` → `memory_tool.rs:509-573`) | `get_visible_memories_by_ids` | routed, context ids |
| `ctx_search` exclusion set (`lib.rs:13961-13976`) | `module_memory_ids_for_host_ids(paths, meta.rendered_memory_ids)` | identity: `rendered_memory_ids` are already context ids (4.1) |
| `ctx_search` lexical memories (`search_visible_memory_contents`, `lib.rs:15382-15426`) | `mc_memories` LIKE | `memories` LIKE with the same predicates and order, ids are context ids |
| m1 baseline (`m1_compose.rs:381-389`) | `module_memory_ids_for_host_ids` maps host ids back to module ids | identity |
| m1 rendered ids (`m1_compose.rs:489-534`, the lookup at `:496`) | `host_memory_ids_for_module_ids(&mutation_ids)`, project-less | identity; the routed variant takes the route and returns `id → id` for every requested id that exists in the union |
| m0 rendered ids (`m0_compose.rs:495-508`, `transform.rs:2766-2772`) | `host_row_id` | unchanged code; `host_row_id == id` |
| `memory.identity.ack` (`lib.rs:9524` → `acknowledge_host_memory_ids`, `lib.rs:13619-13667`) | writes `mc_memories.host_row_id` and a visibility log row | refused with `single_store_tripwire`: a marked project has no second id to acknowledge |
| dreamer metadata routes `memory.set_classification` / `set_mural_cue` / `set_verification` / `set_mapping` (`lib.rs:12646`, `:12776`, `:12877`, `:12985`) | rows carry `memory_id` (module ids), gated by store authority `MODULE` + generation | see decision D2 ([section 12](#12-owner-decisions)); in both options the ids are context ids and the store authority row is not consulted |
| `ctx_note read` by id (`get_note_by_id`, `lib.rs:15569`) and glance (`read_glance_notes`, `lib.rs:15841`) | `mc_notes`, ids through `NoteIdSpace` | `notes`, with P's note scope (project notes of P, session notes of the caller's session, the NULL-project attribution the move uses, draft "Session attribution"); ids are context ids, `visible_id` is the identity, the pending placeholder is never produced |
| `ctx_note write` / `update` / `dismiss` (`update_note_cas`, `lib.rs:15998`; `dismiss_note`, `:16063`) | `mc_notes` with `status_version` CAS | the context writer of [section 8.2](#82-facade-notes-writes) |
| `note.evaluate` (`lib.rs:14153` → `write_note_evaluation`, `lib.rs:16162`) | `source_revision` is the store `status_version` the evaluator read (the TS bridge reads it from `mirror_note_revisions`, `packages/plugin/src/hooks/magic-context/module-tool-backends.ts:253-260`) | `note_id_lane: "context"` required; the revision token is the note's `updated_at` the evaluator read; the write is `UPDATE notes … WHERE id = ? AND updated_at = ? AND status = ?` (context has no `status_version`, **Q3**) |
| `claim_due_note`, `transition_note`, `claim_note_delivery`, `ack_note_delivery`, `nack_note_delivery` (`lib.rs:16202-16481`) | module-internal delivery states `surfacing`/`surfaced` | no production caller (the only callers are tests, e.g. `lib.rs:29934-29937`); refused with `single_store_tripwire` for a marked project rather than ported, since `context.db` has no representation for those states (**Q3** collapses them to `ready`) |
| note search (`search_notes_like`, `lib.rs:16483`) | `mc_notes` | `notes`, context ids |
| historian fact promotion (`promote_facts_tx`, `lib.rs:19086`) | inserts `mc_memories`, returns refs (no production reader of the refs in `mc-module`) | facts travel in `FoldPublish.memories` ([section 8.4](#84-fold-publish-with-pending-publish-resumption)); nothing returns their ids |

### 5.4 Why the wrong row is unreachable

1. Every id-taking call on a `Context` route is a routed variant whose SQL runs on the reader or writer connection of `context.db` and selects `WHERE id = ? AND <P's project or visibility predicate>`. An id of another project's row fails the predicate and reads as not found, the same answer the store gives today for a foreign or missing id (`memory_tool.rs:575-585`, `lib.rs:13669-13675`).
2. No `store.db` domain statement is reachable on a `Context` route (I3, enforced by the S2 trace test, 2.2).
3. A store id can only arrive through the `"host"` lane's translated ids, which is refused, or from something the module rendered in store space to a caller of P. Host-backed sessions of P were only ever shown host ids, which are context ids. Claude Code sessions (the only non-host-backed renderer, `transform.rs:2766`) cannot exist in P before the move, because the move refuses a project with any session outside `HOST_BACKED_HARNESSES = {"opencode"}` (draft **host-less predicate** (ii) and (iii), owner ruling 4), and a Claude Code session started after the move is rendered context ids from its first pass.
4. Workspace foreign rows stay read-only for the reader exactly as today (`memory_tool.rs:1033-1097` tests), and after [section 9](#9-workspaces) a marked reader's union only contains marked members, so every foreign row it can see is also a context row.

## 6. Render ordering

**Claim.** For every harness except Claude Code, the bytes of a rendered memory block are the same before and after the move for the same selected set of memories, and the selected set can differ only on a pass that already rebuilds the unit it is in.

**Proof.**

1. Rendered order. `render_memory_block` sorts by category rank, then by the rendered id (`memory_render.rs:59-77`, `:126-127`). For host-backed sessions the rendered id is `host_row_id` (`m0_compose.rs:496-500`, `m1_compose.rs:513-516`), which is the context id, before and after. Memory lines carry no importance (`memory_render.rs:79-96`). So for a given selected set, order and bytes are identical. (A memory the mirror had not acknowledged at render time renders as `-: …` with id 0 before, and with its context id after. That difference only exists in a render made after the move, which is a rebuild.)
2. Selection. `trim_memories_to_budget` (`m0_compose.rs:237-324`) stable-sorts by `memory_selection_order` (permanent first, importance, latest reinforcement; id only when both reinforcement times are absent, `m0_compose.rs:162-190`) and admits in that order until the budget is spent. Among equal keys the input order decides, and the input is `ORDER BY COALESCE(importance, 50) DESC, id ASC` (`lib.rs:15238`; the context reader uses the same text, `single_store_reads.rs:234`). So the selected set can depend on whether `id` is a store id or a context id, but only when the budget cuts through a run of memories with equal selection keys. The `<memory-updates>` block is ordered by mutation-log id (`lib.rs:15109`), a different sequence in each file.
3. Where selection and composition run. Only in `compose_m0_from_store` (HARD, `m0_compose.rs:443-584`, `transform.rs:3048`, `:5022+`) and `compose_m1_from_store` (SOFT, `m1_compose.rs:319-582`). A defer pass serves `core.frozen_units` verbatim (`transform.rs:3192-3233`) and composes nothing. So a different selection or a different `<memory-updates>` order can only be emitted by a HARD, which rebuilds the whole prefix, or a SOFT, which rebuilds m1 from its breakpoint; in both cases the provider cache of the changed unit is already being rewritten.

**Rejected: a secondary key that survives the copy.** Ordering the store route by `host_row_id` (equal to the context id) would make pre- and post-move rebuilds select identically, but it changes which memory an unmarked project's HARD keeps when the budget cuts through a tie, which is a served-byte change for projects that never move (draft non-goal: "Any change to served bytes"). The proof above is the settlement; tests that compare a HARD before and after the move use a memory budget that admits every memory, so selection cannot depend on order ([section 10](#10-implementation-order), S3).

## 7. The split of each fused transaction

Each entry says which rows come from which file on a `Context` route and why the result is consistent. The `Store` route of every entry is the code as it is today.

### 7.1 `commit_transform` (`lib.rs:11313-11769`)

- `store.db`, in the one fenced write transaction: `mc_cache_state` CAS, block identities, served-output fingerprints, row digest, `mc_pass_trace`, `mc_transform_session_roots`, tag mints, temporal marks, hints, channel-1 appends, consumed drops, the command ledger. All cache rows; unchanged.
- `context.db`, one read transaction opened inside the store transaction (I4): the route (marker) and, when the commit carries them, the memory head, mutation head and session compartment head (3.3).
- Consistency: the cache row commits only if the heads the pass rendered from are still the heads, and the route and space are still the pass's (3.3, H1-H3). The membership used for the memory head's pool filter is re-read from `store.db` inside the transaction, as today (`lib.rs:11437-11440`).

### 7.2 `load_session_status_snapshot` (`lib.rs:9258-9403`)

- `store.db`, one read transaction: the cache row and its hydrated rows, `mc_tags` count, `pending_agent_drops` count, `mc_pass_trace`.
- `context.db`, one read transaction: `compartment_count` (today `count("mc_compartments")`, `lib.rs:9393`).
- The compartment page (`lib.rs:9322-9350`) is what the host mirrors compartments from. For a marked session it is refused with `single_store_tripwire`, next to the existing copy-in-progress refusal (`lib.rs:8181-8193`): after the marker no writer but the module may write P's compartments (draft Q4: the host skips `mirrorModuleCompartments` for a marked project; the refusal makes a pre-B2 plugin fail closed instead of writing a second copy). The host already ignores a failed mirror-back (draft Q1 evidence).
- Consistency: this is a report. Each half is a consistent snapshot of its file; nothing is decided by comparing a number from one half with a number from the other.

### 7.3 `load_state_sync_inventory` (`lib.rs:9086-9109`)

- `store.db`: `meta` and the core's `boundary_id`.
- `context.db`: the session's `MAX(sequence)` (today a subquery on `mc_compartments`, `lib.rs:9094`).
- Consistency: the inventory is advisory. The host uses it to decide what to send (`lib.rs:8111`, `:8127`); `apply_state_sync` re-validates everything it applies under its own CAS (`shadow_generation`, `shadow_seq`, historian phase, `lib.rs:11828-11844`). For a marked session the compartment half of a sync is ignored anyway (7.4).

### 7.4 `apply_state_sync` (`lib.rs:11781-12181`)

One fenced `store.db` write transaction, as today, with four changes for a marked session:

1. `seed_ahead_of_module` reads `MAX(end_message)` of the session's compartments (`lib.rs:11879-11883`) from `context.db` (a read inside the store transaction, I4).
2. Adoption over a materialised boundary deletes the session's `mc_chunk_transcripts`, `mc_compartment_events` and `mc_compartments` (`lib.rs:12006-12015`). For a marked session it deletes only `mc_chunk_transcripts` (a cache table). The domain rows are the host's own `context.db` rows: the seed the host sends is built from them.
3. Seed compartment writes (`lib.rs:12018-12037`) are skipped and counted in the result as `compartments_skipped_single_store`. The compartments are already in `context.db`, which is where the module reads them.
4. The memory and mutation replacement (`lib.rs:12060-12087`) is skipped for a marked project regardless of the store authority row. After neutralisation that row reads `TS` (`lib.rs:8343-8351`), which today means "apply the host's view", and would let a sync write P's memories into `store.db` (I3; acceptance item 7 requires P's `store.db` counts unchanged across a fold).

A seed boundary for a session with a pending publish row (8.4) is refused with `single_store_publish_pending` (retryable), because the adoption decision compares the seed with the module's published coverage, which a pending fold has not reached `context.db` with yet.

Consistency: the decision reads the cache row under the store write lock and the context compartment coverage in a read snapshot taken inside it; the only other writer of a marked session's compartments is the module, serialised through this same cache row (8.5) or held off by the pending-publish refusal above.

### 7.5 `load_historian_assembly_snapshot` (`lib.rs:12362-12410`)

- `store.db`: `meta.revert_epoch`.
- `context.db`, one read transaction: the compartment rows and the compartment set generation `(MAX(sequence), COUNT(*))`. (Today the three reads are separate autocommit statements; the routed variant puts the two domain reads in one snapshot.)
- Consistency: both values are fences the firing carries to publish, and publish re-checks both, the epoch against the cache row and the generation against `context.db` (8.4). A mismatch at publish is the existing fast-local-race rejection (`historian.rs:1043-1057`). The fire itself is refused while the session has a pending publish row (8.4).

### 7.6 `publish_historian_chunk` (`lib.rs:14259-14485`)

Split into a `store.db` commit and `context.db` chunks with a durable pending row; specified in full in [section 8.4](#84-fold-publish-with-pending-publish-resumption).

### 7.7 `session_has_durable_state` (`lib.rs:6535-6563`)

- `store.db`: the existing `EXISTS` union over the cache tables (`mc_cache_state`, `mc_tags`, `pending_agent_drops`, `mc_reduce_command_ledger`, `mc_channel1_appends`, `mc_user_hints`, `mc_temporal_marks`, `mc_overlay_frontiers`, `mc_wrapup_commands`, `mc_recomp_commands`, `mc_pass_trace`, `mc_chunk_transcripts`).
- `context.db`, one read transaction: `EXISTS` over `compartments`, `compartment_events`, `primer_candidates`, `user_memory_candidates`, `session_facts` and `notes` with that `session_id`.
- Callers: `preflight_state_import` (`lib.rs:11166-11191`) and `commit_state_import` (`lib.rs:11197`). In the commit, the context read runs inside the store write transaction.
- Consistency: "non-empty" is monotone for a fresh session key (a row appears; nothing deletes it in the window), so an `EXISTS` true in either file stays true; the commit's store-side recheck and the import's own resume rule (8.5) close the race with a concurrent first pass.

### 7.8 `load_m1_revision_snapshot` (`lib.rs:13177-13250`)

- `store.db`: workspace membership (`workspace_membership_from_connection`, `lib.rs:3398`), filtered for a marked reader by [section 9](#9-workspaces).
- `context.db`, one read transaction: memory head, mutation head, session compartment head. The note watermark is `0` (3.2).
- Consistency: the three heads that feed the digest come from one snapshot, so the digest describes one state of `context.db`. The membership comes from the other file, but it is not in the digest: it feeds the external revision (`m1_compose.rs:274-278`), which routes to HARD on change, and the union is re-read inside `commit_transform`.

### 7.9 Other reads the transform, the historian and the facade make

Routed variants, one `context.db` read transaction each, same SQL on the context table names: `load_compartments` (`lib.rs:12207`), `load_compartment_boundaries` (`:12227`), `max_compartment_end_ordinal` / `last_compacted_ordinal` (`:12254`, `:12280`), `load_compartments_for_range` (`:12287`), `load_compartments_after` (`:12324`), `max_compartment_seq` (`:12416`), `load_memory_render_snapshot` (`:15213`, rows and heads in one snapshot), `memory_mutations_for_render` (`:14957`, the whole frontier walk in one snapshot, over `memory_mutation_log`), `search_compartments_like` (`:15431`), the note reads of 5.3, and the step-1 reads, which keep their seam.

The compartment rows gain their dates from `mc_compartment_dates` ([section 8.4](#84-fold-publish-with-pending-publish-resumption)): the routed `load_compartments*` reads read the context rows, then one `store.db` read of the session's date rows, and attach `start_date`/`end_date` to a compartment only when `(sequence, start_message_id, end_message_id)` all match. A missing or stale date row yields no date, which renders exactly like a TS-era compartment without dates (`decay_render.rs:98-113`).

## 8. Write paths

All `context.db` writes below go through the B1 writer discipline: one `BEGIN IMMEDIATE` per transaction under the privileged bracket, the in-transaction fingerprint recheck, and the project scope extended to S(P) on the session-keyed tables (`with_scoped_privileged_transaction`, `host_store.rs:1129`; `install_scope_triggers`, `:1223`; `install_session_scope`, `:1288`; draft **scope extension**). Each is bounded by `PUBLISH_CHUNK_BUDGET_US` (250 ms, `host_store.rs:150`); a facade write is a handful of rows and a fold uses the existing chunk planner.

S4 adds `memory_mutation_log` and `domain_mutation_epoch` to the tables the module writes (`DOMAIN_TABLES`, `host_store.rs:97-107`), which puts them under the per-table fingerprint fence. No `context.db` migration is needed: both tables exist at fence 93 (`context-db-schema.sql:92-97`, `:303-312`). Every module transaction that writes P's `memories` or `notes` bumps `domain_mutation_epoch(P, domain)` in the same transaction, the host's own convention for privileged writers (`context-authority.ts:513-527`), so the epoch stays a sound "someone wrote P" signal for the host and for 4.6.

### 8.1 Facade memory writes

Today one `store.db` transaction holds the facade ledger lookup, the mutation and the ledger insert (`with_facade_command`, `lib.rs:8442-8551`). For a marked project the ledger stays in `store.db` (a cache row) and the mutation moves to `context.db`, so the command becomes three transactions, all under the project write gate and the process-wide facade lock that already wrap it (`lib.rs:8453-8459`), so two facade calls never interleave:

1. **T1 (`store.db`)**: look up `(identity_scope, tool, action, command_id)` in `mc_facade_mutation_ledger` (`lib.rs:2069-2077`).
   - A final response → return it as `Duplicate` (today's behaviour).
   - A **pending** entry → resume with its recorded intent (step 2).
   - Nothing → insert a pending entry: `response_json` is the JSON object `{"single_store_pending": {"now_ms": …, "project": …, "action": …, "args": {…}}}`. A real response is an MCP result object and never has that key, so the two are distinguishable without a schema change. Commit.
2. **T2 (`context.db`)**: apply the mutation with the intent's `now_ms`, so the rows it writes are recognisable by their own instant, the same resume rule the fold publisher uses (`host_store.rs:2062-2069`):
   - `write`: the store's `insert_memory` semantics (`lib.rs:13733`): a live row with the same `(project_path, category, normalized_hash)` is seen again, not inserted; `normalized_hash` is `compute_normalized_hash` (`host_store.rs:1385`); a new row raises the embedding watermark in the same transaction (`raise_embedding_watermark`, `host_store.rs:1858`; draft **embedding rule**). The response id is the row's id either way.
   - `update`: `UPDATE memories SET content, category, normalized_hash, updated_at = now_ms WHERE id = ? AND project_path = ?` plus one `memory_mutation_log` row `('update', target, NULL, category, new_content, queued_at = now_ms)` in the host's shape (`packages/plugin/src/features/magic-context/storage-memory-mutation-log.ts:81-92`), written only if no row with that `(target, 'update', queued_at)` exists.
   - `archive` / batch archive: `status = 'archived'`, idempotent as today (`memory_tool.rs:265-267`), plus an `archive` log row under the same existence rule.
   - `merge`: the canonical row's content and the sources' `superseded_by_memory_id`, plus one `superseded` log row per source, under the same existence rule; a resumed merge whose sources are already superseded by the target reports the original success.
   - validation (ownership, primary-ness, category, duplicate content) runs inside T2 on the context rows, with the same errors `memory_tool.rs` renders today.
3. **T3 (`store.db`)**: replace the pending entry with the final response (`UPDATE … SET response_json = ? WHERE <key> AND response_json = <pending bytes>`), then trim to 512 as today (`lib.rs:8521-8535`).

A command without a `command_id` runs T2 alone, exactly as unledgered commands run today (`lib.rs:13516-13518` logs the missing id).

Crash windows:

| crash after | state | retry with the same `command_id` | a later command |
|---|---|---|---|
| T1 | pending entry, no row | resumes, T2 applies, T3 answers | unaffected |
| T2 | pending entry, row written | resumes, T2 finds its own rows (no-op), T3 answers with the same reply | unaffected |
| T3 | final entry | `Duplicate`, as today | unaffected |

A pending entry that is never retried is aged out by the 512-row trim like any other entry. The one behaviour change is that a crash between T1 and T2 and no retry leaves no row, where today the whole command would also have rolled back: same outcome.

### 8.2 Facade notes writes

The same three-transaction protocol, with the `notes` writer in the host's shape (the columns and defaults of `context-db-schema.sql:444-461`; `harness` from the session's `session_projects` row, or `'opencode'` for a project smart note, **Q3**):

- `write` (session note, project note, smart note with its `surface_condition`): resume-idempotent on `(type, session_id or project_path, content, created_at = now_ms)`, as `insert_notes` already is (`host_store.rs:1611-1645`). A NULL-project session note is in P's scope through S(P), as the move treats it (draft **scope extension**).
- `update`: CAS on the `updated_at` and `status` the facade read (`lib.rs` `ctx_note update` reads the note first); a mismatch is the existing "changed concurrently; retry with a fresh read" reply.
- `dismiss`: `status = 'dismissed'`, `updated_at = now_ms`; idempotent.
- `note.evaluate`: the CAS token of 5.3.

### 8.3 Dreamer metadata writes

`memory.set_classification`, `set_mural_cue`, `set_verification`, `set_mapping` (`lib.rs:12646-13113`) update metadata columns of existing memory rows through `with_facade_mutation` (`lib.rs:8556`), gated on the store authority row being `MODULE` at the caller's generation (`lib.rs:12751-12768`). After neutralisation that row is `TS`, so every such call for P fails today. Which writer owns these columns for a marked project is decision D2 ([section 12](#12-owner-decisions)); the module-route option uses the single-transaction T2 shape (no ledger, idempotent column updates) with context ids.

### 8.4 Fold publish with pending-publish resumption

For a marked session, `publish_historian_chunk` (`lib.rs:14259-14485`) becomes three steps. The historian builds, besides the store request (`historian.rs:986-1001`), the `FoldPublish` it already builds for the shadow writer (`fold_publish_view`, `historian.rs:1027-1034`), with the sequences the store step assigns.

**Step 1, one fenced `store.db` transaction** (holding the project write gate, `lib.rs:14263`):

1. Everything the store publish checks today, unchanged: cache row present, `row_version` CAS, historian phase, predicate, selected-range identities against the stored block identities, revert epoch (`lib.rs:14268-14345`).
2. Refuse with `single_store_publish_pending` if the session already has a `mc_single_store_pending_publish` row (migration 62, `lib.rs:3095-3114`).
3. In one `context.db` read transaction opened here (I4): the compartment set generation `(MAX(sequence), COUNT(*))`, compared with `predicate.compartment_set_generation` (today `lib.rs:14347-14366`); the session's existing ranges, for the overlap check `append_compartments_tx` does (`lib.rs:18799-18840`); and `next_sequence = MAX(sequence) + 1` (today `next_compartment_sequence_tx`, `lib.rs:18850`). The fold's compartments get sequences `next_sequence + i`, exactly as the store assigns them.
4. `mc_chunk_transcripts` rows for the fold (a cache table keyed by sequence; `insert_chunk_transcripts_tx`, `lib.rs:14383-14392`).
5. **`mc_compartment_dates`** rows for the fold (migration 63, ruling): `(session_id, sequence, start_message_id, end_message_id, start_date, end_date)`, primary key `(session_id, sequence)`, upserted. The dates are the ones `to_stored_compartment` computes from the boundary dates (`historian.rs:181-211`). They are a derived cache: never compared, rebuilt from any later rewrite of the same sequence, and ignored by the render unless the message ids match (7.9).
6. The meta update and `row_version + 1` (`lib.rs:14431-14447`).
7. The pending row: `(session_id, publish_json = FoldPublish as JSON, created_at)`.
8. No `mc_compartments`, `mc_memories` (fact promotion), `mc_compartment_events`, `mc_primer_candidates` or `mc_user_memory_candidates` row is written (draft **marker-first admission**: zero domain rows into `store.db`).

**Step 2, `context.db`**: `HostStore::publish_fold(&publish)` (`host_store.rs:2042`): staged chunks (memories with the watermark, notes, primer candidates, user observations), then the visibility chunk (facts, `replace_compartments_from_first_sequence`, events; `host_store.rs:2139-2193`). The visibility chunk gains one fence before it writes: the rows below the fold's first sequence must still have exactly the generation step 1 checked (`MAX(sequence) = first_sequence - 1` and the count), otherwise the chunk refuses with `single_store_publish_fenced`. The same check holds on a resume, because the fold's own rows are at or above the first sequence.

**Step 3, `store.db`**: delete the pending row, only if its `publish_json` is the one step 1 wrote.

Failure and crash windows:

| failure or crash | state | what happens next |
|---|---|---|
| step 1 fails or crashes | nothing committed | today's handling: the firing is retried or abandoned (`historian.rs:1043-1070`) |
| a step 2 chunk fails (busy, fingerprint, scope) | meta says published; pending row present; earlier staged chunks committed; the failed chunk invisible | the fold caller gets `single_store_publish_failed` and the status block carries it (draft Q8); the next pass for the session re-runs `publish_fold` from the pending row before anything else, which completes it (resume-idempotent) |
| crash inside step 2 | the same, minus the error reply | the next pass, or the boot pass over all pending rows, re-runs it |
| step 2 visibility fence refuses | the rows below the fold changed after step 1 | cannot happen while every compartment writer of the session is serialised (8.5); if it does, the pending row stays, fires stay refused for the session, the status block and `doctor` report `single_store_publish_fenced` with the session id, and nothing is overwritten |
| crash between step 2 and step 3 | fold complete, pending row present | the re-run writes nothing (resume) and step 3 clears the row |

The re-run is an ordinary operation at the start of a transform pass for the session (before the scheduler decision) and at boot. It holds the project write gate. It is not a render: it writes domain rows the m1 signal later sees as a new compartment sequence, which, per ARCHITECTURE.md invariant 3, rides the next bust ("A historian publish does NOT bust the cache").

While a pending row exists: a new fire is refused (the fire path reads the assembly snapshot first, `lib.rs:8807`, `historian_chunk.rs:777`; it checks the pending row there); `apply_state_sync` refuses a seed boundary (7.4); compartment rewrites are refused (8.5).

### 8.5 Every other compartment writer

Each `store.db` writer of `mc_compartments` has a marked-session form. All are serialised by the session's cache row (each already takes a `row_version` CAS or runs inside the historian phase), and all refuse while a pending publish row exists.

| writer | today | marked session |
|---|---|---|
| `replace_compartments` (`lib.rs:13257-13277`) | delete transcripts and compartments, insert the set | step 1 in `store.db`: delete transcripts, replace the session's `mc_compartment_dates`, write a pending row whose `publish_json` is `{"rewrite": {session_id, compartments}}`; step 2: one `context.db` visibility transaction replacing the session's compartments and deleting their events (the rule `replace_compartments_from_first_sequence` applies, `host_store.rs:1399-1401`); step 3 clears the row |
| `reset_session_for_recomp` (`lib.rs:13286`) | clears compartments and transcripts, resets the cache row with a bumped revert epoch | the cache-row reset and transcript delete in `store.db` with a pending `{"rewrite": {session_id, compartments: []}}`; the context delete as step 2 |
| `truncate_compartments_for_revert` (`lib.rs:13388`, deletes above a sequence, `:13483`) | one store transaction | the same pending shape with `{"truncate_above": seq}` |
| `append_compartments` (`lib.rs:13540`) and `append_filtered_noise_marker` (`lib.rs:13564`) | `append_compartments_tx` | the fold path of 8.4 with a `FoldPublish` carrying only compartments |
| `commit_state_import` (`lib.rs:11197`) | inserts compartments and the `mc_state_imports` row in one transaction | `context.db` first (one visibility transaction inserting the compartments), then the `mc_state_imports` row; on retry, a session whose context compartments equal the import's rows field for field and that has no `mc_state_imports` row is completed by writing that row and answering `Duplicate` |
| `apply_state_sync` seed (`lib.rs:12018-12037`) | writes seed compartments | skipped (7.4) |

`publish_json` is TEXT, so the tagged forms need no migration; the re-run dispatches on the tag.

### 8.6 `store.db` writers that must stop for a marked project

- `acknowledge_host_memory_ids` (`lib.rs:13619`, route `memory.identity.ack`, `lib.rs:9524`): refused with `single_store_tripwire`. It is also put behind the project write gate for every project, so the move's hold covers it (today it is not gated, so an acknowledgement could land during a copy and move the store log head the rebase reads).
- The memory and mutation replacement of `apply_state_sync` (7.4, point 4).
- Historian fact promotion, events, primers and user-memory candidates into `store.db` (8.4, step 1 point 8).
- The `mc_memories`/`mc_notes` changefeed for P stops because nothing writes those rows (draft **marker-first admission**).
- `mirror.pull` for P, `authority.prepare`/`seed`/`drain` for P: refused with `single_store_tripwire` (draft **marker-first admission**; B0's tripwires).

## 9. Workspaces

A workspace member renders the other members' shared memories, and the module caches one `MemoryRevision` over the whole union (`project_paths`, `lib.rs:5258-5265`). One revision cannot span two files, which is why the branch refuses a partial workspace today (`single_store_migrate.rs:2332-2349`).

### 9.1 Moving every member in one run (ruling)

`single_store.migrate {project}` for a project in a workspace moves the whole union (`resolve_workspace_membership(project).union_identities`, `lib.rs:15119`). The `single_store_workspace_partial` refusal is replaced by that expansion.

- **Before anything is written**, every member not already marked must pass every per-project refusal the run has today (authority `MODULE` in both domains, the **host-less predicate**, a `refused` phase needs `--retry`). The first failing member refuses the whole run with its own code, and the detail names the member. Members already marked (a workspace that gained members after its move) are skipped.
- **Hold**: `begin_copy` for every member, in sorted project order (so two runs can never hold each other's members in opposite orders), each with its session set.
- **Copy**: each member's model and plan as today (`build_model`, `plan`, `single_store_migrate.rs:833`, `:1540`), members in sorted order, chunks under the same budgets.
- **Final transaction**: holds back the last chunk of the last member; verifies every member; the drift snapshot covers every member's epochs and sessions; inserts every member's marker and `authority_managed` row. So no reader can observe a workspace with some members marked and others not. The final transaction stays under the 250 ms bound: it carries one chunk plus one marker and one `authority_managed` insert per member.
- **Neutralisation**: one `store.db` transaction flips every member, records every member's phase and applies the rebase patches of every member's sessions ([section 4](#4-the-rebase)).
- **Report**: per member, the existing per-table counts, plus the rebase counts (restatable, due, uninitialized).

### 9.2 The union a marked reader renders (ruling)

For a `Context` route, the union is filtered to members that carry a marker, read in the same `context.db` read transaction as the heads. An unmarked member is dropped:

- from the render pool (`memory_render_pool_filter_for_column`, `lib.rs:20240`), the heads, the mutation-log union, the visibility filters of 5.3, and the per-member floors of `trim_memories_to_budget` (`m0_compose.rs:253-306`);
- with **one warning** per (reader project, dropped member) per module process: `mc-module: workspace <name>: <member> has not moved into context.db; its shared memories are hidden from <reader> until it moves`;
- and **one doctor line** in the per-project authority report (`packages/cli/src/commands/doctor-authority.ts`, the report `0402ec646a` added): `workspace <name>: <member> not moved; run "magic-context doctor single-store migrate" in <member>`.

The workspace fingerprint that feeds the external revision (`workspace_fingerprint_for_membership`, `lib.rs:15152`; `m1_compose.rs:274-278`) is computed over the **served** union. When a dropped member later moves, the served union grows, the external revision changes, and the reader takes the HARD that a membership change already takes (`m1_compose.rs:129-138`: workspace changes are eager-HARD, because they change the m0 memory universe).

The mirror case, an **unmarked** reader whose union contains a marked member, is not covered by the ruling; it is decision D1.

## 10. Implementation order

`SINGLE_STORE_CAPABLE` stays `false` and `single_store.migrate` keeps refusing with `single_store_cutover_absent` (`single_store_migrate.rs:2276-2281`) until S6, so no step can mark a real project before the whole design is in; every step is tested on fixtures that set `assume_cutover` and install a `ContextDomainReader` on a fixture `context.db` (as step 1's tests do, `single_store_reads_tests.rs`). Each step is independently testable unless it says otherwise.

The cache-safety tests named below use three shapes, in `crates/mc-module` unit tests (module-served by construction) and in `packages/e2e-tests`:

- **prefix test**: one priced pass (a pass the scheduler executes, which renders), then one appended user message, then a pass the scheduler defers; the served messages up to and including m1 are byte-identical between the two passes.
- **four-defer replay**: four consecutive defer passes serve byte-identical outputs.
- **module-served replay**: the e2e harness starts sessions in TS mode, so these tests switch the session to rust mode first and assert each measured pass was served by the module (its `mc_pass_trace.last_completed_at_ms` advanced and the host logged no LKG replay) before comparing bytes. `packages/e2e-tests/scripts/pure-replay-differential.ts` is the driver for the byte comparison.

### S2: routed reads, the revision model and the CAS (one group)

Contents: `DomainRoute` and its two resolvers (2.1); per-pass pinning (2.2); the routed reads of 7.2, 7.3, 7.5, 7.8 and 7.9; `MemoryRevision.space`; `commit_transform`'s route check and context head re-read (3.3); the compose guard and `meta.single_store_space`, set by every HARD a `Context` route composes (so a session that starts after a move is in context space from its bootstrap); the note watermark `0`; the identity id maps on the render paths (`m1_compose.rs:381-389`, `:496`) and the `ctx_search` exclusion set (`lib.rs:13961-13976`).

Why one group: a revision built from `context.db` always conflicts with the `store.db` re-read in today's `commit_transform` (handoff finding 1), and a `context.db` re-read against a store-built revision always conflicts too. The reads and the CAS turn over together.

Tests:

- `marked_pass_runs_no_store_domain_statement` (the trace hook of 2.2).
- prefix test and four-defer replay on a marked session that bootstrapped after the move: `marked_priced_pass_append_then_defer_keeps_prefix`, `marked_four_defers_replay_identical`.
- H1: `context_memory_write_between_compose_and_commit_conflicts` (the write lands through `run_transform_attempt_hook`, `transform.rs:3246`; the pass conflicts, re-steps, defers, and the next signal reports the write as pending).
- H2: `marker_commit_between_compose_and_commit_conflicts`.
- H3: `marked_route_with_store_space_meta_replays` and `…_uninitialized_returns_copy_in_progress`.
- `soft_on_marked_session_renders_context_ids` (additions and `<memory-updates>` carry context ids).
- Unmarked regression: the existing transform, m0, m1 and store suites unchanged and green; `unmarked_pass_resolves_the_route_once`.
- Mutation proofs (the check must be able to fail): removing the context head re-read turns H1 red; removing the route check turns H2 red; removing the compose guard turns H3 red.

### S3: the rebase

Contents: `drift_snapshot` returned from the final transaction and recorded in the `marked` phase row; patch building (4.2); the patched `neutralize_single_store_project` (4.3); `single_store_refold_due` and the SOFT-to-HARD upgrade in both pipelines; the boot path (4.6); `mc_compartment_dates` population in the neutralisation (4.3 step 5) (needs migration 63 from S5, so S3 ships migration 63's DDL; S5 adds the writers).

Tests (on the move's own fixture, sessions warmed by real passes before `run()`):

- `rebase_current_session_first_pass_is_a_hit`: acceptance item 9, first half. Same served bytes as the last pre-move pass, plan `Defer`, no HARD.
- `rebase_pending_correction_renders_once_at_the_next_materialising_pass`: acceptance item 9, second half. Two defers replay; the first execute pass is a HARD with `materialize_reason = "single_store_rebase"`; the pass after it defers.
- `rebase_pending_addition_renders_one_soft`.
- `rebase_patch_expectation_mismatch_falls_back_to_due`.
- `boot_neutralisation_without_recorded_drift_marks_every_session_due`, and the crash matrix cell 4(d) extended: kill after the marker, boot, first pass per session is a hit.
- `neutralisation_twice_rebases_once`.
- `hard_render_before_and_after_the_move_is_identical` with a memory budget that admits every memory ([section 6](#6-render-ordering)).
- Prefix test and four-defer replay across the move: two defers before `run()`, two after, all four byte-identical (acceptance item 13 at unit level); e2e: the module-served replay over four defers before the move and four after, on an isolated root, driven by `pure-replay-differential.ts`.
- `b2-rebase-precision.ts` re-run on the drill copy after S3 must agree with the module's reported rebase counts.

### S4: the id space and the facade writes (one group)

Contents: the `"context"` lanes and the `"host"` refusal (5.2); every routed tool read and write of 5.3; the context memory and notes writers with the three-transaction ledger protocol (8.1, 8.2); the acknowledgement refusal and its write gate (8.6); decision D2's option; the plugin half: for a marked project the memory and note backends send the `"context"` lane with the agent's ids untranslated and skip the targeted mirror sync (`packages/plugin/src/hooks/magic-context/module-tool-backends.ts:150-205`, `packages/plugin/src/plugin/rust-note-backend.ts:195`).

Why one group: a tool that reads a context id and writes through the store path would update store row N (handoff finding 4). Memory reads and writes turn over together, and notes reads and writes turn over together.

Tests: for every row of 5.3, a test where the context row and its retained store twin differ and the tool reads or changes only the context row (acceptance item 7 style); `host_lane_is_refused_for_a_marked_project`; the three crash windows of 8.1 and 8.2 through the facade abandon hook (`lib.rs:8536-8546`), moved to fire after T1 and after T2; `ctx_memory_write_reply_is_the_context_id`; cache safety: prefix test with a `ctx_memory write` between the priced pass and the defer (a write is pending work and must not change the served prefix), and the same for `update`, `archive`, `merge`, `ctx_note write` and `dismiss`.

### S5: fold publish, compartment writers, state sync and dates

Contents: migration 63 writers; 8.4 end to end, including the re-run at pass start and at boot; 8.5; 7.4, 7.6 and 7.7; the date attachment of 7.9.

Tests: acceptance item 8 (fault at the second chunk through `publish_fold_observed`'s observer, `host_store.rs:2054-2060`; kill between the `store.db` commit and the first chunk); `publish_visibility_fence_refuses_a_changed_set`; `fire_is_refused_while_a_publish_is_pending`; `dates_render_the_same_after_the_move` (HARD before and after under a full budget, 6); `state_sync_seed_writes_no_domain_row`; acceptance item 7 counts (`store.db` counts of P unchanged across one fold, in modes `Off` and `Shadow`); cache safety: prefix test with a historian publish between the priced pass and the defer (the defer replays; the next execute SOFT carries the new compartment), and four-defer replay while a publish is pending and then completes.

### S6: workspaces and the capability flip

Contents: 9.1 and 9.2 and decision D1's option; the doctor line; `SINGLE_STORE_CAPABLE = true` (`lib.rs:3146`), which makes `cutover_present()` true outside tests; the plugin's marker-first session start (draft Q4) and the embedding-drain move out of the mirror block (draft Q12; today called at `packages/plugin/src/hooks/magic-context/rust-mode-transform.ts:4104`, inside the pull block that starts at `:4084`).

Tests: acceptance items 1-16 end to end; `workspace_moves_all_members_in_one_final_transaction` (an observer between transactions never sees a strict subset of the members marked); `marked_reader_drops_unmarked_member_with_one_warning`; `a_dropped_member_moving_later_hards_its_readers_once`; the real-store drill re-run with the rebase counts; the rollback drill (item 15).

## 11. Cost

### 11.1 Measured

`crates/mc-module/examples/single_store_attribution_cost.rs`, release build, on a copy of the post-move drill pair (`context.db` 6.9 GB with 17,111 memories, 12,670 compartments and 11,358 mutation-log rows; `store.db` 956 MB with 1,257 cached sessions; 5 marked projects with 3,999 attributed sessions), 300 sessions of each kind × 5 rounds, warm page cache:

| measure | sessions | p50 µs | p90 µs | p99 µs | max µs |
|---|---|---|---|---|---|
| store half of attribution (root bindings) | marked | 0 | 1 | 1 | 8 |
| context half (`session_projects` + marker) | marked | 4 | 4 | 10 | 30 |
| attribution, both halves | marked | 5 | 5 | 9 | 17 |
| attribution, both halves | unmarked | 3 | 3 | 7 | 26 |
| `is_marked(project)` | — | 2 | 2 | 6 | 10 |
| step-1 seam `load_compartment_events` (attribution + read) | marked | 7 | 7 | 47 | 21,036 (first touch of the file) |
| same | unmarked | 5 | 5 | 14 | 24 |
| same read on `store.db` without the seam | unmarked | 0 | 0 | 1 | 8 |
| revision heads (3 reads, one transaction) on `context.db` | marked | 21 | 34 | 42 | 8,528 |
| the same heads on the retained `store.db` rows | marked | 3 | 3 | 7 | 1,056 |

To reproduce: `MC_ATTRIBUTION_DRILL_DIR=$TMPDIR/magic-context/<task>/drill cargo run --release -p mc-module --example single_store_attribution_cost` on a copy made by `$TMPDIR/magic-context/b2/prepare-drill.sh` and a real move (the example refuses any directory outside the temp directory; it reads domain rows only, though opening the store copy takes that copy's writer lease). The rebase counts of 4.7 come from `bun packages/e2e-tests/scripts/b2-rebase-precision.ts <same dir>`.

Both head reads use covering indexes (`idx_memories_project_status_expires` and `idx_mc_memories_project_status`, `idx_memory_mutation_log_project`, the `(session_id, sequence)` unique indexes); the context read is slower per call on the much larger file, not by plan.

### 11.2 Per pass

- **Unmarked project**: one route resolution per pass (attribution ≈ 3 µs + marker ≈ 2 µs at p50) and one marker read inside the `commit_transform` write transaction (≈ 2 µs). About **7 µs per pass**, against today. With per-pass pinning, the step-1 per-call resolution (≈ 5 µs per seam call) no longer multiplies by the number of domain reads a pass makes.
- **Marked project**: the same route cost (≈ 7 µs), the revision heads from `context.db` (≈ 21 µs p50 instead of ≈ 3 µs), and on a pass that commits a revision (HARD or SOFT only) a second heads read inside the `store.db` write transaction (≈ 21 µs, which is also how much longer the `store.db` write lock is held on those passes). A defer pass: about **30 µs** over today; a bust pass: about **55 µs** plus composition reads, which run the same indexed queries on the larger file.
- **First touch**: the first read of a cold 6.9 GB file took up to 21 ms (the `max` column). That is a page-cache effect per process, not per pass.

### 11.3 Decision: no attribution cache

The session-to-project attribution is **not cached**. It costs 3-5 µs; a cache would save that and need invalidation on three events that happen in two processes and two files: a `session_projects` row written by the host, a root binding committed by `commit_transform` or pruned after 30 days (`prune_transform_session_roots`, `lib.rs:8383-8400`), and a marker committed by a move. The one that matters, the marker, must never be served stale (draft: "The marker read is never cached"; step 1's doc, `single_store_domain.rs:11-12`), and a stale "unmarked" answer right after a move is exactly the case that serves retained rows. Per-pass pinning (2.2) removes the repeated cost instead, and the commit-time route check (2.3) makes a pinned route safe across a move.

## 12. Owner decisions

- **D1. An unmarked reader whose workspace union contains a marked member.** A member joining after the move, or a workspace edited in the host, can create it. The retained `store.db` rows of the marked member are stale, so the unmarked reader must not serve them. Options: (a) drop the marked member from the unmarked reader's union with the same one-warning, one-doctor-line rule as 9.2; (b) read the marked member's rows from `context.db` into a store-route render, which puts one render pool across two files and needs a second, cross-file revision; (c) refuse the edit, which the module cannot do because the host owns workspace tables. **Recommended default: (a).** The unmarked reader's shared view shrinks until it moves too, and `doctor` says so.
- **D2. Who writes dreamer metadata (`set_classification`, `set_mural_cue`, `set_verification`, `set_mapping`) for a marked project.** (a) The module, on the `"context"` lane with context ids, no store authority check (the marker is the authority), in one privileged scoped transaction; (b) the host, directly in `context.db` under its privileged bracket, as it does in TS authority. **Recommended default: (a)**, which keeps the module as the only writer of a marked project's domain rows and keeps one code path for rust mode; (b) is smaller for the plugin but gives the project two writers of the same rows.
- **D3. Copy the pending tail of `mc_memory_mutation_log` into `memory_mutation_log` to make more sessions restatable.** Due sessions (4.5) pay one m0 rebuild on their next materialising pass. Copying the log rows after each session's cursor, with translated ids, would let them take a SOFT instead. It contradicts the draft non-goal "Copying `memory_mutation_log` history". **Recommended default: do not copy.** On the specimen every due session was idle past the cache TTL, so its next pass is a HARD anyway (4.7).
- **D4. What "rolling the plugin back to B0 is supported" means for tools.** A B0 plugin sends the `"host"` lane with store ids from `mirror_identity`; this design refuses it for a marked project (5.2), so `ctx_memory` and `ctx_note` return an upgrade error on a marked project under a B0 plugin, while transforms keep working. **Recommended default: fail closed as designed** (the alternative, honouring translated store ids, is exactly the wrong-row case of handoff finding 3).

## 13. Open risks

- **Write-lock hold.** The in-commit `context.db` read (3.3) lengthens the `store.db` write transaction of bust passes by one heads read, ≈ 21 µs p50 warm and up to the file's cold-read latency (8.5 ms max observed on the heads, 21 ms on a first touch). No other writer waits on `store.db` long (the module is its only writer), but a slow `context.db` read now delays every other session's commit behind it.
- **Passes during the move window.** For up to 120 s (owner ruling 1) P's sessions replay instead of composing (H3), and a P session that has never rendered gets `single_store_copy_in_progress`. A session in the emergency band during that window cannot fold and may hit a provider overflow; the host's LKG replay then applies. The hold is operator-triggered (owner ruling 3), so the window is chosen.
- **One rebuild per due session.** Measured as free on the specimen (4.7), but a live store moved while many sessions are warm would pay one m0 rebuild per due session on its next materialising pass.
- **A stuck pending publish.** The visibility fence (8.4) should never refuse while every compartment writer is serialised; if a path is missed, that session's historian stops until the row is repaired, loudly. There is no automatic repair in this design.
- **Behaviour differences of the context writers.** Historian facts written through `FoldPublish` follow the host's writer: `normalized_hash = compute_normalized_hash(content)` and a re-seen fact bumps `seen_count` and `last_seen_at` (`host_store.rs:1549-1609`), where the store's `promote_facts_tx` skips a re-seen fact and stamps a unique `historian-exact:` hash (`lib.rs:19086-19150`). After the move P's memories behave like a TS-mode project's. `last_seen_at` feeds selection (`m0_compose.rs:171-176`), so a later rebuild may keep a different memory at a tie than it would have before; never on a replay.
- **Mutation-log parity.** `memory_mutations_for_render`'s coalescing (`lib.rs:14957-15112`) is ported to `memory_mutation_log`. The module's context writers must produce exactly the row shapes the store writers produce; visibility markers are no longer produced for P. The S2/S4 tests cover each mutation type, but a missed shape renders a wrong `<memory-updates>` block on a SOFT.
- **Drift detection relies on the host's convention.** 4.6 treats an unchanged `domain_mutation_epoch` as "no memory or note write", which holds for privileged writers (they bump it) and unprivileged ones (the guards abort them). A TS-mode session on P (owner ruling 2 removes `authority_managed` in TS mode) disarms the guards; a TS-mode write to P's memories inside the seconds between the marker commit and the rebase read would go unnoticed and not be reported as pending in rust-mode sessions until their next HARD.
- **Retained rows grow stale forever.** By design (draft non-goals). Any future code that reads a `store.db` domain table without a route is a stale-read bug; the S2 trace test guards only the transform path, so facade, historian and status paths rely on review and the S4/S5 per-path tests.
