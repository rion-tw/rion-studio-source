# Windows Runtime Authority Validation Report

- Status: pass
- Original validation starting exact SHA: `027cacba24986d2b066c04cb4eb81d82f58edd3d`
- Final-audit delta starting exact SHA: `865d2a07d887745563afcb7e5cba4b4992fd6194`
- Final-ledger successor starting exact SHA: `91f9d52df69ec87cb20c0f70ef171d9847ee4dc7`
- Final validated-code exact SHA: `91f9d52df69ec87cb20c0f70ef171d9847ee4dc7`
- Final branch exact SHA: the pushed report commit containing this field; its exact
  value is recorded by the post-push remote verification and final handoff because
  a Git commit cannot embed its own content-dependent SHA.
- Branch: `codex/runtime-single-authority`
- Windows build / architecture: Microsoft Windows 11 Pro 25H2, build `26200.8875` (`BuildLabEx 26100.1.arm64fre.ge_release.240331-1435`), ARM64
- WebView2 Runtime: `151.0.4129.72`
- Started / finished at: `2026-08-09T18:36:37.0342067+08:00` / `2026-08-10T17:24:43.0673818+08:00`

This report is Windows-native evidence for WR0-WR5, the final-audit WR7 delta,
and the WR8 final-ledger successor. It does not claim that the overall Runtime
single-authority initiative is complete. No macOS, Linux
portable build, mock runtime, or shared-crate-only compilation is used as native
evidence. Every automated timeout is reported as a failure or incomplete run,
never as success.

## Starting worktree

| Check | Exit | Evidence |
| --- | ---: | --- |
| `git rev-parse HEAD` | 0 | Required exact SHA `027cacba24986d2b066c04cb4eb81d82f58edd3d`. |
| `git branch --show-current` | 0 | `codex/runtime-single-authority`. |
| `git status --short` | 0 | Empty before validation changes. |
| Windows native host | 0 | Windows 11 Pro 25H2 `10.0.26200.8875`; native ARM64 PowerShell session on fixed NTFS `C:`; `WSL_INTEROP` absent. |
| `node --version` | 0 | `v24.19.0`. |
| `pnpm --version` | 0 | `11.13.0`; gates use `pnpm.cmd` because the host blocks the PowerShell shim. |
| `rustc --version --verbose` | 0 | `rustc 1.97.0`, host `aarch64-pc-windows-msvc`. |
| `rustup show active-toolchain` | 0 | Repository-overridden Windows ARM64 toolchain. |
| WebView2 version query | 0 | Evergreen Runtime `151.0.4129.72` under `C:\Program Files (x86)\Microsoft\EdgeWebView\Application`. |
| Signing credential audit | 0 | No production signing credential was introduced; owner-locked Authenticode-unsigned Windows policy remains unchanged. |

## Automated gates

The final authoritative run is listed unless the row explicitly describes an
earlier failed attempt. All commands ran on this Windows ARM64 host.

| Gate | Exit | Counts / evidence |
| --- | ---: | --- |
| `pnpm install --frozen-lockfile` | 0 | Lockfile unchanged; dependencies already current. |
| `pnpm run verify:system-only` | 0 | Tauri/System WebView boundary passed; no external Chrome, remote debugging, CDN rewrite, or runtime profile fallback. |
| `pnpm run check:hygiene` | 0 | 1,068 tracked files and 3 Cargo crates checked. Knip's 4 unused exports, 15 unused exported types, and 2 config hints were informational and non-failing. |
| `pnpm exec vitest run tests/rust-architecture-boundaries.test.ts tests/thin-typescript-boundary.test.ts` | 0 | 2/2 files, 6/6 tests. |
| `pnpm run typecheck` | 0 | TypeScript project build passed. |
| `pnpm run lint` | 0 | 0 errors; 23 existing React fast-refresh warnings. |
| First outer `pnpm run test` invocation | 124 | The command runner expired before Vitest returned; no success was inferred. |
| First completed `pnpm run test` | 1 | 139/146 files and 808/822 tests passed; 11 tests timed out under full parallel ARM64 load and 3 assertions were stale after the intended contract changes. |
| Focused renderer regressions | 0 | Corrected 3 stale expectations; 3/3 files and 30/30 tests passed. The four timeout-heavy files passed alone: 13/13, 17/17, 16/16, and 16/16. No timeout was relaxed. |
| Final `pnpm run test` | 0 | 146/146 files and 822/822 tests passed in 149.76 s. |
| Initial `pnpm run lint:rust` | 1 | Windows-only reachability exposed 50 library and 114 library-test compile errors; see failure 1 below. |
| Targeted Windows reachability regression | 0 | 1/1 passed (`windows_live_resize_contract_is_reachable_from_system_runtime_parent`). |
| Targeted RuntimeKernel/conformance run | 0 | 17/17 passed, including fake-Windows/fake-macOS projection conformance and deterministic 10,000-step model trace. This supplements rather than replaces native evidence. |
| Final `pnpm run lint:rust` | 0 | `cargo fmt --check` and workspace/all-target Clippy with `-D warnings` passed. |
| Final `pnpm run test:rust` | 0 | `rion-core` 566, `rion-platform` 18, `rion-studio-lib` 369, binary 0: total 953 passed, 0 failed/ignored. |
| `cargo check -p rion-tauri --all-targets` | 0 | Windows WebView2/Win32 adapter and all targets compiled in 8.77 s. |
| `cargo build -p rion-tauri` | 0 | Native ARM64 debug binary built. |
| `pnpm run build` | 0 | Typecheck, Vite production renderer (2,746 modules), and native Cargo build passed. Only the non-failing large-chunk warning remained. |
| `git diff --check` | 0 | No whitespace errors. |
| Generated bindings audit | 0 | `git diff -- src/shared/generated` empty; generated sources were not hand-edited. |

One resumed `pnpm run test:rust` attempt using `pnpm.ps1` exited 1 before Cargo
started because PowerShell script execution is disabled. The same installed pnpm
was invoked through `pnpm.cmd`; the complete gate above then exited 0. A prior
test cell lost during conversation compaction had no recoverable terminal status
and was not counted.

## Local fixture and runtime boundary

| Check | Status | Evidence |
| --- | --- | --- |
| Loopback fixture | pass | `http://127.0.0.1:41739/health` returned HTTP 200 and `{"ok":true,"port":41739}` from the required localhost-only fixture server. |
| Formal portable import | pass | Imported `tests/fixtures/runtime-authority/portable.json` through Rion Studio UI and retained it permanently. It contributed 1 game, 4 roles, 2 workspaces, 3 game windows, and 3 macros. Re-import was deterministic and did not duplicate IDs. |
| Final persisted totals | pass | Diagnostics recorded games 3, roles 9, workspaces 4, macros 4. The restored UI exposed 3 fixture game windows plus main (4 native windows total). |
| Runtime boundary | pass | Runtime process tree used Tauri + System WebView2 `151.0.4129.72`; no Chrome runtime, remote-debugging endpoint, or fallback profile was present. |

## Native transcripts

Computer Use used fresh `list_windows` / `get_window_state` reads before and
after every action. WebView2 accessibility was sometimes null, so the current
window was re-resolved and scoped Windows UI Automation or exact Win32 native
menu state was read for that action. No element index from a previous state was
reused. Native Save and tray menus were likewise re-read before clicking.

| ID | Status | Exact Windows observation / counter |
| --- | --- | --- |
| WUI-1 single admission / TabId | pass | Launched `[Runtime QA] Alpha`, then `[Runtime QA] Two Columns`, and exercised role/workspace/saved-window launch paths. The joined Alpha page retained its fixture counters and one logical/native Alpha surface; repeated intent selected the existing tab instead of creating a duplicate. |
| WUI-2 Windows HTML tabs | pass | Real WebView2 HTML strips showed Alpha/Beta ready tabs. Select, native tab shortcut, reorder, close, and cross-window move were performed with a fresh state around every action. Membership and active successor moved atomically; the same fixture page counters survived moves and no stale drag callback reverted the final order. |
| WUI-3 native window transaction | pass | Rename propagated to both Rion UI and Win32 title. Move, resize, maximize/restore, placement, window/role zoom, mute/unmute, hide/show, and relaunch were observed on the native windows. The only display was 5120x2880 at scale factor 2.0; restored physical geometry remained DPI-correct. Hidden pages were not stopped and relaunch used a new generation. |
| WUI-4 close / relaunch fences | pass | Loading and ready surfaces were closed then relaunched without duplicate ready/closed terminal states. During `[Runtime QA] Loop Until Stop`, main showed running=1; closing Beta terminalized the macro, main returned to running=0 and tabs 2->1, then Beta relaunched once. Close-before-attach and repeated-close paths left no tombstone tab or second surface. |
| WUI-5 restore | pass | Completed 5/5 formal **Quit Rion Studio** / relaunch rounds. For round 5 the current tray icon was resolved, its live native menu had 7 items, position 6 was exact `結束 Rion Studio`, and process absence was confirmed before relaunch. Relaunch restored main plus Window One/Two/Three, each saved two-tab membership/order/active selection and placement, with active roles 5 and running macros 0. |
| WUI-6 macro / renderer reload | pass | Once Input produced one KeyA and one click delta and returned running to 0. Loop increased click count while running, stopped cleanly, and released input. Nested ran the waited child then KeyN, with both parent/child terminal. Renderer reload restored AppSnapshot/tab projection without recreating WebView2; fixture counters continued from the pre-reload values. |
| WUI-7 stress | pass | Completed 20/20 launch-select-reorder/move-macro-close/relaunch cycles. Final fresh Alpha state reported `click=20`, `keydown=22`, with Alpha/Beta both ready. Completed 5/5 formal Quit/relaunch rounds. After the final three runtime-window closes, only main remained; after diagnostics export the exact Rion PID was stopped and no Rion window/process, orphan HTML tab, placeholder, cloaked runtime window, or Rion-owned WebView2 process remained. |

The Quit/relaunch count includes only formal tray Quit with exact process absence.
Exact `Stop-Process` operations used between source rebuilds were not counted.
Synthetic or tool timeout was never treated as a successful quit.

## Final diagnostics

The final bundle was exported through **Settings > Diagnostics & Logs > Export
diagnostics bundle** and the native Save dialog to
`C:\Users\aron\AppData\Local\Temp\Rion-Studio-Diagnostics-final-fixed.zip`.
The fresh dialog readback caught and corrected one dropped character before Save.
The resulting ZIP is 7,264,326 bytes, timestamp `2026-08-10T06:46:55+08:00`;
`diagnostics.json` was parsed directly from the ZIP.

| Field | Value |
| --- | ---: |
| `buildCommit` | `027cacba24986d2b066c04cb4eb81d82f58edd3d` (the debug build embeds the pre-commit validation base) |
| System engine / platform / available | `webview2` / `windows` / `true` |
| `healthy` | `true` |
| `snapshotComplete` | `true` |
| `collectionErrorCodes` | `[]` |
| `runtimeNativeResourceInvariantsOk` | `true` |
| `runtimeNativeResourceInvariantFailureCount` | `0` |
| `runtimeKernelPendingOperationCount` | `0` |
| `runtimeKernelLogicalSurfaceCount` | `0` |
| `managedSurfaceCount` | `0` |
| `closingSurfaceCount` | `0` |
| `quarantinedSurfaceCount` | `0` |
| `pendingCloseTabCount` | `0` |
| `activeNativeCreationCount` | `0` |
| `activeLifecycleOperationCount` | `0` |
| `activeNavigationOperationCount` | `0` |
| `activeInputFenceCount` | `0` |
| `recoveringRoleCount` | `0` |
| `displayHostCount` | `0` |
| `tabCount` | `0` |
| `roleCount` | `0` |
| `launchingTabCount` | `0` |
| `degradedTabCount` | `0` |
| `failedLaunchCount` | `0` |
| `retryableFailedLaunchCount` | `0` |
| `quarantinedRoleCount` | `0` |
| `retiredSurfaceCount` | `0` |
| `runtimeKernelTombstoneCount` | `0` |
| `shutdownState` | `accepting` |
| `recentFailures` | `[]` |
| Recent native operations | 7 terminal: 6 `applied`, 1 `degraded`, 0 nonterminal |
| Persisted data | games 3, roles 9, workspaces 4, macros 4 |
| `recoveryRequired` | `true` |

The terminal degraded operation is `native-presentation-4`, code
`MAIN_WINDOW_STATE_UNCONFIRMED`, stage `mainWindowReadbackUnconfirmed`,
`elapsedMs=0`; it did not derive success from its 5 s deadline. The subsequent
`native-presentation-7` `mainWindowShown` operation is `applied`. The
`recoveryRequired=true` marker records exact abnormal stops used solely to replace
the binary during defect repair. Neither is an idle resource leak or a WR4
required failure; every required ownership and activity value is zero.

## Reverse audit

| Audit | Exit | Result |
| --- | ---: | --- |
| Legacy authority / reconciliation search | 0 | One hit: test name `renderer_readiness_cancels_the_startup_watchdog_and_clears_failure`; no production `role_tabs`, `native_tab_hosts`, optimistic close authority, launch plan authority, owner probing, dirty scan, watchdog, or navigation reconciliation path. |
| RuntimeKernel `#[cfg(...)]` search | 0 | One `#[cfg(test)]` at `runtime_kernel.rs:22`; no platform branch in the pure kernel. |
| `allow(dead_code)` search | 1 | No matches (expected `rg` no-hit exit). |
| Renderer feature import audit | 1 | Excluding the single bridge installer, `src/renderer/src` has no Tauri, Node, Playwright, Puppeteer, or `__TAURI__` import; feature code uses typed `window.rionStudio`. The dedicated `src/renderer/runtime-shell` HTML-chrome adapters are Tauri-shell entrypoints and are covered by shell contract tests, not feature ownership. |
| `NativeResourceRegistry` audit | 0 | Only `display_hosts`, `retired_surface_registry`, `surface_registry`, and `tabs`: native handles plus last-applied projection metadata. Source comment keeps logical membership, role owner, relaunch eligibility, and persisted settings in RuntimeKernel. |
| Generated binding diff | 0 | Empty. |
| Final `git diff --check` | 0 | No whitespace errors. |

## Failures, root causes, fixes and reruns

### 1. Windows-only Rust reachability defects

**Reproduction:** first native `pnpm run lint:rust` failed with 50 library and
114 library-test compile errors.

**Root cause:** live-resize/reparent members were private to child modules while
their parent state machine used them; the Mica helper was reached through a
private glob import; snapshot readers still called `lock()`; Windows test imports
were incomplete; and one Windows branch was nested under outer
`#[cfg(not(windows))]`.

**Regression/fix:** restricted visibility only to the system-runtime owner,
added the owned wrapper, used immutable snapshots, corrected cfg reachability and
Windows imports, and added
`windows_live_resize_contract_is_reachable_from_system_runtime_parent`. No
dead-code allowance or invariant weakening was used.

**Rerun:** targeted regression 1/1, final Clippy/fmt, 953 Rust tests, all-target
check, native build, and full production build all passed.

### 2. WebView2 application-shortcut callback deadlock

**Reproduction:** physical Windows `SendKeys` Ctrl+Q reached the WebView2
`AcceleratorKeyPressed` callback and made the built binary `Responding=False`.

**Root cause:** the callback synchronously re-entered Tauri/Core through
`try_state` and `execute_shortcut`, violating the native callback/event-loop
boundary. An intermediate `spawn_blocking` attempt freed the callback but later
became unresponsive because Tauri UI effects ran on an arbitrary worker.

**Regression/fix:** the callback now marks the key handled and only schedules
`defer_windows_application_shortcut`; Core/Tauri work runs after callback return
through `app.run_on_main_thread`. The regression asserts the callback slice has
no `try_state` or `execute_shortcut` and that the deferred helper uses the main
thread.

**Rerun:** the same physical Ctrl+Q injection no longer hung the final binary;
Rion remained responsive through Diagnostics export. The injection itself did
not prove a formal quit and was not counted. All 5 formal exits used the live
tray Quit command and exact process absence. Final Rust, Vitest, lint, check, and
build gates passed.

### 3. Renderer full-suite failures

**Reproduction:** one completed full run had 11 parallel-load timeouts and 3
stale source expectations; an earlier runner invocation expired with exit 124.

**Root cause/fix:** each timeout-heavy file passed focused without changing a
timeout. The three expectations were updated for the intended RuntimeKernel
contract: runtime tab shortcut consumption, exact native topology reconciliation
call, and the new window-drag callback name.

**Rerun:** focused 30/30 and all timeout-heavy files passed; the authoritative
full run passed 146/146 files and 822/822 tests.

### 4. Initial Computer Use enumeration blocker

The pre-validation session could not enumerate the interactive desktop. After
the operator enabled full Computer Use access and restarted Windows/Codex, the
installed Computer Use skill became callable. The current `@oai/sky` surface
uses `list_windows`, `get_window`, and `get_window_state`; fresh snake-case calls
enumerated the Windows desktop. From that point onward the complete WUI run used
fresh states as recorded above. The earlier empty-list condition was not treated
as product evidence or as a pass.

## Final-audit delta validation

- Status: pass
- Required starting SHA: `865d2a07d887745563afcb7e5cba4b4992fd6194`
- Validated-code SHA: `87a3c8bb516b056975d9d079ace899af10f8a101`
- Audited range: `a055e17029573524b4878b9bdda47435b203c337..87a3c8bb516b056975d9d079ace899af10f8a101`
- Host: Windows 11 Pro 25H2 build `26200.8875`, ARM64
- Runtime: System WebView2 `151.0.4129.72`
- Validation window: 2026-08-10, Asia/Taipei

### WR7.1 worktree and ancestry

| Command | Exit | Evidence |
| --- | ---: | --- |
| `git switch codex/runtime-single-authority` | 0 | Switched to the required branch. |
| `git pull --ff-only` | 0 | Fast-forwarded `a055e170..865d2a07`; no merge commit. |
| `git status --short` | 0 | Empty at the required start and again at validated-code SHA. |
| `git rev-parse HEAD` | 0 | `865d2a07d887745563afcb7e5cba4b4992fd6194` at start. |
| `git rev-parse origin/codex/runtime-single-authority` | 0 | Same `865d2a07d887745563afcb7e5cba4b4992fd6194` at start. |
| `git merge-base --is-ancestor a055e17029573524b4878b9bdda47435b203c337 HEAD` | 0 | The prior Windows report commit is an ancestor of both the required start and final validated code. |
| `git rev-parse HEAD` after the defect fix | 0 | `87a3c8bb516b056975d9d079ace899af10f8a101`. |

The native environment was reconfirmed with exit 0: Node `v24.19.0`, pnpm
`11.13.0`, Rust `1.97.0` host `aarch64-pc-windows-msvc`, ARM64 native PowerShell,
and WebView2 `151.0.4129.72`. No production signing credential or distribution
policy changed.

### WR7.2 commit-range audit and evidence reuse

`git log`, `git diff --stat`, and `git diff --name-status` all exited 0. The
range contains two commits, 10 files, 209 insertions and 18 deletions:

| File / change | Authority audit | WUI consequence |
| --- | --- | --- |
| `.agents/runtime-authority-migration-ledger.md` | Bookkeeping keeps Windows W1-W4 and the wider initiative in progress; the ledger remains present. | No product path; all prior WUI evidence remains applicable. |
| `.agents/windows-runtime-authority-validation.md` | Adds only the permanent WR7 delta procedure. | No product path. |
| `src-tauri/src/lib/section_03_rion_overlay_request.rs` and `src-tauri/src/system_runtime.rs` | Rename/copy inputs into `defer_runtime_tab_shortcut`; no topology, launch, close, restore, macro, or renderer-reload writer is added. | Only WUI-2 shortcut dispatch required a physical delta retest. |
| `src-tauri/src/system_runtime/platform/windows/input_security.rs` | WebView2 callback now leaves its stack through `run_on_main_thread`; Core lookup and selection occur only in the later executor. | WUI-2/WR7.4 retested; Alt+Tab ownership also retested. |
| `src-tauri/src/system_runtime/section_23_create_tab.rs` | Both Windows-only tab-chrome bootstrap-failure flag and retirement call are explicitly `#[cfg(windows)]`; Windows behavior is unchanged. | No successful launch/restore path changed. |
| `tests/tauri-shell-contract.test.ts` and `tests/tauri-system-runtime-source.part-2.test.ts` | Regressions enforce callback/defer separation and both Windows cfg fences. | Test-only. |
| `crates/rion-core/src/runtime_kernel/state.rs` | After WR7.5 exposed two completed tombstones, terminal tombstones are retired when their owner window is absent, in either authoritative event order. No timer, polling, readback, invariant relaxation, or new state owner is introduced. | The live close/relaunch contract is unchanged; terminal cleanup after owner removal is strengthened. |
| `crates/rion-core/src/runtime_kernel/tests.rs` | New regression covers `Closed -> RemoveWindow` and `RemoveWindow -> Closed`, duplicate `Closed`, completed close operations, and zero pending/tombstone/logical ownership. | Test-only proof for WUI-4/WUI-7 terminal cleanup. |

Existing evidence reuse was reviewed item by item:

| Existing evidence | Reuse decision and reason |
| --- | --- |
| WUI-1 | Reused. Neither commit changes launch admission, permanent TabId selection, role/source deduplication, or effect admission. Full architecture, Core model, Rust, and renderer suites passed at the successor SHA. |
| WUI-3 | Reused. Native geometry, DPI, rename, resize, maximize, zoom, mute, hide/show, and generation code is outside the range. |
| WUI-4 | Reused with new regression and final physical close/idle proof. The fix only discards a terminal tombstone after its owning window no longer exists; live-window close/relaunch fencing and admission are untouched. |
| WUI-5 | Reused. Quit coordinator, process exit, SQLite clean-exit, restore projection, placement, tab order, and active selection are outside the range. The existing 5/5 formal Quit/relaunch evidence remains authoritative. |
| WUI-6 | Reused. Macro execution/input terminalization and renderer/AppSnapshot reload paths are outside the range. |
| WUI-7 | Reused for the broad 20-cycle launch/reorder/move/macro/close/relaunch and 5 formal Quit/relaunch transcript. WR7 additionally supplied 20 fresh shortcut cycles, a physical final runtime close, zero native/logical resources, and the two-order tombstone regression. |

### WR7.3 complete Windows required automated gates

The first complete run at `865d2a07` passed all required gates after one Rust
suite rerun, then WR7.5 found the tombstone defect. After the root fix, every
required command was run again from the beginning at exact SHA `87a3c8bb`; this
second run is the authoritative final gate, not a targeted-test substitute.

| Required command at `87a3c8bb` | Exit | Counts / evidence |
| --- | ---: | --- |
| `pnpm install --frozen-lockfile` | 0 | Lockfile unchanged; dependencies already current. |
| `pnpm run verify:system-only` | 0 | Tauri/System-runtime-only boundary passed. |
| `pnpm run check:hygiene` | 0 | 1,068 tracked files and 3 Rust crates; Knip output informational only. |
| `pnpm exec vitest run tests/rust-architecture-boundaries.test.ts tests/thin-typescript-boundary.test.ts` | 0 | 2/2 files, 6/6 tests. |
| `pnpm run typecheck` | 0 | TypeScript no errors. |
| `pnpm run lint` | 0 | 0 errors; 23 pre-existing react-refresh warnings. |
| `pnpm run test` | 0 | 146/146 files, 822/822 tests. |
| `pnpm run lint:rust` | 0 | `cargo fmt --check` and Clippy with warnings denied passed on Windows ARM64. |
| `pnpm run test:rust` | 0 | rion-core 567, rion-platform 18, rion-tauri library 369, binary 0: **954/954 passed**, 0 failed/ignored. |
| `cargo check -p rion-tauri --all-targets` | 0 | Windows-only WebView2/Win32 production and test reachability compiled. |
| `cargo build -p rion-tauri` | 0 | Native Windows ARM64 debug binary built. |
| `pnpm run build` | 0 | Typecheck, Vite 2,746 modules, and native Tauri Cargo build passed; only the existing bundle-size warning. |
| `git diff --check` | 0 | No whitespace errors. |
| `git diff --exit-code -- src/shared/generated` | 0 | Generated bindings clean; none hand-edited. |

The earlier `865d2a07` Rust suite had exit 1 for two deadline-contract tests
under host contention. Both exact tests immediately passed, and the complete
workspace rerun passed 953/953. No timeout, deadline, test, or production code
was relaxed and the failed run was not counted as success. The later
authoritative post-fix full Rust run passed 954/954 on its first run.

The new regression was first invoked with an incorrect exact filter that ran
0 tests; that invocation was explicitly not counted. The corrected command
`cargo test -p rion-core runtime_kernel::tests::removed_window_retires_terminal_close_tombstones_in_either_event_order -- --exact`
exited 0 with 1/1 test, before the complete final gates above.

### WR7.4 Windows WebView2 shortcut stress

The rebuilt `target\debug\rion-tauri.exe` at `87a3c8bb` used the loopback
fixture (`127.0.0.1:41739`, HTTP 200) and System WebView2. Computer Use
re-resolved the current runtime window and called `get_window_state` after every
Ctrl+Tab, Ctrl+Shift+Tab, and plain `a` probe; accessibility was null, so each
current screenshot and the fixture counters were the evidence. No stale element
index was reused.

| Checkpoint | Active HTML tab / exact fresh counters |
| --- | --- |
| Before round 1 | Gamma active: `keydown=0`, `focus=1`, `visibility=1`. |
| Round 5 | Gamma restored active: `keydown=10`, `focus=16`, `visibility=6`; Two Columns Beta `visibility=6`. |
| Round 10 | Gamma `keydown=20`, `focus=31`, `visibility=11`; Beta `visibility=11`. |
| Round 15 | Gamma `keydown=30`, `focus=46`, `visibility=16`; Beta `visibility=16`. |
| Round 20 | Gamma active: `keydown=40`, `focus=61`, `visibility=21`; Beta `visibility=21`. |

All 20/20 forward selections showed the Two Columns HTML tab and its visible
Beta WebView2. All 20/20 reverse selections showed Gamma active and visible.
The following plain `a` increased Gamma keydown exactly once per round, proving
Ctrl/Shift release. No cycle hung, skipped, or produced a duplicate selection
commit. Physical Alt+Tab switched to the Rion main window rather than another
HTML tab; after reactivation Gamma was still active at `40/61/21`, so Alt+Tab
was not intercepted and did not commit selection. A fresh target click changed
`click=0` to `click=1`, proving the runtime remained responsive.

### WR7.5 final idle diagnostics and defect repair

At `865d2a07`, after the first 20-round shortcut run and physical runtime close,
the official UI-exported diagnostic bundle had every WR4 required count at zero
and invariant true **except** `runtimeKernelTombstoneCount=2`. This was treated
as a defect, not as an idle pass.

The exact trace showed `RemoveWindow` revision 77 before two authoritative
native `Closed` events at revisions 78 and 79. RuntimeKernel removed tombstones
when relaunching the same tab, but did not retire a completed close tombstone
when its owning window had already been removed. Commit
`87a3c8bb516b056975d9d079ace899af10f8a101` fixes the event-order gap and adds
the two-order/duplicate-terminal regression described above.

After rebuilding and repeating WR7.4, Alt+Tab, and the official runtime close,
only the main Rion window remained and its live dashboard showed roles `0/9`
and actors `0/4`. The final bundle was exported through **Settings > Diagnostics
& Logs > Export diagnostics bundle** and the native Save dialog to
`C:\Users\aron\AppData\Local\Temp\Rion-Studio-Diagnostics-final-audit-87a3c8bb.zip`.
The ZIP was 8,183,924 bytes; `diagnostics.json` was read directly without using
the query to repair state.

| Required final field | Value |
| --- | ---: |
| `buildCommit` | `87a3c8bb516b056975d9d079ace899af10f8a101` |
| Engine / version / platform / architecture | `webview2` / `151.0.4129.72` / `win32` / `aarch64` |
| `healthy` / `snapshotComplete` | `true` / `true` |
| `collectionErrorCodes` | `[]` |
| `runtimeNativeResourceInvariantsOk` | `true` |
| `runtimeNativeResourceInvariantFailureCount` | `0` |
| `runtimeKernelPendingOperationCount` | `0` |
| `runtimeKernelLogicalSurfaceCount` | `0` |
| `runtimeKernelTombstoneCount` | `0` |
| `managedSurfaceCount` / `closingSurfaceCount` | `0` / `0` |
| `quarantinedSurfaceCount` / `pendingCloseTabCount` | `0` / `0` |
| `activeNativeCreationCount` | `0` |
| `activeLifecycleOperationCount` | `0` |
| `activeNavigationOperationCount` | `0` |
| `activeInputFenceCount` | `0` |
| `recoveringRoleCount` | `0` |
| `roleCount` / `tabCount` / `displayHostCount` | `0` / `0` / `0` |
| `recentFailures` | `[]` |
| Recent native operations | 80 records, 80 unique operation IDs, all 80 `applied`, 0 nonterminal |
| RuntimeKernel revision / shutdown state | `77` / `accepting` |
| Win32 graphics events | available, 0 events in the 30-minute diagnostic window |

`recoveryRequired=true` remains the historical marker from exact abnormal stops
used only between source rebuilds. As in the original report, it is not a WR4
required resource count and was not used to excuse a nonzero ownership value.
All required current ownership/activity values, including the newly audited
tombstone count, are zero.

### WR7.6-WR7.7 reverse source audit

| Audit command / slice | Exit | Result |
| --- | ---: | --- |
| Legacy authority/reconciliation `rg` from section 5 | 0 | One test-name hit, `renderer_readiness_cancels_the_startup_watchdog_and_clears_failure`; no production legacy authority, owner probe, polling, dirty scan, watchdog, or navigation reconciliation path. |
| RuntimeKernel `#[cfg(...)]` `rg` | 0 | Only `#[cfg(test)]` at `runtime_kernel.rs:22`; no platform branch in the pure kernel. |
| `rg -n "allow\(dead_code\)" crates src-tauri/src` | 1 | Expected no-hit exit; no dead-code suppression. |
| Renderer direct-runtime import audit excluding `tauri/installTauriBridge.ts` | 1 | Expected no-hit exit for Tauri, Node, Playwright, Puppeteer, and `__TAURI__`; 20 renderer files use typed `window.rionStudio`. |
| `NativeResourceRegistry` source audit | 0 | Exactly `display_hosts`, `retired_surface_registry`, `surface_registry`, and `tabs`, all native handle/projection metadata; the source comment explicitly excludes logical membership, role ownership, relaunch eligibility, and persisted settings. |
| `git diff --exit-code -- src/shared/generated` | 0 | Empty. |
| `git diff --check` at validated-code SHA | 0 | Clean. |
| `git status --short` at validated-code SHA | 0 | Empty. |

The exact WebView2 `AcceleratorKeyPressed` callback slice is
`input_security.rs:318-380`. It reads the event and physical modifiers, marks a
recognized shortcut handled, then calls only `defer_runtime_tab_shortcut` or
`defer_windows_application_shortcut`. The slice contains no `CoreState`,
`try_state`, selection preview/commit, or application-shortcut execution.
`defer_runtime_tab_shortcut` calls `app.run_on_main_thread` at lines 126-153;
only `execute_runtime_tab_shortcut` below it reads Core and submits selection.

The Windows tab-chrome bootstrap cleanup remains explicitly fenced twice in
`section_23_create_tab.rs`: `#[cfg(windows)]` before the failure flag at line 689
and before `retire_failed_windows_tab_chrome_host` at line 804. The regression
requires both exact source shapes; there is no non-Windows no-op or dead-code
allowance.

### WR7.8 report and publication

The report and the necessary RuntimeKernel fix are committed on
`codex/runtime-single-authority`. The final handoff records the exact report
commit and the exit-0 comparison of local HEAD against
`refs/heads/codex/runtime-single-authority`; embedding that commit's own SHA in
its tracked contents would change the SHA recursively.

## Final-ledger audit successor

- Status: pass
- Validated-code exact SHA: `91f9d52df69ec87cb20c0f70ef171d9847ee4dc7`
- Audit range: `87a3c8bb516b056975d9d079ace899af10f8a101..91f9d52df69ec87cb20c0f70ef171d9847ee4dc7`
- Host: Windows 11 Pro 25H2 build `26200.8875`, ARM64, System WebView2
  `151.0.4129.72`

### WR8.1-WR8.2 synchronization and range audit

| Command / check | Exit | Evidence |
| --- | ---: | --- |
| `git switch codex/runtime-single-authority` | 0 | Already on the requested branch. |
| `git pull --ff-only` | 0 | Fast-forwarded `6e1789b2..91f9d52d`. |
| `git status --short` | 0 | Empty before validation. |
| `git rev-parse HEAD` | 0 | `91f9d52df69ec87cb20c0f70ef171d9847ee4dc7`. |
| `git rev-parse origin/codex/runtime-single-authority` | 0 | Same exact SHA as local HEAD. |
| `git merge-base --is-ancestor 87a3c8bb516b056975d9d079ace899af10f8a101 HEAD` | 0 | Required WR7 validated-code SHA is an ancestor. |
| `git log --oneline 87a3c8bb..HEAD` | 0 | Two commits: `6e1789b2 docs(validation): record Windows final audit delta` and `91f9d52d fix(runtime): preserve uncertain close fences`. |
| `git diff --stat 87a3c8bb..HEAD` | 0 | 5 files, 355 insertions, 18 deletions. |
| Production-only range filter | 0 | Excluding `.agents/**` and `crates/rion-core/src/runtime_kernel/tests.rs`, the only production file is `crates/rion-core/src/runtime_kernel/state.rs`. |
| Runtime/platform/renderer reverse diff | 0 | No range delta in `src-tauri`, `src/renderer`, `src/shared`, or `crates/rion-platform`. |

The production delta is a pure RuntimeKernel predicate in `RemoveWindow`.
It retires a matching close tombstone only when the exact logical surface is
already absent and the matching operation is `Completed` or `Failed`.
`Indeterminate`, `Cancelled`, and `FailEventStream` retain both the tombstone
and the `Closing` logical surface, so a late ready event remains fenced. There
is no timer, polling, watchdog, readback, invariant relaxation, platform branch,
or second state owner. The remaining four changed files are the focused kernel
tests and the three requested validation/ledger documents.

### WR8.3 focused tombstone regression

| Command | Exit | Counts / coverage |
| --- | ---: | --- |
| `cargo test -p rion-core runtime_kernel::tests::removed_window_ -- --nocapture` | 0 | 2 passed, 0 failed, 566 filtered out. `removed_window_retires_terminal_close_tombstones_in_either_event_order` covers `Closed -> RemoveWindow`, `RemoveWindow -> Closed`, and duplicate `Closed`; `removed_window_preserves_a_close_fence_without_exact_surface_terminal` covers `Indeterminate`, `Cancelled`, `Failed`, and `FailEventStream`, including a rejected late ready event. |

### WR8.4 complete Windows required automated gates

Every required gate ran against exact code SHA
`91f9d52df69ec87cb20c0f70ef171d9847ee4dc7`; the full Vitest and Rust suites
were not replaced by targeted tests.

| Gate | Exit | Counts / evidence |
| --- | ---: | --- |
| `pnpm.cmd install --frozen-lockfile` | 0 | Lockfile install was already up to date. |
| `pnpm.cmd run verify:system-only` | 0 | System-runtime boundary verification passed. |
| `pnpm.cmd run check:hygiene` | 0 | 1,068 tracked files and 3 Rust crates checked; only the existing informational unused-export/type/hint inventory was printed. |
| `pnpm.cmd exec vitest run tests/rust-architecture-boundaries.test.ts tests/thin-typescript-boundary.test.ts` | 0 | 2/2 files, 6/6 tests. |
| `pnpm.cmd run typecheck` | 0 | TypeScript typecheck passed. |
| `pnpm.cmd run lint` | 0 | 0 errors; 23 existing warnings. |
| `pnpm.cmd run test` | 0 | Full Vitest: 146/146 files, 822/822 tests. |
| `pnpm.cmd run lint:rust` | 0 | `cargo fmt --check` plus workspace/all-target Clippy with `-D warnings` passed. |
| `pnpm.cmd run test:rust` | 0 | Full workspace/all-target Rust: `rion-core` 568, `rion-platform` 18, `rion-tauri` library 369, binary 0; total 955/955 passed. |
| `cargo check -p rion-tauri --all-targets` | 0 | Windows WebView2/Win32 production and test reachability compiled. |
| First `cargo build -p rion-tauri` | 1 | Environmental harness failure: an earlier exact debug binary process (PID 13040) still held `target\\debug\\rion-tauri.exe`, producing Windows OS error 5. No build result was accepted. |
| Re-run `cargo build -p rion-tauri` | 0 | After verifying and stopping only that exact stale PID, the native Windows build passed in 6.13 s. |
| `pnpm.cmd run build` | 0 | Production TypeScript/Vite/native build passed; 2,746 Vite modules transformed, with only the existing chunk-size warning. |
| `git diff --check` | 0 | Clean. |
| `git diff --exit-code -- src/shared/generated` | 0 | Generated bindings clean. |
| `git status --short` at validated-code SHA | 0 | Empty. |

### WR8.5 native launch, formal close, and Diagnostics idle gate

The exact new binary was launched from
`C:\Users\aron\rion-studio-source\target\debug\rion-tauri.exe` (PID 8236).
Through the formal main UI, one `Open: [Runtime QA] Alpha` action opened the
single saved QA runtime window titled
`[Runtime QA] Window One Renamed — Rion Studio`. Its live System WebView2
surface visibly rendered the local fixture (`[Runtime QA] qa-alpha` and
`qa-beta` counters) in the HTML tab/workspace chrome. The saved window included
its prior QA membership, but only one runtime window was created by the one UI
launch action.

The runtime window was formally closed with Win32 `Alt+F4`. A fresh post-action
read first showed the renderer dashboard return to roles `0/9` and actors
`0/4`; the next authoritative window enumeration contained only the main Rion
window. The live Diagnostics log showed, in order, native wrapper close
acceptance, exact native surface release, native destroyed dispatch, Core close
completion, and `The live tab tombstone completed after role isolation.` No
QA runtime window remained.

The final bundle was exported through **Settings > Diagnostics & Logs > Export
diagnostics bundle** and the native Save dialog. The retained evidence file is
`C:\Users\aron\AppData\Local\Temp\Rion-Studio-Diagnostics-WR8-91f9d52d.zip`,
8,174,446 bytes, timestamp `2026-08-10T17:21:54+08:00`; `diagnostics.json` was
read directly from the ZIP and was not used to repair state.

| Required final field | Value |
| --- | ---: |
| `buildCommit` | `91f9d52df69ec87cb20c0f70ef171d9847ee4dc7` |
| Engine / version / platform / architecture | `webview2` / `151.0.4129.72` / `win32` / `aarch64` |
| `healthy` / `snapshotComplete` | `true` / `true` |
| `collectionErrorCodes` | `[]` |
| `runtimeNativeResourceInvariantsOk` | `true` |
| `runtimeNativeResourceInvariantFailureCount` | `0` |
| `runtimeKernelPendingOperationCount` | `0` |
| `runtimeKernelLogicalSurfaceCount` | `0` |
| `runtimeKernelTombstoneCount` | `0` |
| `managedSurfaceCount` / `closingSurfaceCount` | `0` / `0` |
| `quarantinedSurfaceCount` / `pendingCloseTabCount` | `0` / `0` |
| `activeNativeCreationCount` | `0` |
| `activeLifecycleOperationCount` | `0` |
| `activeNavigationOperationCount` | `0` |
| `activeInputFenceCount` | `0` |
| `recoveringRoleCount` | `0` |
| `roleCount` / `tabCount` / `displayHostCount` | `0` / `0` / `0` |
| `launchingTabCount` / `degradedTabCount` | `0` / `0` |
| `failedLaunchCount` / `retryableFailedLaunchCount` | `0` / `0` |
| `quarantinedRoleCount` / `retiredSurfaceCount` | `0` / `0` |
| `recentFailures` | `[]` |
| Recent native operations | 61 records, 61 unique operation IDs: 58 `applied`, 2 terminal `superseded`, 1 terminal `degraded`, 0 nonterminal. |
| RuntimeKernel revision / shutdown state | `36` / `accepting` |
| Persisted data | games 3, roles 9, workspaces 4, macros 4 |
| Win32 graphics events | available, 0 events in the diagnostic window |

The terminal degraded record is the previously documented startup presentation
receipt `native-presentation-4`, code `MAIN_WINDOW_STATE_UNCONFIRMED`, with
`elapsedMs=1`; it did not infer success from its 5 s deadline. The two
`superseded` presentation receipts are also explicit terminal outcomes.
`recoveryRequired=true` remains the historical marker from exact process stops
between native rebuilds and is not a current resource count. All WR8 required
current ownership/activity values, including tombstone, are zero.

### WR8.6 evidence reuse and reverse source audit

The 20-round Ctrl+Tab/Ctrl+Shift+Tab stress and Alt+Tab ownership evidence from
WR7 is reused because the complete `87a3c8bb..91f9d52d` audit found no change to
shortcut, renderer, Win32/WebView2 platform, or tab-chrome production code.
Exact diffs of `src-tauri/src/system_runtime/platform/windows/input_security.rs`
and `crates/rion-core/src/coordinator/section_23_create_tab.rs` are empty.
Therefore the WR7 WUI-1 and WUI-3-WUI-7 transcripts remain applicable; WR8 adds
the new focused tombstone regression and new-binary close/idle-zero proof.

The unchanged `AcceleratorKeyPressed` callback still only recognizes the key,
marks it handled, and calls a defer helper. It does not read `CoreState`, preview
selection, or commit selection inside the callback. The unchanged tab-chrome
failure flag and cleanup call remain separately guarded by `#[cfg(windows)]`;
there is no non-Windows no-op or `allow(dead_code)` suppression.

### WR8 failures, root causes, reruns, and publication

- No product defect was found in the WR8 production delta.
- The first native build failed only because the previous validation binary
  locked the exact output path. After path/PID verification, only that stale
  process was stopped and the identical build command passed.
- During Diagnostics export, an expanded Windows filename-history combo caused
  an indexed automation click to select a historical suggestion instead of the
  Save button. No overwrite was accepted. The export was repeated through the
  same formal UI with a unique short filename and confirmed with `Return`; the
  resulting ZIP parsed successfully at the expected SHA and all required zero
  counts.

Only this report is changed by WR8 validation. It will be committed and pushed
on `codex/runtime-single-authority`; the final handoff records the report commit
and verifies local HEAD, the tracking ref, and the remote branch exact SHA are
identical. The migration ledger remains present, and this section does not
declare the wider initiative complete.

## Remaining blockers

None for Windows WR8.1-WR8.7. The migration ledger remains present. This report
deliberately does not declare the wider initiative complete; the macOS primary
work still owns the final reverse audit and eventual ledger deletion.
