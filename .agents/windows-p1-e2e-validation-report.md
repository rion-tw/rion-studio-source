# Windows P1 Desktop E2E Validation Report

- Status: pending
- Final exact SHA: PENDING WINDOWS `git rev-parse HEAD`
- Latest validated code SHA: `93a2dd54e2cb929e9d389473e305c7c5e7804ba1`
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
| 3 — tab activation/macro teardown | `17ab845838d9355eae72904ac389137017856c18`；fixes `9ff644ca68994e6579152da4006d53306db5e071`、`e9f46fa6968d5c982a6e88e0a34feed52306d776`、`cc526df64d824d0a698595047c993495c4d71c48`、`35a9af14d37bf89bff3817dddeb8a123db6cb007`；evidence/regressions `34162a75fde02bd95a8bb2b9a765d7554eaaabf4`、`703ae6d1082af978985e0b46702054ae716cfa14`、`ba23f5536c8aebd75c87b6ffeed1ec6e4123f763`、`bc2c391856327b36b1be111422be1fb6b5d35a64`、`b7b623b215f92cf570b8c697f768db2b896adb95`、`137b90af915abf6d7dae9e6a3718ada946edd5a6`、`2e11996aec3c8efb6ad3a35900d02c616b127aa2` | PASS — coverage P0 13/13、P1 9/9；Vitest 882/882；Rust 582+20+417；build/isolation；兩個 phase 各 1/1。Artifacts：tabs `.desktop-e2e-artifacts/2026-08-12T11-10-00-496Z-darwin`、cleanup `.desktop-e2e-artifacts/2026-08-12T11-09-04-043Z-darwin`。 | PENDING |
| 4 — role isolation/shared ownership | `93a2dd54e2cb929e9d389473e305c7c5e7804ba1` | PASS — coverage P0 13/13、P1 11/11；Vitest 882/882；fixture focused 5/5；hygiene/typecheck/lint/diff check exit 0；Session seed→restart→observe 與 shared-role phase 全部通過。Artifacts：session `.desktop-e2e-artifacts/2026-08-12T11-35-36-767Z-darwin`、shared `.desktop-e2e-artifacts/2026-08-12T11-35-22-004Z-darwin`。 | PENDING |
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

macOS batch 3 retained every failed run before the passing checkpoints:

| Artifact | First error | Classification / resolution |
| --- | --- | --- |
| `.desktop-e2e-artifacts/2026-08-12T10-34-29-459Z-darwin` | AppKit `accessibilityPerformPress` rejected the tab control | Debug adapter defect; dispatch now uses the real AppKit target/action pair. |
| `.desktop-e2e-artifacts/2026-08-12T10-35-42-002Z-darwin` | renderer-direct permanent-window delete was rejected | Test action violated the visible-UI requirement; journey now uses the actual Dashboard delete control. |
| `.desktop-e2e-artifacts/2026-08-12T10-36-37-839Z-darwin` | dormant activation raced native readiness | Evidence ordering defect; added exact essential-ready event wait. |
| `.desktop-e2e-artifacts/2026-08-12T10-38-23-205Z-darwin` | dormant absence wait observed pending launch topology | Harness expected the wrong lifecycle state; changed to authoritative dormant topology evidence. |
| `.desktop-e2e-artifacts/2026-08-12T10-39-57-175Z-darwin` | late restored C attachment overwrote the newer visible A selection | Product defect; fixed by `9ff644ca` and covered by a focused regression. |
| `.desktop-e2e-artifacts/2026-08-12T10-42-47-487Z-darwin` | activation terminal reported superseded although A was already authoritative | Product result-mapping defect; exact authoritative target now counts as success (`e9f46fa6`). |
| `.desktop-e2e-artifacts/2026-08-12T10-44-32-851Z-darwin` | wait expected dormant tab to disappear from runtime | Harness lifecycle assertion defect; dormant tabs remain in authoritative topology. |
| `.desktop-e2e-artifacts/2026-08-12T10-46-51-280Z-darwin` | corrected wait still used runtime absence as convergence | Same assertion defect; replaced by exact dormant phase and selected-tab evidence. |
| `.desktop-e2e-artifacts/2026-08-12T10-48-17-246Z-darwin` | automatic restore selected stale C after a visible A action | Product race; automatic restored activation is now fenced by the selected window revision (`cc526df6`). |
| `.desktop-e2e-artifacts/2026-08-12T10-54-02-715Z-darwin` | dormant permanent-window delete required a nonexistent live generation | Product lifecycle defect; dormant delete now commits state-only deletion (`35a9af14`). |
| `.desktop-e2e-artifacts/2026-08-12T11-01-07-792Z-darwin` | cleanup reused a window after closing its sole tab | Test isolation defect; the next case explicitly reopens from visible UI. |
| `.desktop-e2e-artifacts/2026-08-12T11-02-11-375Z-darwin` | test expected quiesced to remain true after native release | Assertion contradicted input-fence semantics; exact teardown event proves true, post-release proves false/no orphan fence. |
| `.desktop-e2e-artifacts/2026-08-12T11-04-58-793Z-darwin` | extra Show attempted while the restored window was already live | Harness lifecycle defect; retained the live cleanup window instead. |
| `.desktop-e2e-artifacts/2026-08-12T11-06-15-495Z-darwin` | window close had no post-admission role status to inspect | Evidence gap; debug transcript now records exact close admission with role input diagnostics (`137b90af`). |

macOS batch 4 retained every failed run before the passing checkpoints:

| Artifact | First error | Classification / resolution |
| --- | --- | --- |
| `.desktop-e2e-artifacts/2026-08-12T11-23-12-526Z-darwin` | Cookie marker was absent after application restart | Fixture defect; seed Cookie was session-scoped. Added `Max-Age=86400` and a focused fixture regression. |
| `.desktop-e2e-artifacts/2026-08-12T11-23-43-462Z-darwin` | clear completion raced the role-absence projection | Evidence-ordering defect; wait now requires the visible completion notice and enabled UI control after role removal. |
| `.desktop-e2e-artifacts/2026-08-12T11-25-56-307Z-darwin` | Roles Open selected a retained stopped tab but did not start its available slot | Harness lifecycle assumption; the journey now presses the actual visible role placeholder after selecting the stopped tab. |
| `.desktop-e2e-artifacts/2026-08-12T11-27-51-448Z-darwin` | seed phase accidentally called the stopped-tab reopen helper | Test edit defect; restored the initial visible role launch path. |
| `.desktop-e2e-artifacts/2026-08-12T11-28-22-973Z-darwin` | initial observe phase accidentally called the stopped-tab reopen helper | Test edit defect; restored the initial visible role launch path. |
| `.desktop-e2e-artifacts/2026-08-12T11-29-09-548Z-darwin` | shared workspace waiter consumed topology before all required slots existed | Harness predicate defect; added exact multi-slot event-bound matching. |
| `.desktop-e2e-artifacts/2026-08-12T11-30-05-151Z-darwin` | assertion expected both workspace tabs selected after automatic destination reused one window | Harness topology assumption; selection is now asserted from the authoritative per-window layout. |
| `.desktop-e2e-artifacts/2026-08-12T11-30-34-247Z-darwin` | cleanup waited for a renderer absence event not emitted by Core stop | Wrong lifecycle action/evidence path; cleanup moved from Core stop to actual visible tab controls. |
| `.desktop-e2e-artifacts/2026-08-12T11-32-15-445Z-darwin` | stopped workspace retained a compatibility live-presentation tab record | Harness incorrectly equated stop with close; cleanup now activates and closes the actual tab. |
| `.desktop-e2e-artifacts/2026-08-12T11-33-00-372Z-darwin` | repeated stop-based cleanup still observed the retained tab | Same lifecycle mismatch; replaced by exact tab-close terminal and native snapshot evidence. |
| `.desktop-e2e-artifacts/2026-08-12T11-34-46-752Z-darwin` | snapshot queried a window destroyed by closing its sole tab | Evidence branch defect; a last-tab close now requires exact `window-destroyed`, while multi-tab close requires a surviving snapshot without the target. |

Windows has not rerun any item yet; all Windows verdicts remain PENDING.

## Remaining blockers

- Windows Win32/WebView2 native execution is pending real-machine validation.
- Mixed-DPI extended validation is pending compatible physical display hardware.

## Final verdict

PENDING
