# Windows-like storage refusal and OpenCode 2 boot

## Finding and limits

Compared `v0.43.2` with `v0.44.0`, and tested the affected paths on a real **OpenCode 2.0.18** CLI on macOS. The injected Windows process-list transport takes five seconds synchronously in the released implementation. A discovery record identifies another live PID, and the throwaway database records upstream version 90.

The regression is real: the 0.44.0 setup path synchronously opens storage; its migration guard synchronously lists processes and validates discovery records. Raising the supported fence from 90 to 91 activates that guard for a database that 0.43.2 could open without those probes. `openDatabaseAsync` was not sufficient: its migration guard also used the synchronous probes. RPC startup had another synchronous Windows liveness query.

**This reproduces a finite HTTP outage, not the reporter's indefinite restart loop.** The tagged storage gate has no interval timer. Its five-second constant limits *turn-driven* retries; it does not schedule them. Each gate retry opens storage, not another RPC listener. Multiple listener PIDs therefore require multiple host/plugin instances, not this gate alone. Repeated turns/RPC reads or repeated host initialization could amplify stalls, but the supplied logs do not establish which happened on the reporter's machine.

Another misleading diagnostic: the old RPC warning tested `!isPidAlive(pid)`, although that function returns the strings `alive`, `dead`, or `inconclusive`. All are truthy. That warning was not reliable proof of a live competing server. The asynchronous warning now compares explicitly with `alive`.

### What the fence-90 line establishes

The default `LATEST_SUPPORTED_VERSION` is 90 in 0.43.2 and 91 in 0.44.0/0.44.1. `supported_fence=v90` is inconsistent with an ordinary 0.44.x runtime. It strongly suggests an older loaded/cached build or mixed-process logs, not that a 0.44.x process merely stopped before migration 91. The boot-lane line is emitted by `finishDatabaseOpen`, not just before the migration guard.

There is also a runtime override, `MAGIC_CONTEXT_LATEST_SUPPORTED_VERSION`; the fence value alone is not an unconditional binary fingerprint. No evidence supplied here establishes such an override, the actual module loaded by the hung PID, or which process wrote each line. Do not infer that downgrading a different database/process is safe solely from this excerpt.

### Other affected versions

* **0.44.1:** affected; the same startup/storage code is present in the release base used for this work.
* **OpenCode 1 on Windows:** the shared synchronous probes can also pause its event loop. Its async hook opener previously called the synchronous guard too. The new async guard benefits that opener and RPC startup. OpenCode 1 does **not** use the new OpenCode 2 storage gate; this investigation does not claim its other legacy synchronous `openDatabase` consumers have all become asynchronous, nor reproduce an OpenCode 1 supervisor loop.

## Implementation

* Merged coordinated child-process hardening commit `016a74f5ef` (hidden windows and the synchronous snapshot cache).
* Added a genuinely asynchronous process snapshot using `execFile`, `windowsHide: true`, finite output size, a five-second CIM timeout and one-second tasklist/POSIX timeout. One snapshot supplies liveness, start time, command evidence and Pi ancestry; no per-discovery-file synchronous subprocesses remain in `openDatabaseAsync`.
* Async snapshots coalesce concurrent callers, cache successful **and failed** results for two seconds after completion, and retain previously confirmed process evidence if a refresh times out. This last rule matters under load: an actual e2e run first confirmed the blocker, then a timed-out `ps` refresh forgot it and allowed migration under the old inconclusive-probe policy. Retention keeps that known blocker until a successful scan establishes that it has exited. A failed refresh does not establish death for previously unknown PIDs.
* The v2 gate opens asynchronously, has one in-flight attempt, measures its retry interval from completion, and has no retry timer. Its synchronous `require` never launches synchronous discovery. Turns can join the one pending attempt without blocking HTTP.
* Setup spends at most a 100 ms asynchronous grace period waiting for storage, then continues registering the host hooks/RPC/commands without durable storage. SQLite boot busy waits on this lane use zero timeout; migration-lock retries already yield. As before, if storage is unavailable at registration, tools require a restart and historian/dreamer work is wired on recovery. A slow-but-eventually-successful initial open can now take this degraded route too; this is an intentional availability tradeoff rather than waiting for recovery before serving HTTP.
* V2 RPC handlers use that same gate instead of silently reopening refused storage synchronously on each sidebar request.
* No schema migration or supported-version bump was added.

## Real-host evidence

`packages/e2e-tests/tests/opencode2/storage-boot-readiness.test.ts` bundles the actual setup code together with injected probe transports. It runs the existing isolated OpenCode 2 runner, drives lazy plugin activation, and measures `/health` from the external test process. It samples after setup begins so first-time plugin import/installation is not confused with storage probing. The seeded database contains the version-90 migration marker; the refusal arm does not migrate it. The blocker is a live test PID advertised by a synthetic discovery record, not a second real MC listener.

| Code | Setup duration | HTTP observation |
|---|---:|---|
| archived 0.44.0 | 5,726 ms | eight timeouts with the initial 750 ms sampling deadline; readiness test red |
| archived 0.43.2 | 607 ms | no timeouts, max 823 ms with the final 2 s deadline; green |
| fixed, final run | 186 ms | no timeouts, max 73.34 ms with the final 2 s deadline; green |
| fixed with synchronous opener restored | 5,382 ms | two 2 s timeouts; regression test red |

The test's setup limit remains two seconds across these comparisons. An earlier 750 ms HTTP deadline was too aggressive for normal cold host work on this shared machine (even 0.43.2 could exceed it); the final deadline is two seconds, still below the injected five-second block. Cold activation/import time is recorded separately and is not asserted as storage latency.

The final readiness evidence is under `$TMPDIR/magic-context/boot-readiness/magic-context/boot-readiness/mc-opencode2-mf8M2y/readiness-evidence.json` in this run. It records the probe sequence, every latency, and `lsof -p <host pid> -Fn` database paths. All listed databases and WAL/SHM paths are under that host's throwaway root. The existing storage-refusal/recovery e2e also passed against the rebuilt plugin on 2.0.18, including blocked turns, a successful turn after stopping the blocker, notices, and historian recovery.

The live-store isolation rule: never open, read, write or migrate the live stores (`~/.local/share/opencode/*.db`, `~/.local/share/cortexkit/magic-context/{context,store}.db`, `~/.config/opencode/*`, `~/.config/cortexkit/*`); every host run goes through a throwaway root (`XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_RUNTIME_DIR`, `OPENCODE_DB`, `MAGIC_CONTEXT_STORAGE_DIR` under `$TMPDIR/magic-context/<task>/`), proven by `lsof -p <host pid>` listing only throwaway `.db` paths.

The runner uses `OPENCODE_DB=opencode2.db`, whose resolution is under its private `XDG_DATA_HOME`, rather than an absolute override. Final runs of both lanes used the required task-root parent. One earlier run of the existing recovery scenario used the runner's standard `$TMPDIR/mc-opencode2-*` private root before being rerun under the task parent. An early test-bundling mistake embedded `NODE_ENV=test`, causing an isolated test backstop DB outside the individual host root; the runner's open-path fence rejected it. Explicit production-mode bundling corrected it. Neither incident accessed a live store.

## Verification

* Plugin suite: 5,924 passed, 3 skipped, five timing-sensitive failures under parallel load. All five complete failed files reran serially: 31 passed, zero failures. An earlier suite attempt exceeded a 240-second command budget; the completed suite took about 650 seconds.
* Final scoped storage, RPC, guard and recovery units passed; they include an actual async guard with a five-second synchronous probe hook that is never called, a pending-probe heartbeat, coalescing, completion-based retry spacing, fallback budgets and retention of confirmed blockers.
* Plugin typecheck, lint and production build passed. A combined verification command was interrupted during declaration generation; the complete production build subsequently passed with an explicit zero exit status.
* The broad OpenCode 2 runner tsconfig has existing errors in unrelated lane tests and unresolved cross-package aliases. A narrow tsconfig extending the plugin's aliases checked the changed e2e test and its imports successfully.
* Comment review passed after clarifying the retained-process-evidence comment.
* Pure replay is run against the committed tree with `bun packages/e2e-tests/scripts/pure-replay-differential.ts --ts-only origin/master HEAD`; its result is recorded in the delivery declaration.

Safe staged-state mutation checks made the real-host readiness test fail when the synchronous opener was restored, the coalescing sentinel fail when the pending-attempt fence was removed, and the blocker-retention test fail when prior evidence was forgotten. Each mutation was restored before verification/commit. The broad coalescing mutation also reddened the existing rate-limit and recovery-count assertions; a targeted rerun isolated the new sentinel.
