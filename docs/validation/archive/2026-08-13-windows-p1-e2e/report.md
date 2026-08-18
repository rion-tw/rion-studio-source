# Windows P1 Desktop E2E Validation Report

## Final verdict

- Windows single-display validation: **PASS**.
- `pnpm.cmd run test:e2e:desktop:smoke`: **PASS**, exit `0`.
- `pnpm.cmd run test:e2e:desktop:full`: **PASS**, exit `0`.
- Required gates: **17/17 PASS**.
- Core eight automated journeys: **8/8 PASS**.
- Coverage manifest: P0 `13/13` (100%), P1 `12/12` (100%), P2 `0/2`.
- W1-W9 real Tauri/Win32/WebView2 acceptance: **PASS** through visible-UI desktop E2E plus native/SQLite evidence.
- W10-W11 mixed-DPI / negative-coordinate multi-display acceptance: **BLOCKED** because this VM exposes only one physical display.
- No product failure was rerun and hidden. Every material first failure and its artifact is retained below.

## Exact source and repository state

- Branch: `main` (no additional branch was created).
- Exact validated HEAD: `543aff44cf5c6c788e1a542366486d0c659d10fd`.
- `origin/main`: `fa0252083485cc8d0778cf2236a8b682966c2280`.
- Validated checkout was clean: both final smoke/full reports record `worktreeDirty=false` and `requestedCommit=commit=543aff44cf5c6c788e1a542366486d0c659d10fd`.
- The report itself was written only after the clean run, so the final working tree intentionally contains this uncommitted report update.
- Pushes from this Windows task: none.
- Local product-fix commits created during validation:
  - `543aff44` `fix(runtime): serialize restore session journals`
  - `4a42baef` `fix(runtime): prevent closed tab resurrection`
  - `c900995b` `fix(macro): honor WebView2 action callback deadline`
- Earlier macOS checkpoint incorporated from `origin/main`: code `634f89df917819d7a594600fbca829f0971794fc`, ledger `fa0252083485cc8d0778cf2236a8b682966c2280`; macOS smoke `2/2 PASS`, full `19 PASS + 2 expected crash terminations`.

## Environment

| Item | Observed value |
| --- | --- |
| Host | Windows 10 Pro, WindowsVersion 2009, build 26200, Parallels VM |
| Architecture | ARM64 |
| Memory / CPU | 17,173,250,048 bytes RAM (about 16 GiB), 4 logical CPUs |
| Node / pnpm | Node `v24.19.0`; pnpm `11.13.0` |
| Rust | `rustc 1.97.0 (aarch64-pc-windows-msvc)`, LLVM `22.1.6` |
| WebView2 | Installed runtime `151.0.4129.78` (also `151.0.4129.72` present); WDIO session reported Edge/WebView2 `151.0.0.0` |
| Display | One `\\.\DISPLAY1`, primary, 2560x1440; work area 2560x1392 |
| Native scale | DPI `192`, scale factor `2.0` (200%) |
| Final full interval | `2026-08-12T19:53:46.874Z` to `2026-08-12T20:07:07.503Z` (`2026-08-13 03:53:46` to `04:07:07` Asia/Taipei) |

The requested extended profile was not run: no second physical display and therefore no mixed-DPI or negative-coordinate topology exists. This is **BLOCKED**, not PASS.

## Required gates at exact SHA `543aff44`

All commands were run with `pnpm.cmd` where applicable. Complete stdout/stderr logs and the machine-readable ledger are under `C:\Users\aron\AppData\Local\Temp\rion-windows-543aff44-gates`.

| # | Command | Exit | Result / count |
| ---: | --- | ---: | --- |
| 1 | `pnpm.cmd install --frozen-lockfile` | 0 | PASS; frozen lockfile install, 0.6 s |
| 2 | `pnpm.cmd run check:e2e-coverage` | 0 | PASS; P0 13/13, P1 12/12, P2 0/2 |
| 3 | `pnpm.cmd run check:source-hygiene` | 0 | PASS; 1151 tracked files, 1.2 s |
| 4 | `pnpm.cmd run typecheck` | 0 | PASS, 4.0 s |
| 5 | `pnpm.cmd run lint` | 0 | PASS; 0 errors, 23 existing Fast Refresh warnings, 59.9 s |
| 6 | `pnpm.cmd run test` | 0 | PASS; Vitest 158 files / 887 tests under the default timeout, 179.2 s |
| 7 | `pnpm.cmd run lint:rust` | 0 | PASS, 42.4 s |
| 8 | `pnpm.cmd run test:rust` | 0 | PASS; rion-core 589 + rion-platform 18 + rion-tauri 424, 176.5 s |
| 9 | `cargo check -p rion-tauri --all-targets` | 0 | PASS, 20.2 s |
| 10 | `cargo build -p rion-tauri` | 0 | PASS, 12.6 s |
| 11 | `pnpm.cmd run build` | 0 | PASS, 41.8 s |
| 12 | `pnpm.cmd run check:desktop-e2e-isolation` | 0 | PASS, 1.8 s |
| 13 | `git diff --check` | 0 | PASS, 0.1 s |
| 14 | `pnpm.cmd run check:unused` | 0 | PASS, 14.2 s |
| 15 | `pnpm.cmd run check:cargo-dependencies` | 0 | PASS, 1.4 s |
| 16 | `cargo clippy -p rion-tauri --all-targets --features desktop-e2e --no-deps -- -D warnings` | 0 | PASS, 14.6 s |
| 17 | `cargo test -p rion-tauri --features desktop-e2e desktop_e2e::tests::event_filter_requires_every_requested_fence -- --exact` | 0 | PASS; 1/1, 54.1 s |

The default `pnpm.cmd run test` passed naturally, so the conditional 10-second Vitest fallback was not run. The older five-timeout/default-timeout result remains historical evidence and is not represented as a pass from a rerun.

## Desktop E2E commands

| Command | Exit | Exact result |
| --- | ---: | --- |
| `pnpm.cmd run test:e2e:desktop:smoke` with `RION_STUDIO_E2E_COMMIT=543aff44cf5c6c788e1a542366486d0c659d10fd` | 0 | PASS; `smoke-seed`, `smoke-restart` |
| `pnpm.cmd run test:e2e:desktop:full` with the same exact-SHA guard | 0 | PASS; all 21 phases terminalized as expected |
| `pnpm.cmd run test:e2e:desktop:extended` | not run | **BLOCKED**: only one physical display; no mixed-DPI topology |

Final smoke artifact: `C:\Users\aron\rion-studio-source\.desktop-e2e-artifacts\2026-08-12T19-51-08-811Z-win32`.

Final full artifact: `C:\Users\aron\rion-studio-source\.desktop-e2e-artifacts\2026-08-12T19-53-46-752Z-win32`.

## Full profile phases

| # | Phase | Status | Exit code | Notes |
| ---: | --- | --- | ---: | --- |
| 1 | `smoke-seed` | PASS | 0 | Seed entities and visible UI |
| 2 | `smoke-restart` | PASS | 0 | Restart persistence |
| 3 | `p0-macro-native-effect` | PASS | 0 | Native effect evidence |
| 4 | `p0-macro-background-tab` | PASS | 0 | Background-tab macro |
| 5 | `p0-macro-terminal-cleanup` | PASS | 0 | Terminal cleanup / no resurrection |
| 6 | `p0-tabs-visible-activation` | PASS | 0 | Visible tab activation |
| 7 | `p1-macro-multirole` | PASS | 0 | Multi-role behavior |
| 8 | `p1-role-session-seed` | PASS | 0 | Role-session seed |
| 9 | `p1-role-session-isolation` | PASS | 0 | Session isolation |
| 10 | `p1-workspace-shared-role` | PASS | 0 | Shared ownership |
| 11 | `p1-mutations` | PASS | 0 | CRUD and order persistence |
| 12 | `p1-workspace-recovery` | PASS | 0 | Recovery mutation |
| 13 | `p1-guard-cleanup` | PASS | 0 | Cleanup complete, clean exit |
| 14 | `p1-final-restart` | PASS | 0 | Clean final restart |
| 15 | `system-settings` | PASS | 0 | System settings journey |
| 16 | `seed` | PASS | 0 | Native lifecycle seed |
| 17 | `restart` | PASS | 0 | A-only restore cohort and window modes |
| 18 | `force-terminate` | EXPECTED_FORCE_TERMINATION | 0 | `expectedForcedTermination=true`; exact PID termination evidence retained |
| 19 | `crash-restart` | EXPECTED_FORCE_TERMINATION | 0 | `expectedForcedTermination=true`; exact PID termination evidence retained |
| 20 | `crash-discard` | PASS | 0 | Recovery discard terminalized |
| 21 | `recovery-final-restart` | PASS | 0 | Final clean state |

The current runner represents a verified exact-PID force termination with phase `exitCode=0`, status `EXPECTED_FORCE_TERMINATION`, and `expectedForcedTermination=true`. This is the observed current contract; it is not rewritten to match the older exit-1 expectation. Each forced phase contains `forced-termination.json`.

## Core eight P1/P0 journeys

| Journey | Full phase | Verdict |
| --- | --- | --- |
| `MACRO-NATIVE-EFFECT-003` | `p0-macro-native-effect` | PASS |
| `MACRO-BACKGROUND-TAB-004` | `p0-macro-background-tab` | PASS |
| `MACRO-TERMINAL-CLEANUP-006` | `p0-macro-terminal-cleanup` | PASS |
| `TABS-VISIBLE-ACTIVATION-003` | `p0-tabs-visible-activation` | PASS |
| `MACRO-MULTIROLE-005` | `p1-macro-multirole` | PASS |
| `ROLE-SESSION-ISOLATION-003` | `p1-role-session-isolation` | PASS |
| `WORKSPACE-SHARED-ROLE-003` | `p1-workspace-shared-role` | PASS |
| `WINDOW-RECOVERY-UI-007` | `crash-discard` | PASS |

The P1 coverage manifest additionally reports PASS/full coverage for `APP-FULL-CRUD-001`, `GAME-WINDOWS-TABS-001`, `APP-RECOVERY-001`, `SETTINGS-SYSTEM-001`, `APP-CRUD-REORDER-002`, `WORKSPACES-RECOVERY-002`, and `APP-QUIT-GUARD-002`. `NATIVE-DISPLAY-001` is mapped to the extended hardware profile and remains **BLOCKED on this host** despite manifest automation coverage.

## Windows checklist W1-W11

E2E is the primary acceptance mechanism. The full profile drives the real Tauri application through visible UI and couples it to authoritative native, event, and SQLite evidence. Computer Use was therefore not used to duplicate the already automated actions or substitute screen coordinates for assertions.

| Item | Verdict | Automated evidence |
| --- | --- | --- |
| W1 mode column / ARIA / localization | PASS | Rendered header must match one of the four shipped localized strings; `aria-sort=ascending`; semantic order normal → maximized → fullscreen. The active locale is rendered one at a time, while the contract matcher contains all four translations. |
| W2 zero-tab permanent window | PASS | Placement A → close/reopen → placement B → two more close/reopen rounds; permanent name, native title, generation and placement B preserved. |
| W3 maximize/restore | PASS | Native presentation round trip; normal bounds unchanged. |
| W4 minimize/restore | PASS | Minimized off-screen native placement does not pollute normal bounds. |
| W5 fullscreen/restore | PASS | Fullscreen uses 2560x1440; normal bounds restore unchanged. |
| W6 move/resize and stale placement fencing | PASS | Rapid A/B placement and mode transitions; generation/revision fencing prevents stale placement acceptance. |
| W7 three-round placement stability | PASS | Window A exact logical bounds stable through all lifecycle generations; no cumulative drift. |
| W8 three launching tabs | PASS | Close/reopen twice during launching; ordered alpha/beta/gamma, selected active tab, other tabs dormant, no empty restore/stuck restoring/ownership leak. |
| W9 A/B clean-exit cohort | PASS | A open and B closed before quit; only A auto-restores; B remains manually showable; saved fallback/native title/live projection verified. |
| W10 mixed-DPI / negative coordinates | BLOCKED | One physical display at DPI 192; required second real differently-scaled display absent. |
| W11 cross-monitor maximize/fullscreen/WM_DPICHANGED | BLOCKED | No second mixed-DPI physical monitor, so native cross-monitor round trip cannot be truthfully executed. |

## SQLite lifecycle evidence

Each row comes from the phase-local `sqlite-query.json` and SQLite snapshot.

| Phase | cleanExit | Generation | Live cohort | Restore-in-progress | Last focused | Permanent windows |
| --- | --- | ---: | --- | --- | --- | ---: |
| `seed` | true | 1 | `[A]` | `[]` | A | 6 |
| `restart` | true | 2 | `[A]` | `[]` | A | 6 |
| `force-terminate` | false | 3 | `[A,B,C]` | `[]` | C | 6 |
| `crash-restart` | false | 4 | `[A,B,C]` | `[]` | C | 6 |
| `crash-discard` | true | 5 | `[]` | `[]` | null | 6 |
| `recovery-final-restart` | true | 6 | `[]` | `[]` | null | 6 |

- Window A is exactly `{x:1590,y:662,width:900,height:650}` in all six SQLite snapshots; no accumulated drift.
- Window C retains exactly three ordered tabs, alpha/beta/gamma, with the same final active tab across all six snapshots.
- The clean-exit sequence is exactly `true, true, false, false, true, true` for the six lifecycle snapshots above.
- `p1-guard-cleanup` and `p1-final-restart` both record `cleanupComplete=true` and `cleanExit=true`.
- Role isolation records `sessionEntitiesCleaned=true`; shared role ownership records `sharedOwnershipEntitiesCleaned=true`; recovery records `recoveryWindowDeleted=true`; mutation order persists.

## Native/event evidence

Authoritative transcript: `C:\Users\aron\rion-studio-source\.desktop-e2e-artifacts\2026-08-12T19-53-46-752Z-win32\user-data\window-recovery-lifecycle\desktop-e2e\events.ndjson`.

- 35 `window-snapshot-read` events.
- 81 `placement-accepted` events carrying observation sequence, presentation, scale factor, generation, revision, native client/outer bounds, DPI and monitor work area.
- 9 `window-destroyed` events.
- 4 `application-final-flush-complete` events.
- Window A changes HWND across destruction/recreation while retaining title, DPI 192, scale factor 2.0 and exact normal bounds.
- The restart transcript covers normal, maximized, minimized, normal, fullscreen and normal presentations. Native client bounds change to 2560x1392 for maximized and 2560x1440 for fullscreen, while kernel `normalBounds` remains `{1590,662,900,650}`.
- Window C contains native HWND/PID, DPI, client rect, outer rect, monitor work area, generation/revision and destruction evidence.
- Although the event name is not literally `GetWindowPlacement`, `window-snapshot-read` contains the authoritative Win32 placement/readback fields produced by that path.

## Artifact inventory

- Gate ledger: `C:\Users\aron\AppData\Local\Temp\rion-windows-543aff44-gates\summary.csv`.
- Gate logs: `C:\Users\aron\AppData\Local\Temp\rion-windows-543aff44-gates\*.log`.
- Final smoke outer log: `C:\Users\aron\AppData\Local\Temp\rion-windows-543aff44-e2e-smoke.log`.
- Final smoke report: `C:\Users\aron\rion-studio-source\.desktop-e2e-artifacts\2026-08-12T19-51-08-811Z-win32\report.json`.
- Final full outer log: `C:\Users\aron\AppData\Local\Temp\rion-windows-543aff44-e2e-full.log`.
- Final full report: `C:\Users\aron\rion-studio-source\.desktop-e2e-artifacts\2026-08-12T19-53-46-752Z-win32\report.json`.
- Full phase artifacts: `C:\Users\aron\rion-studio-source\.desktop-e2e-artifacts\2026-08-12T19-53-46-752Z-win32\phases\*`.
- Every full phase directory retains `runner.log`, `wdio` logs, `screenshots`, `sqlite-query.json`, and a SQLite snapshot. Empty screenshot directories mean no failure screenshot was produced.
- `force-terminate` and `crash-restart` additionally retain SQLite WAL/SHM snapshots and `forced-termination.json`.
- Full user-data/event root: `C:\Users\aron\rion-studio-source\.desktop-e2e-artifacts\2026-08-12T19-53-46-752Z-win32\user-data`.

## Retained failures and fixes

No product failure was converted to green by an automatic rerun.

1. **Closed-tab resurrection / unavailable launch target**
   - First clean evidence: `C:\Users\aron\rion-studio-source\.desktop-e2e-artifacts\2026-08-12T18-33-32-491Z-win32` at exact `c900995b`, `worktreeDirty=false`.
   - `p0-macro-terminal-cleanup` failed after the final role-2 tab was destroyed; a later role-3 launch hit `TAURI_RUNTIME_LAUNCH_TARGET_UNAVAILABLE`, and stale tab rows remained in SQLite.
   - Fix: persist last-tab close through the retirement fence and use cached runtime tab count; add explicit desktop E2E resurrection assertions.
   - Fix commit: `4a42baef`.

2. **Restore-session journal race after crash restart**
   - First clean evidence: `C:\Users\aron\rion-studio-source\.desktop-e2e-artifacts\2026-08-12T19-17-56-242Z-win32` at exact `4a42baef`, `worktreeDirty=false`.
   - Phases 1-17 passed and force termination was expected. After crash-restart, the spec passed but runner SQLite validation found a resurrected restore-in-progress cohort `[A,B,C]`.
   - Cause: a native focus journal performed a whole-session read/modify/write concurrently with restore clearing and could overwrite the newer terminal state.
   - Fix: atomic Core `update_runtime_restore_session` under the state mutation guard plus a deterministic concurrency regression test.
   - Fix commit: `543aff44`.
   - Focused dirty diagnostic (not final acceptance): `C:\Users\aron\rion-studio-source\.desktop-e2e-artifacts\2026-08-12T19-35-00-796Z-win32`, exit 0 through seed/restart/force/crash and `restoreInProgress=[]`.
   - Correct focused concurrency evidence: `C:\Users\aron\AppData\Local\Temp\rion-windows-restore-session-race-fix\07-core-concurrency-test-actual.log`, 1/1 PASS. An earlier malformed `--exact` invocation ran 0 tests and is retained as `02-core-concurrency-test.log`; it is explicitly not counted as evidence.

3. **Source-contract regression while fixing cleanup**
   - Gate ledger: `C:\Users\aron\AppData\Local\Temp\rion-windows-6416555c-gates`.
   - 16 gates passed; `pnpm.cmd run test` exited 1 because two source-contract tests still asserted the old implementation text. This was not a timeout and was not reported as green.
   - The contracts were updated to assert the corrected behavior and folded into `4a42baef`; the final exact-SHA default test now passes 887/887.

4. **Infrastructure history**
   - `corepack enable` previously failed with `EPERM` under Program Files. Per instruction, all final commands used the already available `pnpm.cmd`; this did not change product results.
   - Before the VM memory increase, an older SHA's default Vitest run had five 5-second timeouts and its separate 10-second run had 869/869. Both results remain historical evidence. At final SHA, the default timeout passed without fallback.
   - No OOM occurred after VM memory was increased.

## Remaining blocker and handoff

- Only W10/W11 remain **BLOCKED**. They require two real displays with different DPI scales, including a negative-coordinate topology, to validate `WM_DPICHANGED`, taskbar work area, cross-monitor maximize/fullscreen/restore, HWND and native DPI readback.
- Do not mark the extended profile PASS on this one-display VM.
- Windows full acceptance at exact `543aff44cf5c6c788e1a542366486d0c659d10fd` is otherwise terminalized and PASS.
