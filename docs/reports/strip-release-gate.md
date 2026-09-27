# Adversarial gate: proactive thinking strip on an LKG frozen-replay release

Delivery reviewed: `alfonso/task/bg_213e0f902defa85f-p1-post-restart-proactive-thinking-strip-busted-` at `b5b1d4b2` (parent `3fa97ac4`, reviewed against `origin/master` `0b0e79a4`).
This branch merges `b5b1d4b2` without changing any of its product code. It adds only reproduction tests and this report:

- `packages/plugin/src/hooks/magic-context/rust-mode-release-strip-gate.test.ts`
- `packages/plugin/src/features/magic-context/storage-notes-authority-heal-gate.test.ts`

A test written as `it.failing` reproduces a defect. It passes today because its final assertion fails. Once the defect is fixed it turns red and should be flipped to `it`.

**Verdict: SHIP-WITH-PINS.** The fix removes the production bust shape: a release that changes only the tail no longer strips thinking before the change. The permission, replay and notes-heal changes hold under attack.

One pin, P1, is a real regression in a narrower shape. A release on the first healthy pass after an uncaptured LKG replay strips nothing, although the tail it served has changed. On new accounts that turns master's full bust into a 400 followed by the reactive full bust. On old accounts it turns into a silent drop with no bust. If the chair treats any new 400 path as disqualifying, P1 is the blocker. Its fix is small (see below).

## Pins

### P1. After an error or park replay, the snapshot is not what was served last, and the release strips nothing

- **Shape.** The release compares the module's output with `getSlot(sessionId).jsonPrefix`. Only an applied pass captures that slot: a module pass or a frozen replay pass. `replayLastGood` serves the LKG prefix plus the raw tail on a module error (`rust-mode-transform.ts` ~4171) and on every parked pass (~2674), and it captures nothing.
  - If the next pass that reaches the module releases the freeze, the slot still holds the array from before the error. The raw tail those replays served lies past the end of the snapshot.
  - `firstServedDivergenceIndex` treats every message past the end as new, so it returns `null` and the strip permits nothing.
  - The module then tags the raw tail's user messages and tool outputs (`§N§`, `transform.rs` `apply_tag_prefix_to_block`). That changes the bytes inside the tail, and the thinking after the change stays on the wire.
- **Reachable triggers for "release on the first healthy pass":**
  - `raw_tail_growth_limit`: 16 messages counted from the first error. A module outage or park that spans 16 messages releases on the comeback pass.
  - `lkg_anthropic_reasoning_run_invalid`, when the pass after the error adds a second thinking assistant to a run.
  - `lkg_content_mismatch` and `lkg_invalidated_reshape`.
- **Reproductions** (`it.failing`, each red at its final `hasReasoning(served, "a2")` assertion when flipped to `it`):
  - "strips thinking after a tail the error replay served when the release follows it directly": HARD `[m1]`, then an error serving `[m1, a1, m2]` raw, then a release (reasoning run) where the module tags `m2`. `a2` keeps its thinking after the changed `m2`.
  - "strips thinking after the raw tail an outage served when the first healthy pass releases on tail growth": two failed passes serve a raw tail of 11 messages, and the comeback pass releases on `raw_tail_growth_limit`. `a2` keeps its thinking after the changed `m2`.
  - Control (green): "with one captured frozen pass between the error and the release, the same shape strips a2". One captured frozen pass is enough to make the comparison correct.
- **Consequence.** The blocks kept are bound to bytes that changed. Per `freezeReasoningOnBustingPass`'s own contract:
  - Older accounts drop them silently: no bust, and the model loses that thinking.
  - New accounts return a 400. The reactive binding recovery then strips everything, which costs the same full bust master paid plus one failed request.
  - Master stripped everything on this pass: a full bust, but never a 400.
  - With the real module the reasoning-run trigger is mostly benign, because the module's merged-reasoning residual already strips the second assistant of a run. The outage/growth shape is not benign: every assistant that follows a user turn typed during the outage opens its own run and keeps its thinking.
- **Minimal fix (either one):**
  1. Record what was actually served. Keep the served JSON of every serve in session state (LKG replay, frozen replay, module pass) and compare against that instead of the slot.
  2. Conservative option: when the pass before the release was an uncaptured LKG replay, strip from the end of the stored snapshot (`lastServed.length`), not from `null`. The over-strip is then bounded to the outage tail.
- The same staleness applies to `tool-sweep-policy.ts` `parseLastServedArray`, which reads the same slot. I did not probe it.

### P2. The comparison counts wire-invisible differences as changes

- **Reproduction** (`it.failing`, "keeps thinking when the only difference on a release is an empty text part the adapter drops"): a frozen pass served `a1` as `[reasoning, text]`. The harness then appended `{type:"text", text:""}` to `a1`. The frozen replay's content check sees the new part and releases (`lkg_content_mismatch`). The comparison reports index 1, and the strip removes `a1`'s thinking.
  - OpenCode's Anthropic adapter drops empty text parts (`sentinel.ts`), so the provider saw no change before the strip. The strip itself originates the change, from `a1` onward.
  - The host's own trailing-blank "strip" decision would normalize this, but only for assistants that a non-frozen pass served as the newest.
- More generally, `servedMessageKey` serializes whole parts, so any non-wire part field counts as a change. Pinned as current behaviour in "counts a changed non-wire part field (part time) as a change".
  - For messages the module leaves untouched, its codec returns the raw JSON value (`codec/opencode.rs` `encode_with_meta` returns `meta.raw` when unchanged). So in practice only harness-side mutation of already-served messages reaches this path.
- The cost is bounded: the bust starts at the first differing message, not at 0. Master stripped everything here.

### P3. Info fields that reach the wire are outside the key

- The pinned tests show `info.error` and `info.providerID`/`info.modelID` differences compare as "same". OpenCode skips a non-abort errored assistant and drops reasoning metadata for an assistant of another model.
- I found no path where the module output or host postprocess changes these fields relative to the served snapshot. A model switch releases through `lkg_model_mismatch`, and the provider cache is cold for the new model anyway. This is theoretical and needs no action beyond the pin.

### P4. The strip works per message

- When the first differing message is an assistant whose own text or tool output was tagged, its thinking comes before the change in the same message, yet the strip removes it. The bust then starts one block earlier than it needs to.
- This is the same design granularity the earlier proactive-strip review pinned. It is minor.

## Attacks with no defect found

- **Replay after a release** (green: "release -> defer -> defer, then error -> frozen -> second release, serve stable prefixes"):
  - Release 1 strips `a2` and `a3` only. Two defers serve its bytes exactly; the sha256 of the whole array matches, and so does the prefix sha256 after `m3` is appended.
  - A module error serves the LKG replay (prefix hash equal to the last defer). The frozen pass after it serves the same bytes.
  - Release 2 (module now tags `m4`) keeps `a4`, which carries thinking and sits between the already-stripped `a2`/`a3` and the change. Its prefix before `m4` hashes equal to the frozen pass. The strip set is exactly `a2, a3, a5, a6, a7`, and the defers after release 2 replay it byte for byte.
  - Only this test defends the moved pre-comparison `stripReasoningFromAssistantIds(recoveryMessageIds)` call. Without the move, the comparison sees `a2`'s restored thinking as a change and strips `a4` (mutation M2 below).
- **Permission from the module decision** (green):
  - HARD and SOFT strip every thinking block, including blocks before any changed byte.
  - HARD during an active freeze still strips everything, because the module bust takes precedence over the release.
  - SOFT+ without a freeze strips nothing, including thinking that arrives later after a tagged message.
  - `args.cacheBustingPass` is read only by `proactiveStripStartIndex` in `transform-postprocess-phase.ts`.
  - In `rust-mode-transform.ts`, the pass-level `cacheBustingPass` still drives slot drop, sync priced capture, `mirrorRustSyntheticTodoAnchor` and freeze bookkeeping, exactly as on master.
  - Reductions, m1 and note-nudge do not read the flag. The note-nudge append and hint appends run before the comparison, so a nudge appended to an already-served user message counts as a real change, which is correct.
  - TS mode and Pi are untouched.
- **Snapshot read before `replayLkg`**: the ordering is load-bearing (mutation M3 below).
- **Async-lagged slot** (`lkg_snapshot mode=async`): capture runs on `setImmediate` in production, and `jsonPrefix` is serialized synchronously at prepare time. Across frozen passes each capture is a strict prefix of the next served array, so lag alone cannot hide a change inside the snapshot. The real exposures are the uncaptured replays in P1, and a capture that fails or is declined: that drops the slot, so a release with no snapshot strips nothing (same class as P1).
- **Key normalization**: key order and `undefined` fields compare equal (pinned green).
- **Notes heal scoping** (green: `storage-notes-authority-heal-gate.test.ts`):
  - A host-owned parked note heals while another project is module-owned, and so does an unlinked session's note.
  - Every row the triggers guard is skipped without throwing: managed through `notes.project_path`, repair-pending direct or linked, and a note naming an unmanaged project whose session is linked to a managed one. The heal predicate is the trigger's own `managedAuthorityNoteRow`, so the two sets are equal.
  - A direct unprivileged UPDATE of a skipped row is still refused, which shows the skip is what avoids the abort.
  - A database without the authority tables and triggers heals every parked row, as before.

## Runs

- New tests from the delivery: `bun test src/hooks/magic-context/rust-mode-transform.test.ts -t "proactive thinking strip on a released frozen replay"` passed (3), and `storage-notes-authority-heal.test.ts` passed (1).
- Gate tests: 18 pass (the 3 `it.failing` pass as expected).
- `rust-mode-transform.test.ts` + `transform-postprocess-phase.test.ts` + `rust-mode-release-strip-gate.test.ts` + `storage-notes*`: 342 pass, 0 fail.
- `bun run typecheck` (packages/plugin): clean. `biome check` on the new files: clean.
- Pure replay: `bun packages/e2e-tests/scripts/pure-replay-differential.ts --ts-only origin/master b5b1d4b206`, run under a throwaway `XDG_*`/`OPENCODE_DB`/`MAGIC_CONTEXT_STORAGE_DIR` root in `$TMPDIR/magic-context/strip-release-gate/`. Result: `RESULT IDENTICAL defer_passes=4`. The defer passes were 588, 754, 920 and 1088 bytes, with sha256 `8e449116…`, `a6391f07…`, `4a86507e…` and `c03c4fc1…` on both refs. The mock never emits thinking, so the strip does not fire in e2e.

## Mutation checks

For each check: stage the file, mutate it, run the tests, restore with `git checkout -- <path>`, then confirm `git diff --stat` is empty.

| # | Mutation | Red | Stayed green |
|---|---|---|---|
| M1 | `proactiveStripStartIndex` returns 0 on any release (master behaviour) | the delivery's 3 release tests; gate: control, replay chain; both P1 `it.failing` (the body now passes) | the permission tests, P2 `it.failing` |
| M2 | Recovery-set strip moved back after the comparison | gate replay chain only (prefix hash before `m4`, line 431) | the delivery's 3 tests, all other gate tests |
| M3 | Slot read moved after `replayLkg` | the delivery's "strips only thinking after the first message a release changes"; gate: control, replay chain, P2 `it.failing` | the other release tests |
| M4 | Heal UPDATE unscoped | the delivery's heal test; gate: "a host-owned note heals…", "every row the authority triggers guard is skipped…" | "…still refused", "…without the ownership tables…" |
| M5 | The "no such table" fallback removed | gate: "a database without the ownership tables heals every parked row as before" | all others |
