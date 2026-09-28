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
* Setup races storage against a 100 ms asynchronous grace period, then continues registering the host hooks/RPC/commands without durable storage. `probeV2StorageAtBoot` owns that race and cancels the grace timer after a fast open. SQLite boot busy waits on this lane use zero timeout; migration-lock retries already yield. This is not a hard real-time guarantee for all of plugin setup: synchronous local SQLite/metadata work and unrelated host registration still consume CPU. The contended migration path is tested with a real writer lock, an outstanding process scan, and an event-loop heartbeat. The parent explicitly approved retaining the healthy-open grace rather than redesigning tool registration.
* V2 RPC handlers use that same gate instead of silently reopening refused storage synchronously on each sidebar request.
* No schema migration or supported-version bump was added.

### What the session gets after the grace expires

No Magic Context tool definitions are registered: `ctx_reduce` (when compaction is enabled), `ctx_expand`, `ctx_note`, `ctx_search`, and the memory-enabled `ctx_memory`/`ctx_memory_list` are absent. Recovery does **not** register them mid-session; restarting OpenCode is required. Even a new session in the same already-registered plugin instance does not fix that. `ctx_memory_list` is normally restricted to the dreamer rather than primary model requests.

HTTP, commands and RPC remain registered. While storage is unavailable, a turn is refused before the provider; the user gets a toast and a persisted storage notice naming the refusal/blocker. Those synthetic notices are removed from model requests. On recovery, normal turns and context transformation resume; historian/dreamer work is wired then where possible. The recovery notice explicitly says to restart OpenCode for the tools (and also historian/dreamer if their recovery failed). The model sees the available host tools, not newly restored Magic Context tools or the user-facing storage notices.

## Real-host evidence

`packages/e2e-tests/tests/opencode2/storage-boot-readiness.test.ts` bundles the actual setup code together with injected probe transports. It runs the existing isolated OpenCode 2 runner, drives lazy plugin activation, and measures `/health` from the external test process. It samples after setup begins so first-time plugin import/installation is not confused with storage probing. The seeded database contains the version-90 migration marker; the refusal arm does not migrate it. The blocker is a live test PID advertised by a synthetic discovery record, not a second real MC listener. The test also holds `BEGIN IMMEDIATE` on the version-90 database for five seconds after setup begins. It releases the writer lock without removing the advertised live server, and verifies that the fixed lane still has version 90.

Fresh continuation runs, using the same final two-second HTTP deadline:

| Code | Setup duration | Maximum setup heartbeat gap | HTTP observation |
|---|---:|---:|---|
| archived `v0.44.0` | 5,206 ms | 5,209 ms | three timeouts; regression test red |
| fixed after merging master | 761 ms | 611 ms | 30 successful samples, max 788.53 ms; green |

Both runs printed `opencode v2.0.18` from the actual CLI. They passed `MC_E2E_OPENCODE2_CLI=/Users/ufukaltinok/.local/share/cortexkit/e2e-bin/opencode-cli/2.0.18/node_modules/@opencode/cli/bin/opencode.exe` explicitly. The baseline was extracted with `git archive v0.44.0` into `$TMPDIR/magic-context/boot-baseline`; `MC_BOOT_SOURCE_ROOT` selected its plugin sources. No sync process-list hook ran with the fix; the baseline trace contains `sync-start` and `sync-end`. The fixed setup ended before `async-end`.

A proposed 300 ms total-host-setup assertion failed at 455 ms (and at 2,234 ms during concurrent analysis). The parent approved a structural host assertion instead: no synchronous probe, a maximum one-second event-loop heartbeat gap during setup, and no HTTP timeouts. Total setup and activation times remain evidence, not performance promises. The isolated unit exercises the exact boot-grace helper with locked storage and a pending probe, asserts a ten-millisecond heartbeat wins over the open, and asserts return within 300 ms; its final complete-file rerun passed in 114.68 ms.

Evidence files are `$TMPDIR/magic-context/boot-readiness/mc-opencode2-Q3H0xL/readiness-evidence.json` (baseline host PID 6653) and `$TMPDIR/magic-context/boot-readiness/mc-opencode2-q2HnBd/readiness-evidence.json` (fixed host PID 8268). Each records CLI version, PID, probe sequence, every HTTP latency, and `lsof -p <host pid> -Fn` database paths. All listed databases and WAL/SHM paths are under that host's throwaway root. This continuation reran the touched readiness lane, not the separate pre-existing recovery lane.

The live-store isolation rule: never open, read, write or migrate the live stores (`~/.local/share/opencode/*.db`, `~/.local/share/cortexkit/magic-context/{context,store}.db`, `~/.config/opencode/*`, `~/.config/cortexkit/*`); every host run goes through a throwaway root (`XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_RUNTIME_DIR`, `OPENCODE_DB`, `MAGIC_CONTEXT_STORAGE_DIR` under `$TMPDIR/magic-context/<task>/`), proven by `lsof -p <host pid>` listing only throwaway `.db` paths.

The runner uses `OPENCODE_DB=opencode2.db`, whose resolution is under its private `XDG_DATA_HOME`, rather than an absolute override. Final runs of both lanes used the required task-root parent. One earlier run of the existing recovery scenario used the runner's standard `$TMPDIR/mc-opencode2-*` private root before being rerun under the task parent. An early test-bundling mistake embedded `NODE_ENV=test`, causing an isolated test backstop DB outside the individual host root; the runner's open-path fence rejected it. Explicit production-mode bundling corrected it. Neither incident accessed a live store.

## Verification

* Merged `origin/master` at `7679e2a1691a8f70b9fe8ed80f34162af73a8aa6`, including the identity, latency sentinel and Rust planning changes. `bun install --frozen-lockfile` made no dependency changes.
* Plugin `bun run test`: 5,937 passed, 3 skipped, 3 timeout failures under load (newspaper flow, migration-checkpoint ledger, retrospective heap). All three complete files plus the two storage/probe files reran serially with a 120 s timeout: 25 passed, zero failures. No assertions were weakened in those files.
* CLI `bun run test`: 508 passed, one five-second timeout in the real-process cache probe. Its complete file reran with a 30 s timeout: 14 passed, zero failures; the real-process case took 9.79 s.
* Plugin `bun run typecheck`, `bun run lint`, and `bun run build` passed. The first typecheck caught the new timer's overload mismatch, which was fixed; another attempt exceeded its 240 s command budget before the successful 600 s-budget run.
* A temporary tsconfig extending the plugin aliases, with explicit plugin type roots, checked the changed e2e test and its imports using `packages/plugin/node_modules/.bin/tsc`; passed. The temporary config was removed. Root `bunx tsc` had resolved a different TypeScript version and rejected the inherited `baseUrl`; that was a tool selection mistake, not a source failure.
* Comment review completed; clarified that the advertised live server, not a remembered lock, keeps migration refused after the writer lock is released.
* Pure replay `bun packages/e2e-tests/scripts/pure-replay-differential.ts --ts-only origin/master HEAD` returned **IDENTICAL**, four defer passes. The checked code commit is `08b0194ac1cd27306dc6e9f79e9b133b011a5e7b`; the subsequent commit only updates this report. Replay hosts used `$TMPDIR/magic-context/boot-replay`; independent `lsof` monitoring of host PIDs 22313 and 23652 listed only their throwaway context/OpenCode databases. Logs and path evidence are `replay.log` and `lsof-evidence.json` in that task root.

Fresh staged-state mutation checks removed the pending-attempt fence, lengthened the boot grace to one second, and restored synchronous discovery inside `openDatabaseAsync`. Each made only its targeted regression test fail and was restored to an empty unstaged diff. The restored synchronous guard blocked for about 25 seconds across its several injected five-second subprocess probes and exceeded the test's 20-second timeout as well as losing the heartbeat race. Mutation details are in the delivery declaration; no mutation was committed.
