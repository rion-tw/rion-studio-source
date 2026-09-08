# Chromium Migration Execution Ledger

## Owner scope — 2026-09-09

The owner now requests only the final v22 configuration delta and the sole
Electron entry with old-runtime cleanup. All other previously remaining ledger
workstreams are removed from this task and are not prerequisites. This explicitly
supersedes the earlier protected-runtime hold for the requested repository
cleanup. Publication, merge and credential changes remain outside this task.

| Work package | Deliverables | Current state |
| --- | ---: | --- |
| Final v22 configuration delta | 1 | Read-only comparison complete: existing repository, App, updater secrets, endpoint, identity and asset names can be reused; see the configuration delta report. No remote settings changed. |
| Sole Electron entry and old-runtime cleanup | 2 | In progress: route default and release entry points to Electron, remove Tauri/System WebView runtime and obsolete build/test paths, then verify the resulting source. Retain Rust authority, AppKit and consumed v22 data compatibility. |

There are two scoped work packages / three deliverables, not the earlier four
packages / seven deliverables. One comparison deliverable is complete; both
implementation/verification deliverables remain in progress. API closure counts
from the retired backlog are no longer used to gate this task.

The [configuration delta](v22-configuration-delta.md) records exact baseline SHA,
GitHub observation time and release/asset IDs. No physical dual-monitor, actual
OS sleep/sign-out, real production updater transaction or terminal-promotion
execution is queued. Existing simulations and fixture evidence retain their
actual classifications; removed work is not labeled PASS.

## Evidence preservation

Previous Windows failures and successful native/profile/package runs remain
historical facts. They are not silently repaired by changing scope. Their full
commands, source SHAs and receipts are retained in Git at the prior ledger
revision [a366dc475b67380cfce7bb5640d00d490e243939](https://github.com/rion-tw/rion-studio-source/blob/a366dc475b67380cfce7bb5640d00d490e243939/docs/chromium-migration-execution-ledger.md)
and in the existing local artifacts. This compact ledger replaces the old task
queue rather than carrying removed gates into future handoffs.

This change is internal documentation. New code, build and validation receipts
must identify their actual source SHA separately from document-only commits.

## Cleanup implementation checkpoint — 2026-09-09

Source baseline: `e61895ba3848947132191eb55e3f73026f548bf7` plus the uncommitted
cleanup worktree. These intermediate results are not verification of a new
immutable runtime candidate. Record a full source SHA when the implementation
is ready for final native/profile/package validation.

Default development/build/package entry points now target Electron. The Tauri
shell crate, renderer bridge, runtime documents, native WebKit/WebView2 engines
and obsolete E2E driver are removed from the worktree. Shared Rust data contracts,
AppKit, and consumed legacy installation/data handling remain. The existing
Tauri CLI is retained only for updater signing. Release/CI references and tests
are being adapted; the worktree is not yet a completed cutover.

| Check | Observed result | Local artifact |
| --- | --- | --- |
| Initial cleanup Rust workspace check | PASS | `sole-electron-cargo-check.log` |
| Initial cleanup Rust lint | PASS | `sole-electron-rust-lint.log` |
| First cleanup Rust test run | Core 981 PASS / 1 FAIL / 1 ignored; obsolete v22 font assertion failed | `sole-electron-rust-tests.log` |
| Font inventory/cache/fallback and legacy-data-version focused checks | 1 PASS each after adapting the obsolete assertion | `sole-electron-font-tests.log`, `sole-electron-legacy-font-tests.log` |
| Window gesture / onboarding / native shortcut source checks | 21 PASS | `sole-electron-window-gesture-tests.log` |
| E2E coverage and profile alias checks | 25 PASS; immutable 41-journey source baseline retained for both platforms | `sole-electron-coverage-size-tests.log` (the separate size-constant assertion failed and was subsequently updated) |
| First complete cleanup JavaScript run | 3605 PASS / 90 FAIL / 61 skipped; includes retired source references and symlink EPERM | `sole-electron-full-js-first.log` |
| GitHub release redirect policy | 4 PASS; actual Rust transport fetched the 1,237-byte v8.4.2 manifest successfully without installing | `sole-electron-github-redirect-tests.log`, `sole-electron-endpoint-rust-live.log` |
| Updated Rust lint including redirect transport | PASS | `sole-electron-rust-lint-current.log` |
| Updated full Windows ARM64 Rust suite | 1106 PASS / 4 ignored / 0 FAIL | `sole-electron-rust-tests-current.log` |
| Cleanup contracts, first focused batch | 76 PASS / 13 FAIL; stale paths and 10-second timeouts retained | `sole-electron-cleanup-contracts-current.log` |
| Updated workflow contracts | 31 PASS / 6 FAIL; remaining source assertions and Bash/gate timeouts retained | `sole-electron-workflow-contracts-updated.log` |
| TypeScript after the first contract cleanup | PASS | `sole-electron-typecheck-cleanup-contracts.log` |
| Hygiene after the first contract cleanup | Source hygiene, docs and AI context PASS; Knip failed on the retired renderer entry and unused sortable dependencies, subsequently corrected | `sole-electron-hygiene-current.log` |

Artifacts above are under `.desktop-e2e-artifacts/`. The first full JS result
remains a failure. Focused results and removal of obsolete-runtime tests do not
replace a new complete run. The updated Windows native Rust suite includes the new
transport change. Full build, isolation, affected Chromium profiles and packaged
verification remain required for the resulting source.

The configuration comparison discovered the existing GitHub endpoint's two-hop
redirect chain. A bounded Rust transport adaptation is part of the cleanup;
see the updated configuration delta. No credentials or remote settings changed,
and no publication or real production updater transaction was performed.

The full Rust result includes the unchanged 256-round concurrent terminal-receipt
test in `crates/rion-updater/src/persistence.rs`. The local host is Windows ARM64;
this does not replace the Windows x64 Electron build/package or macOS evidence.

The completed diagnostic JavaScript command was `pnpm run test --maxWorkers=1`, with
the original 10-second deadline and every collected test retained. Its log is
`sole-electron-full-js-serial.log`: **3638 PASS / 32 FAIL / 48 skipped**, exit 1,
1219.30 seconds. The 32 failures comprise 11 symlink EPERM, 14 original
10,000 ms deadline failures and 7 other assertions. Exact failure names and
errors are in `sole-electron-full-js-serial-failures.json`. The command began
from HEAD `446974bd41bc6d6bd8f999f092f10f9ff5806ac8` and ended after the document
commit `fc530bcfe5079f2184bcc7a38d75085ea25f919e`; source fixes continued in the
dirty worktree, so this is intermediate
diagnosis, not an immutable candidate receipt. Observed failures include symlink
EPERM, signer/Bash startup overhead, stale contract references and renderer
timeouts. Standalone architecture validation took 2,491 ms; twelve independent
Bash syntax inputs took 5,604 ms. These measurements do not change a failed test
verdict or authorize a larger deadline.

The cleanup removes the unused sortable dependencies, corrects the Knip renderer
entry, and preserves every literal Bash program as syntax-only input with bounded
parallel parser processes. The pinned updater signer is invoked directly in its
integration test instead of through a pnpm shell. The release preflight now checks
strict semantic versions and rejects updater endpoint credentials, query and
fragment before packaging. These latest fixes still require their focused checks
and final complete source-specific validation.

## Sole-entry implementation candidate — 2026-09-09

Program and test commit: `76042b4a988dcf32bf989971b4a08cc1c7f3f7ea`.
Documentation/context changes are committed separately. This implementation
candidate retires the Tauri shell and routes existing build/package/release
commands to Electron. It is not yet a fully validated runtime candidate.

Latest local checks before the program commit:

| Check | Result | Artifact under `.desktop-e2e-artifacts/` |
| --- | --- | --- |
| TypeScript | PASS | `sole-electron-typecheck-final-cleanup.log` |
| ESLint | 0 errors / 23 warnings | `sole-electron-lint-final-cleanup.log` |
| Source/docs/context/unused/Cargo/E2E hygiene | PASS; retained unused-export/type warnings are not errors | `sole-electron-hygiene-entry-fixed.log` |
| E2E manifest | P0 48/48, P1 58/58, P2 4/4; retained compatibility 41/41 on each platform | Same hygiene log; manifest coverage is not execution evidence |
| Entry, package, release and contract checks | 86 PASS / 1 FAIL; the last obsolete Tauri version-list assertion was then corrected | `sole-electron-final-entry-contracts.log` |
| Complete adjacent candidate test file after that correction | 13 PASS | `sole-electron-candidate-version-fixed.log` |

The generated offline start page was regenerated with the repository generator
after the canonical design-token update. No generated source was hand-edited.
Package preparation now requires the distribution's matching Node/Rust target:
macOS arm64 or Windows x64. This Windows ARM64 workstation uses the existing
portable x64 Node 24.20.0 and x64 Rust 1.98.1 for Electron native/package checks;
the system installation remains Node 24.20.0 ARM64. This prevents a build for one
architecture from packaging a leftover addon for another architecture.

Next: validate this committed source with Windows x64 build and production
isolation, the complete affected Chromium profile and package checks; classify
remaining complete-JS failures and obtain any needed exact-source CI evidence.
The owner-retired physical/production/terminal-promotion backlog stays removed.

## Native candidate evidence and retired launcher cleanup — 2026-09-09

Exact clean Windows x64 source: `9c19a4008188a448da83e58f7fba654337200032`
(program ancestor `76042b4a988dcf32bf989971b4a08cc1c7f3f7ea`). Node 24.20.0 x64,
Rust 1.98.1 x64, Electron 43.6.0 / Chromium 150.0.7871.250. The system Node
installation is 24.20.0 ARM64; distribution/native Electron checks use the
existing portable x64 runtime without changing that installation.

| Command / evidence | Actual result |
| --- | --- |
| `pnpm run build` | PASS; production Electron renderer and native addon built |
| `pnpm run check:desktop-e2e-isolation` | PASS |
| `pnpm run test:electron:native-integration` | 16 PASS / 0 skipped, 8 files |
| `pnpm run test:e2e:desktop:full` | FAIL: 10 phases PASS then `chromium-workspace-web-fullscreen-seed` FAIL; 11 journeys PASS / 4 FAIL / 39 NOT_RUN |

Build, isolation and native-integration logs plus command/SHA receipts are under
`.desktop-e2e-artifacts/windows-takeover-4e5ec764/sole-entry-9c19-` with suffixes
`build-x64`, `isolation` and `native-integration`. The full profile log uses
`chromium-full`; its report is
`.desktop-e2e-artifacts/2026-09-08T21-38-16-609Z-win32/report.json`.
The manifest declares 62 phases; this failed run did not complete the profile.
The observed failure is `exact Windows file dialog is not foreground for input`
after matching the exact native dialog. The progress receipt stops at
`focusing-dialog`; the original helper omitted its HWND snapshot on this error.
This is an observed failure, not an expected forced termination. The report
retains final-flush and process-exit receipts for the failed phase too.

[CI 34281548249](https://github.com/rion-tw/rion-studio-source/actions/runs/34281548249)
was dispatched once for exact source `9c19a4008188a448da83e58f7fba654337200032`.
Observed completed jobs: shared checks (job 102247242966), renderer build,
Linux sanitizer/concurrency, and macOS native validation (job 102247422680).
The shared complete JS run is **3706 PASS / 29 platform skips**, 448 passing
files / 9 skipped files. macOS native Rust is **1116 PASS / 5 ignored**, and
Electron integration is **14 PASS / 2 platform skips**. Windows native and both
package jobs were still running at this checkpoint. Linux shared JS success
does not rewrite the earlier local Windows JS failure or prove Windows native
reachability. No unchanged CI rerun was dispatched.

Follow-up program commit: `eb92d4c0420fc312edbe166631135b683b63b840`. It removes
the unused Tauri development bundle and WKWebView experiment launcher, including
the misleading `performance:webkit:experiment` command which would now start
Electron. The sole-entry guard rejects their return. It also retains exact
native-dialog failure snapshots during focus/input/submission without changing
the original error, input assertions or deadline. This diagnostic addition is
not a claim that the foreground failure is fixed.

The adjacent entry/documentation/fullscreen-source tests passed **17/17**;
`verify:system-only`, full hygiene, TypeScript and ESLint passed (ESLint retains
23 warnings, 0 errors). Artifacts use `sole-electron-retired-launcher-` prefixes.
E2E omission for launcher removal is `compile-only`; dialog diagnostics are
`internal-only` and still require the affected Windows profile investigation.
The removed WebKit-only runbooks are archived byte-for-byte with full source SHA
and SHA-256 in the archive manifest. CONTRIBUTING now describes the sole Electron
commands, current native validation and existing release inputs.

## Final runner cleanup and exact Windows failures — 2026-09-09

Program commits after the previous checkpoint:

- `cdc56e004c2a1bd87eb806ebc6ed26b0c42b3df1` adds per-monitor-aware native-dialog pointer readback, exact control
  hit validation, acknowledged two-event SendInput submission and LastClick
  diagnostics. Full SHA is retained in Git and the following exact-source report.
- `e91316e88a2f0414c942ea6744e6d23938f5de4a` awaits the async pinned-signer helper
  before reading `.sig`, and observes only a NULL native foreground transition
  within the original shared 10-second chooser budget. A different foreground
  HWND fails immediately; no click is replayed and no deadline is extended.
- `18cfe8154809fdd1474175f5b7f6a3adf9920f13` removes unreachable Tauri E2E
  validators, 14 retired prerequisite mappings and 23 retired namespace mappings.
  Non-Electron build/shutdown drivers now fail closed. The obsolete
  `clean-shutdown.json` disconnect-success path is removed; current Electron
  final-flush/process-exit and four expected-force classifications remain.

The native-dialog diagnostic runs all failed and are not complete-profile PASS:

| Exact tested source | Artifact run | Result |
| --- | --- | --- |
| `329521d3692ee6157dee04e6dcadeeba355b4b9b` | `2026-09-08T21-54-02-720Z-win32` | Same foreground failure; HWND 42796306 / dialog PID 14584, owner HWND 7014482 / Rion PID 7904, foreground 0 |
| `d6f4a9461c5d9ce3df3b5ad5b3338f8c579981e4` (full SHA in command/report receipt) | `2026-09-08T21-57-48-567Z-win32` | Pointer readback matched (1683,1589), hit control 9307954 and foreground dialog 12453736 before submission; subsequent foreground 0 |
| `e91316e88a2f0414c942ea6744e6d23938f5de4a` | `2026-09-08T22-00-46-026Z-win32` | Foreground did not recover within the unchanged chooser budget; FAIL retained |

The command was `pnpm run test:e2e:desktop:full
--phase=chromium-workspace-web-fullscreen-seed`, including its entity-persistence
seed/restart prerequisites. Each full SHA and clean-worktree status is bound by
its runner report and wrapper result. The additional observations rule out a
mismatched pointer coordinate/control in the recorded attempt; they do not
establish the cause of the workstation foreground loss. No further unchanged
local retry is justified. Win32 permits a NULL foreground during activation
changes, but the failed budget is still a failure, not an accepted transition.

CI 34281548249 Windows native job 102247422605 finished with Rust
**1106 PASS / 4 ignored**, native integration **16 PASS**, and complete JS
**3682 PASS / 1 FAIL / 48 platform skips**. The exact sole JS failure was a
missing `artifact.bin.sig` in the pinned-signer test: the newly async helper's
sign call lacked `await`. The fix above preserves signature verification. The
complete adjacent signer/fullscreen-source files then passed **20/20** locally.
This focused result does not replace the failed complete Windows JS run.

Both native Chromium full E2E steps in CI 34281548249 completed successfully;
package construction was still running. Final phase/journey counts and package
receipts require their artifacts, so no package completion is claimed here.
The current helper changes are Windows-only E2E control changes; no macOS native
runtime or production renderer change was introduced after the 9c19 candidate.

The runner cleanup's 63 active phase prerequisite/namespace mappings were
compared before and after and are unchanged:
`.desktop-e2e-artifacts/sole-entry-runner-active-graph-equivalence.json`.
Six adjacent runner/driver/recovery test files passed **31/31**. Full hygiene and
ESLint passed (0 errors, 23 existing warnings). Logs use the
`sole-entry-final-runner-` prefix. The manifest and all its active journeys are
unchanged; retired phases remain in immutable compatibility history only.

## Current immutable verification source — 2026-09-09

Latest verified build source: `b6ea7ae8425eb1c0c43046660ca466e68233be04`
(program commit `18cfe8154809fdd1474175f5b7f6a3adf9920f13`). On the clean Windows
worktree, x64 Node 24.20.0 / Rust 1.98.1 ran `pnpm run build` successfully from
2026-09-08T22:09:01.1005165Z to 22:09:19.5677020Z, followed by successful
`pnpm run check:desktop-e2e-isolation` through 22:09:20.7264319Z. The output is
restored to the production build. Logs and exact command/SHA receipts:
`.desktop-e2e-artifacts/windows-takeover-4e5ec764/sole-entry-b6ea7ae8-build-x64`
and `sole-entry-b6ea7ae8-isolation` (`.log` / `.result.json`).

[Windows-scoped CI 34284338910](https://github.com/rion-tw/rion-studio-source/actions/runs/34284338910)
validates that exact source, including the awaited signer, native-dialog
observations and runner cleanup. The pre-dispatch exact-SHA lookup found no
existing run; one dispatch returned HTTP 204 at 2026-09-08T22:08:26.295Z. It does
not dispatch macOS validation. Current handles: checks 102256294174, Windows
native 102256438416, Windows package 102256294098; renderer build already passed.
Retain these live jobs instead of restarting when observation takes time.

The earlier 9c19 CI remains live for package receipts: Windows job 102247242665
has completed exact NSIS installed-payload verification and is executing packaged
Rust-owned updater transactions; macOS job 102247242846 is building release
artifacts after its complete Chromium profile passed. No production publication,
real production transaction, credential change or removed hardware gate occurred.
The sole-entry task remains open until the relevant complete and packaged
results are inspected; the local foreground failure remains unresolved evidence.
