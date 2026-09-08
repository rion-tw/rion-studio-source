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
