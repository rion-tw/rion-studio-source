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
