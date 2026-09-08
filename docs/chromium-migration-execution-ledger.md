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
| GitHub release redirect policy | 4 PASS; actual Rust transport probe pending | `sole-electron-github-redirect-tests.log` |

Artifacts above are under `.desktop-e2e-artifacts/`. The first full JS result
remains a failure. Focused results and removal of obsolete-runtime tests do not
replace a new complete run. Native Rust checks must be repeated for the new
transport change. Full build, isolation, affected Chromium profiles and packaged
verification remain required for the resulting source.

The configuration comparison discovered the existing GitHub endpoint's two-hop
redirect chain. A bounded Rust transport adaptation is part of the cleanup;
see the updated configuration delta. No credentials or remote settings changed,
and no publication or real production updater transaction was performed.
