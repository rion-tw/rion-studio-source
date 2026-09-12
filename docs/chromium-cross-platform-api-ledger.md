# Chromium Cross-Platform API Ledger

## Owner scope — 2026-09-09

The owner has retired the remaining API backlog as an execution gate and asks
only for the final v22 configuration delta and the sole Electron entry with
Tauri/System WebView cleanup. Follow the two scoped packages in the
[migration execution ledger](chromium-migration-execution-ledger.md).

The previous 11/18 closure count is historical, not the current task queue.
Removed requirements are neither pending nor verified PASS. The previously
requested physical dual-monitor, actual OS sleep/sign-out and four production
update transactions remain removed. Terminal promotion and the old native
acceptance backlog are also outside the revised scope.

The cleanup must preserve Rust ownership of data, topology, operation terminality
and Macro scheduling; Electron ownership of Chromium handles; the typed renderer
bridge; macOS AppKit hosting and trusted input; and consumed v22 data/import
compatibility. Validate changes introduced by cleanup without restoring the
retired backlog as prerequisites.

## Current work

The v32 CDP/physical-input regression, all active P0/P1 classifications, and
current baseline workflow receipts are maintained only in the
[Electron Chromium regression audit](electron-chromium-regression-audit.md).
This historical ledger does not duplicate those per-journey verdicts.

| Item | State | Evidence |
| --- | --- | --- |
| Final v22 configuration delta | Comparison complete; no new remote configuration needed | [Observed settings and required repository changes](v22-configuration-delta.md) |
| Electron sole entry / old runtime cleanup | Complete, including final verification | Migration ledger binds the complete Windows CI at 40e21d19 and the retained macOS native/profile/package evidence at c52decf9; exact SHAs and package identities are recorded there |

Both owner-scoped work packages / all three deliverables are complete. No item
from the retired API backlog remains queued. Historical failures retain their
observed verdicts; completion does not assert that unreproduced failures were
causally fixed or that removed physical/production requirements passed.

## Historical evidence

Full earlier API analysis, exact failure records and native/CI/profile/package
receipts remain available at [ledger revision a366dc475b67380cfce7bb5640d00d490e243939](https://github.com/rion-tw/rion-studio-source/blob/a366dc475b67380cfce7bb5640d00d490e243939/docs/chromium-cross-platform-api-ledger.md).
Existing local artifacts are preserved. The previous local full JS and stable
failures remain failures; no scope decision rewrites an observed test verdict.
