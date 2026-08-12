# Windows P1 Desktop E2E Validation Report

- Status: pending
- Final exact SHA: PENDING WINDOWS `git rev-parse HEAD`
- Latest validated code SHA: `09d7272eb236a3d37c1ffbbf39da2364dacf4955`
- Branch / tracking SHA / remote SHA: `main` / PENDING / PENDING
- Windows build / architecture: PENDING
- WebView2 Runtime: PENDING
- Node / pnpm / Rust: PENDING
- Monitor topology / scale: PENDING
- Started / finished at: PENDING

## Batch ledger

| Batch | Code SHA | macOS validation | Windows status |
| --- | --- | --- | --- |
| 1 — event-bound evidence harness | `63aa7f9028c4846c0bd5faeac2d21d2a48942ed7` | PASS — focused Vitest 7/7; affected UI retry 69/69; Rust 580+20+415; build/isolation; smoke 2/2. Artifact `.desktop-e2e-artifacts/2026-08-12T09-50-46-019Z-darwin`. Full Vitest initial parallel run: 872/880 with 8 pre-existing 5-second load timeouts. | PENDING |
| 2 — native/background/multi-role macros | `31c80462d3f4176a0a5c2111f9adde008c978905`; fix `adb590d89c858033dda5895b862bed61df600436`; adapter `09d7272eb236a3d37c1ffbbf39da2364dacf4955` | PASS — coverage P0 11/11、P1 9/9；Vitest 882/882；Rust 581+20+415；build/isolation；三個 phase 各 1/1。Artifacts：native `.desktop-e2e-artifacts/2026-08-12T10-20-17-791Z-darwin`、background `.desktop-e2e-artifacts/2026-08-12T10-19-56-688Z-darwin`、multi-role `.desktop-e2e-artifacts/2026-08-12T10-20-08-612Z-darwin`。 | PENDING |
| 3 — tab activation/macro teardown | PENDING | PENDING | PENDING |
| 4 — role isolation/shared ownership | PENDING | PENDING | PENDING |
| 5 — recovery/reporting/final gates | PENDING | PENDING | PENDING |

## Starting worktree

PENDING

## Required gates

| Gate | Exit | Counts / exact evidence |
| --- | ---: | --- |
| `pnpm install --frozen-lockfile` | PENDING | |
| `pnpm run check:e2e-coverage` | PENDING | |
| `pnpm run check:source-hygiene` | PENDING | |
| `pnpm run typecheck` | PENDING | |
| `pnpm run lint` | PENDING | |
| `pnpm run test` | PENDING | |
| `pnpm run lint:rust` | PENDING | |
| `pnpm run test:rust` | PENDING | |
| `cargo check -p rion-tauri --all-targets` | PENDING | |
| `cargo build -p rion-tauri` | PENDING | |
| `pnpm run build` | PENDING | |
| `pnpm run check:desktop-e2e-isolation` | PENDING | |
| `git diff --check` | PENDING | |

## Full profile

- Artifact root: PENDING
- `report.json` failure: PENDING

| Phase | Status | SQLite / event / log evidence |
| --- | --- | --- |
| All manifest full phases | PENDING | |

## Core eight journeys

| Journey ID | Status | Windows evidence |
| --- | --- | --- |
| `MACRO-NATIVE-EFFECT-003` | PENDING | |
| `MACRO-BACKGROUND-TAB-004` | PENDING | |
| `MACRO-MULTIROLE-005` | PENDING | |
| `MACRO-TERMINAL-CLEANUP-006` | PENDING | |
| `TABS-VISIBLE-ACTIVATION-003` | PENDING | |
| `ROLE-SESSION-ISOLATION-003` | PENDING | |
| `WORKSPACE-SHARED-ROLE-003` | PENDING | |
| `WINDOW-RECOVERY-UI-007` | PENDING | |

## Existing P1 journeys

| Journey ID | Status | Windows evidence |
| --- | --- | --- |
| All existing automated P1 journeys | PENDING | |

## Extended mixed-DPI profile

- Status: pending
- Artifact root or exact hardware blocker: PENDING

## Failures, infra classification, fixes and reruns

macOS batch 2 retained the following failed runs before the passing checkpoints:

| Artifact | First error | Classification / resolution |
| --- | --- | --- |
| `.desktop-e2e-artifacts/2026-08-12T09-59-47-587Z-darwin` | fixture inline script syntax error | Test fixture defect; added script compilation regression and fixed render assignment. |
| `.desktop-e2e-artifacts/2026-08-12T10-01-51-645Z-darwin` | launch waiter required an unrelated automation-ready projection | Harness assertion defect; session event plus running role state are the authoritative launch evidence. |
| `.desktop-e2e-artifacts/2026-08-12T10-03-18-111Z-darwin` | final `iteration=1` was not observable before status removal | Product defect; regression in `31c80462`, fixed by `adb590d8`, then native phase PASS. |
| `.desktop-e2e-artifacts/2026-08-12T10-12-05-186Z-darwin` | `desktop_e2e_runtime_ui_action not allowed` | Debug ACL/build manifest omission; fixed in `09d7272e`. |
| `.desktop-e2e-artifacts/2026-08-12T10-13-42-763Z-darwin` | camelCase `tabId` decoded as missing `tab_id` | Debug request serialization defect; added `rename_all_fields = camelCase`. |
| `.desktop-e2e-artifacts/2026-08-12T10-14-35-572Z-darwin` | renderer selection-only projection wait timed out | Evidence-path defect; Core activation had no terminal transcript yet. Added exact native callback terminal event. |
| `.desktop-e2e-artifacts/2026-08-12T10-18-19-475Z-darwin` | renderer selection-only projection still timed out after Core completed | Harness used a non-authoritative selection-only renderer event. Final test uses required terminal event + native snapshot + fixture evidence and passed. |

Windows has not rerun any item yet; all Windows verdicts remain PENDING.

## Remaining blockers

- Windows Win32/WebView2 native execution is pending real-machine validation.
- Mixed-DPI extended validation is pending compatible physical display hardware.

## Final verdict

PENDING
