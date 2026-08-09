# Windows Runtime Authority Validation Report

- Status: pass
- Starting exact SHA: `027cacba24986d2b066c04cb4eb81d82f58edd3d`
- Final validated-code exact SHA: `1dc52bf58c64096f7a9ddea143c1bcbb082b7fbb`
- Branch: `codex/runtime-single-authority`
- Windows build / architecture: Microsoft Windows 11 Pro 25H2, build `26200.8875` (`BuildLabEx 26100.1.arm64fre.ge_release.240331-1435`), ARM64
- WebView2 Runtime: `151.0.4129.72`
- Started / finished at: `2026-08-09T18:36:37.0342067+08:00` / `2026-08-10T07:14:52.2786447+08:00`

This report is Windows-native evidence for WR0-WR5 only. It does not claim that
the overall Runtime single-authority initiative is complete. No macOS, Linux
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

## Remaining blockers

None for Windows WR0-WR5. The migration ledger remains present and unchanged.
This report deliberately does not declare the wider initiative complete.
