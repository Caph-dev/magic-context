# Nightly Rust hermetic lane red on master `304686005f` (2026-09-27)

## Production answer first

A production restart with plugin dists at `304686005f` and `ck-mc` at `7aae18ef`
does **not** hit this for Rust-mode sessions on OpenCode 1 whose historian model
has a normal context window (every mainstream model: 128k and up).

The cause is the historian prompt-fit guard from issue 541 (`cd1b13f7`, merged in
`e286d94b`; `ck-mc` `7aae18ef` contains it). It refuses a historian prompt that
cannot fit the historian model's own window. The failing tests run a historian on a
mock model with a 24k or 30k window, while the Rust module sizes the historian chunk
from `historian.context_limit_tokens` (default 128k, so a 32k-token chunk). A
32k chunk cannot fit a 30k model, so every firing is refused and no compartment
is ever written.

A real user is affected only when all of these hold:

- the historian model (or a fallback in its chain) has a window that OpenCode
  knows and that is below roughly 60k tokens; the guard admits up to
  `0.97 × (window − min(output limit, window/4))` calibrated tokens, and a
  default-sized chunk calibrates to about 45k tokens;
- `historian.context_limit_tokens` is left at the 128k default, or set higher
  than that model can hold.

Such a user gets `historian firing failed … producer_prompt_fit_refused` on every
pass and no fold. Before issue 541 the same user sent the same oversized prompt to
the provider, which rejected it, so they got no fold then either. That makes it a
refusal moved earlier, not a new failure. A model whose window OpenCode does not
know is sent unguarded, as before.

## First bad commit

Tested `tests/rust-fold-under-pressure.test.ts` locally on OpenCode 1.18.32
(the version CI installs), in a throwaway root:

| ref | result |
|---|---|
| `40e2ef7f32` (first parent of the 541 merge) | pass |
| `e286d94bb1` (merge of `cd1b13f7a2`, issue 541) | fail, same assertion as CI |
| `304686005f` (master) | fail, same assertion as CI |

`cd1b13f7a2`'s own parent (`5646872845`) is an ancestor of `40e2ef7f32`, so the
single commit brought in by the merge is `cd1b13f7a2` "guard issue 541 historian
model chain windows". None of the listed suspects (A3 host-runner default, #546
storage gate, proactive thinking strip, subc-daemon 0.22.0) is involved: the A3
change pinned `runner: broca` in `RustTestHarness`, and every failing test still
runs on the Broca lane.

The failure in the previous nightly (`d17d7a8c`, run 36230112796) was on shard
2, not shard 3: `tests/rust-real-or-absent-drops.test.ts`. `5365b6948d` fixed it,
and shard 2 passes in run 36308635138.

## Evidence

Module log (`magic-context/logs/magic-context.<date>.log` in the kept throwaway
root) for the failing fold-under-pressure run on master:

```
mc-module: historian firing for ses_…: await_timeout_ms=600000 …
mc-module: historian firing failed for ses_…: producer: subc error context_overflow:
  producer_prompt_fit_refused model=mock-anthropic/mock-sonnet calibrated_tokens=45018 limit=Some(21825)
```

The hermetic Broca producer log shows only `[broca] ready`: no historian request
ever reaches it. `limit=21825` is `0.97 × (30000 − 7500)`: the test's
`modelContextLimit: 30_000`, which is also the historian model's window because
the harness points `historian.opencode.model` at the same mock model.

Commit `cd1b13f7` saw this in three sibling tests and changed their
`modelContextLimit` from 30k/24k to 128k (`rust-historian-producer`,
`rust-host-runner-default`, `opencode2/rust-mode-host-runner-default`). It missed
the five files that went red:

- `tests/rust-fold-under-pressure.test.ts` (30k)
- `tests/rust-ctx-reduce-roundtrip.test.ts` (30k)
- `tests/rust-compaction-marker-byte-identity.test.ts` (30k)
- `tests/rust-maintenance-contract.test.ts` (30k)
- `tests/opencode2/rust-mode-fold-cadence.test.ts` (24k)

`rust-host-runner-default.test.ts` passes because the same commit raised it to
128k.

## Classification

This is a harness expectation, not a product regression. The guard is right to
refuse a prompt the historian model cannot hold. The failing tests gave the
historian a model smaller than any real historian model, and before issue 541
only the mock provider, which accepts any size, let them pass.

There is also a product gap, left for follow-up and not fixed here. TS mode sizes
the historian chunk from the historian model's own window
(`resolveHistorianContextLimit`). The Rust module sizes it from
`historian.context_limit_tokens`, even though issue 541 now sends it the chain's
known windows in `historian_model_limits`. So for a small-window historian model
Rust mode builds a chunk it will always refuse, where TS mode builds a smaller
chunk that fits. Changing the Rust chunk size changes chunk boundaries for every
historian model under 128k, so it needs its own review and should not ride on a
CI fix.

## Fix

See the section below, added after the fix landed.
