# macOS Cross-domain Desktop E2E Validation Report

- Status: PASS
- Exact tested SHA: `564319d336240fe62a36f9296f98d606e0a7481e`
- Final pushed SHA: the report-only commit containing this file; resolve exactly with `git log -1 --format=%H -- .agents/macos-cross-domain-e2e-validation-report.md` after the final push
- Branch / origin/main: `main`; direct push to `origin/main`
- Starting and final worktree: started clean at `338c7b28d7e254a42cd5713203a48b555da50993`; exact-test worktree clean; final worktree required clean after the report-only commit and push
- Windows handoff checkpoint: `b04dca362e3d8dbd0ec77bcf6ded84f0c25ade32` is an ancestor of the exact tested SHA. Windows physical validation remains bound only to that handoff SHA; the macOS product/runtime changes in this report still require Windows CI.
- macOS version / architecture: macOS 26.5 (25F71), arm64, Apple M3 Max
- WKWebView / Safari version: WKWebView 605.1.15 / Safari 26.5
- Node / pnpm / Rust: Node 24.15.0 / pnpm 11.13.0 / rustc 1.97.0 (`1.97.0-aarch64-apple-darwin`)
- Physical displays / resolutions / scale factors / coordinates: two physical Apple Studio Displays, serials `MYC57FN4T5` and `JLQ32RRK7V`, each 5120×2880 Retina at scale factor 2.0. The primary logical work area was `(x=0, y=30, width=2560, height=1410)`. Both displays have the same scale, so the mixed-scale coordinate round trip was not admissible.
- Started / finished at: 2026-08-15T08:35:16+08:00 / 2026-08-15T12:47:12+08:00

The overall macOS verdict is PASS because every required static, Rust, build, isolation, focused, smoke, and full gate passed on the exact tested SHA. The extended profile is separately and correctly BLOCKED by the allowed physical-hardware condition.

## Required gates

| Gate | Exit | Counts / exact evidence |
| --- | ---: | --- |
| `corepack enable` | 0 | Corepack enabled for the required pnpm invocation. |
| `pnpm install --frozen-lockfile` | 0 | pnpm 11.13.0; lockfile unchanged; dependencies already up to date. |
| `pnpm run check:e2e-coverage` | 0 | P0 13/13 = 100%; P1 16/16 = 100%; P2 0/2. |
| `pnpm run check:source-hygiene` | 0 | 1183 tracked files checked. |
| `pnpm run typecheck` | 0 | TypeScript typecheck PASS. |
| `pnpm run lint` | 0 | 0 errors; 23 existing React Fast Refresh warnings. |
| `pnpm run test` | 0 | Vitest 165 files, 939 tests, 0 failures. |
| `pnpm run lint:rust` | 0 | `cargo fmt --check` and workspace/all-target Clippy with `-D warnings` PASS. |
| `pnpm run test:rust` | 0 | `rion-core` 599, `rion-platform` 20, `rion-tauri` 457; total 1076, 0 failures. |
| `cargo check -p rion-tauri --all-targets` | 0 | PASS on native macOS host. |
| `cargo build -p rion-tauri --all-targets` | 0 | PASS on native macOS host. |
| `cargo check --workspace --all-targets --features desktop-e2e` | 0 | PASS. |
| `cargo clippy --workspace --all-targets --features desktop-e2e --no-deps -- -D warnings` | 0 | PASS, no warnings admitted. |
| Required focused Rust regressions | 0 | `identical_placement_observations_advance_the_fence_without_a_topology_commit` and `retiring_the_exact_host_generation` each PASS, 1/1. |
| Added focused Rust regressions | 0 | Five additional 1/1 passes: shared-role placeholder recovery; recoverable retired-surface readback; page-commit close admission; macOS fullscreen transition owner; projection-lock release before window actor cleanup. |
| `pnpm run build` | 0 | Production renderer built (2908 modules) and Rust/Tauri build PASS. Repeated after all desktop E2E. |
| `pnpm run check:desktop-e2e-isolation` | 0 | PASS after the final production build. |
| `git diff --check` | 0 | PASS after the final build/isolation run. |

The exact additional focused Rust test names were:

- `crash_recovery_restores_shared_role_placeholders_without_duplicate_tab_sources`
- `only_retired_recovery_surfaces_with_a_recoverable_baseline_can_skip_failed_readback`
- `close_admission_reads_local_storage_only_after_an_authoritative_page_commit`
- `desktop_e2e_fullscreen_edges_use_the_macos_transition_owner_only`
- `surface_unbind_releases_projection_before_entering_the_window_actor`

## Focused cross-domain chain

- Artifact root: `.desktop-e2e-artifacts/2026-08-15T04-30-28-388Z-darwin`
- `report.json`: commit `564319d336240fe62a36f9296f98d606e0a7481e`, `worktreeDirty=false`, 4 phases, 4/4 journeys PASS.

| Phase | Status | Journey verdict | Native / event / SQLite evidence |
| --- | --- | --- | --- |
| `p1-cross-domain-seed` | PASS | `RUNTIME-LAUNCH-DESTINATIONS-008` PASS | `phases/p1-cross-domain-seed/journey-verdict.json`, `runner.log`, `wdio/`, `sqlite-query.json`; authoritative launch and readiness events in `user-data/cross-domain-lifecycle/desktop-e2e/events.ndjson`. |
| `p1-cross-domain-topology-force` | EXPECTED_FORCE_TERMINATION | `RUNTIME-TAB-TOPOLOGY-009` PASS; `MACRO-OWNERSHIP-TRANSFER-010` PASS | Visible AppKit actions and exact generation/tab/revision receipts in `events.ndjson`; `forced-termination.json`; SQLite `cleanExit=false`. |
| `p1-cross-domain-recovery` | PASS | `RUNTIME-MIXED-RECOVERY-011` PASS | Restore projection, role/session, placeholder retry, macro terminality, and cleanup evidence in `journey-verdict.json`, `events.ndjson`, and `sqlite-query.json`; `cleanExit=true`, empty recovery state after cleanup. |
| `p1-cross-domain-final-restart` | PASS | Cleanup lifecycle PASS | `sqlite-query.json`: custom game/window/macro/role/workspace counts all 0; restore session generation 4, `cleanExit=true`, no live or restore-in-progress windows. |

## Smoke profile

- Artifact root: `.desktop-e2e-artifacts/2026-08-15T04-32-00-264Z-darwin`
- `report.json` exact SHA / worktreeDirty: `564319d336240fe62a36f9296f98d606e0a7481e` / `false`
- Phase verdicts: `smoke-seed` PASS; `smoke-restart` PASS (2/2).

## Full profile

- Artifact root: `.desktop-e2e-artifacts/2026-08-15T04-32-25-226Z-darwin`
- `report.json` exact SHA / worktreeDirty: `564319d336240fe62a36f9296f98d606e0a7481e` / `false`
- Timing: 2026-08-15T04:32:25.260Z–2026-08-15T04:36:00.154Z
- Summary: 25 phases: 22 PASS and 3 EXPECTED_FORCE_TERMINATION; 12/12 journeys PASS.
- Artifact audit: 25 `runner.log`, 75 files below `wdio/`, 11 `events.ndjson`, 11 `journey-verdict.json`, 3 `forced-termination.json`, 25 `sqlite-query.json`, and 78 SQLite database/sidecar copies. Successful phases emitted no screenshot files; therefore no screenshot was used as a verdict source.

| Phase | Status | Journey verdict | Evidence summary |
| --- | --- | --- | --- |
| `smoke-seed` | PASS | — | App/entity seed and native snapshot evidence. |
| `smoke-restart` | PASS | — | Persisted restart projection and SQLite evidence. |
| `p0-macro-native-effect` | PASS | `MACRO-NATIVE-EFFECT-003` PASS | Native fixture input and terminal macro evidence. |
| `p0-macro-background-tab` | PASS | `MACRO-BACKGROUND-TAB-004` PASS | Background-tab input and terminal projection evidence. |
| `p0-macro-terminal-cleanup` | PASS | `MACRO-TERMINAL-CLEANUP-006` PASS | Macro status, input fence, tab/window cleanup terminals. |
| `p0-tabs-visible-activation` | PASS | `TABS-VISIBLE-ACTIVATION-003` PASS | Visible native tab activation receipt. |
| `p1-macro-multirole` | PASS | `MACRO-MULTIROLE-005` PASS | Multi-role input and terminality evidence. |
| `p1-role-session-seed` | PASS | — | Isolated WKWebView role stores seeded. |
| `p1-role-session-isolation` | PASS | `ROLE-SESSION-ISOLATION-003` PASS | Per-role Cookie/LocalStorage markers, clear-session operation, and isolated relaunch evidence. |
| `p1-workspace-shared-role` | PASS | `WORKSPACE-SHARED-ROLE-003` PASS | Single live owner and shared-role transfer evidence. |
| `p1-mutations` | PASS | — | Visible entity mutations and SQLite projection. |
| `p1-workspace-recovery` | PASS | — | Workspace restore and role ownership projection. |
| `p1-guard-cleanup` | PASS | — | Cleanup fences and tombstones terminalized. |
| `p1-final-restart` | PASS | — | Clean final restart. |
| `system-settings` | PASS | — | Settings persistence and restart evidence. |
| `p1-cross-domain-seed` | PASS | `RUNTIME-LAUNCH-DESTINATIONS-008` PASS | Four isolated roles, two workspaces, two macros, two permanent windows. |
| `p1-cross-domain-topology-force` | EXPECTED_FORCE_TERMINATION | `RUNTIME-TAB-TOPOLOGY-009` PASS; `MACRO-OWNERSHIP-TRANSFER-010` PASS | `forced-termination.json`: PID 38669, session `e94b73e29a271b40`; PID later audited dead; SQLite custom counts 1 game/2 windows/2 macros/4 roles/2 workspaces, generation 2, `cleanExit=false`. |
| `p1-cross-domain-recovery` | PASS | `RUNTIME-MIXED-RECOVERY-011` PASS | Recovery and cleanup PASS; generation 3, `cleanExit=true`, empty custom entity counts and no live windows. |
| `p1-cross-domain-final-restart` | PASS | — | Generation 4, `cleanExit=true`, empty custom entity counts and no live windows. |
| `seed` | PASS | — | Game Window lifecycle seed and native placement snapshots. |
| `restart` | PASS | — | Normal/maximized/fullscreen restore projection. |
| `force-terminate` | EXPECTED_FORCE_TERMINATION | — | PID 39297, session `e94b73e29a271b40`, later audited dead; generation 3 and `cleanExit=false`. |
| `crash-restart` | EXPECTED_FORCE_TERMINATION | — | PID 39402, session `e94b73e29a271b40`, later audited dead; generation 4 and `cleanExit=false`. |
| `crash-discard` | PASS | `WINDOW-RECOVERY-UI-007` PASS | Visible recovery discard and clean shutdown evidence. |
| `recovery-final-restart` | PASS | — | Generation 6, `cleanExit=true`, `liveWindowIds=[]`; phase clean-shutdown and SQLite evidence. |

`kill -0` was explicitly audited after the suite for PIDs 38669, 39297, and 39402; all three returned dead. No WebDriver disconnect, sleep, timeout, or elapsed-time inference was used as success.

## Extended mixed-scale profile

- Status: BLOCKED
- Artifact root: `.desktop-e2e-artifacts/2026-08-15T04-36-08-313Z-darwin`
- `report.json`: exact tested SHA, `worktreeDirty=false`; the first 25 phases repeated with 22 PASS and 3 EXPECTED_FORCE_TERMINATION, then `extended-native` BLOCKED.
- Exact hardware blocker, if any: **BLOCKED: requires two physical mixed-scale displays**
- Cross-display / contentLayoutRect / fullscreen Space / toolbar safe-area evidence: the machine has two real Studio Displays, but both report scale factor 2.0. The extended test rejected the hardware before claiming a cross-display round trip, so negative/different-coordinate, mixed-scale `contentLayoutRect`, Dock inset, fullscreen Space, and toolbar safe-area round trips are not marked PASS. The raw runner diagnostic is in `phases/extended-native/runner.log`.

## Native acceptance checklist

| Check | Status | Evidence path / event / snapshot |
| --- | --- | --- |
| AppKit visible tab click | PASS | Full `cross-domain-lifecycle/desktop-e2e/events.ndjson`: `runtime-ui-action-submitted` `activateTab` with exact window generation/revision; matching activation/projection terminals. |
| Visible native tab menu | PASS | Same event stream: five `openTabMenu`, five `runtime-tab-menu-opened`, and five `selectTabMenuItem` submissions, followed by exact tab-mutation commits. |
| Same-window reorder | PASS | `dragTab` at topology revision 35 and `tabDragCommitted` for the exact tab/window generation. |
| Cross-window drag / move | PASS | `tab-mutation-move-live` commits at revisions 51 and 59, with window snapshots showing exact owner/order projections. |
| Move last tab / detach to new window | PASS | `tab-mutation-move-to-new-window-live` revision 54 plus `provisionalWindowPrepared`, `provisionalWindowPositioned`, and new generation snapshot evidence. |
| Hide/show | PASS | `tab-mutation-hide-live` revisions 61 and 64; persisted hidden/active/order state in topology-force SQLite; recovery activation/projection terminal evidence. |
| Exact generation, tab identity, target revision fencing | PASS | Native UI submissions carry `windowGeneration`, `tabId`, and `topologyRevision`; focused lower-layer regressions cover retired/wrong generations and visibility/projection supersession. Unknown native results are not converted to success. |
| WKWebView Cookie and LocalStorage isolation | PASS | `phases/p1-role-session-isolation/journey-verdict.json`, its WebDriver log, role-session `events.ndjson`, and cross-domain recovery verdict. Role A/B markers stayed isolated and clearing one store did not clear the other. |
| Shared-role ownership transfer and failed takeover isolation | PASS | `MACRO-OWNERSHIP-TRANSFER-010` and `RUNTIME-MIXED-RECOVERY-011`; owner/placeholder/macro/input-fence terminals in cross-domain events. Exactly one live owner; unique roles were not polluted. |
| `NSWindow.contentLayoutRect` / logical client geometry | PASS on available scale | Native `window-snapshot-read` records agree on client bounds, normal bounds, work area `(0,30,2560,1410)`, and scale 2.0. Mixed-scale comparison is separately BLOCKED. |
| Maximize/windowed/fullscreen normal-bounds round trip | PASS | Window recovery `events.ndjson`: `placement-accepted` observations preserve normal bounds `(1590,710,900,650)` across normal → maximized → normal → fullscreen → normal; native snapshots include normal/maximized/fullscreen/minimized. |
| Native fullscreen Space / transition ownership | PASS on one scale | Full Game Window lifecycle event stream plus focused regression `desktop_e2e_fullscreen_edges_use_the_macos_transition_owner_only`; AppKit enter/exit terminal is revision-fenced. |
| Toolbar safe area and tab chrome auto show/hide | PASS on one scale | Game Window native snapshots/transition terminals and tab-chrome readiness/projection tests; exact host retirement regression prevents a late host from acknowledging the new operation. |
| Mixed-scale cross-display round trip | BLOCKED | `.desktop-e2e-artifacts/2026-08-15T04-36-08-313Z-darwin/phases/extended-native/runner.log`; both physical displays are scale 2.0. |

## Failures, classification, regressions, fixes, and reruns

All original product-failure artifacts were preserved. No failed product run was accepted by retrying it unchanged. Each issue was reduced to the authoritative native/runtime owner, covered by a focused Rust, Vitest, source-contract, or E2E regression, fixed minimally, and rerun through the affected chain. The resulting 28 commits between the starting SHA and exact tested SHA are:

1. `fb5c2c25` restored the macOS desktop-E2E Rust build.
2. `daf0b059` made renderer tab-chrome readiness Windows-only where AppKit owns the receipt.
3. `0d5349f7`, `d7062eb9`, and `89d61b21` foregrounded native drag targets, recorded drag terminal evidence, and activated dormant AppKit tabs after drag.
4. `76aec20a` and `87ac788e` delivered and pre-armed native menu selection during AppKit modal tracking.
5. `e63e0b13`, `9b0bcc74`, `57f9ceac`, `f200e212`, and `f812204d` replaced launch, last-tab persistence, minimize, deminiaturize, and hidden-tab timing assumptions with authoritative event/revision fences.
6. `d93c387a`, `dcfe1318`, `0641018c`, `c1b90081`, `4a2cdcfd`, and `67aab56c` repaired shared-role recovery, retired/unresponsive surfaces, pre-commit recovery, gated relaunch identity, and uncommitted launch cancellation.
7. `41f4997d`, `8a536c84`, `e09b9e13`, `c9afc841`, and `0f42777a` made visible/hidden restoration projection evidence exact and visibility-aware.
8. `46fd57a3` and `c09525eb` decoupled placeholder refresh from tab close and retired claimed placeholders.
9. `8f3ed281` and `3278289d` fenced AppKit fullscreen placement terminals and routed E2E fullscreen edges through the native transition owner.
10. `564319d3` removed a lock inversion by releasing `NativeTabProjectionState` before entering `NativeWindowActorState`; the focused cleanup phase and the final focused/smoke/full/extended sequence then completed.

Representative preserved red artifacts, in chronological root-cause order, are:

- `.desktop-e2e-artifacts/2026-08-15T00-35-24-766Z-darwin` — macOS build/tab-chrome readiness.
- `00-41-09-009Z`, `00-49-00-766Z`, `00-55-09-913Z` — obscured drag target, absent drag terminal, dormant tab activation.
- `01-01-18-740Z`, `01-07-02-515Z` — AppKit menu modal tracking.
- `01-14-20-864Z` through `01-42-03-812Z` — seed shutdown, last-tab persistence, minimize/focus, hidden show/persistence, and shared recovery.
- `01-44-36-626Z` through `02-15-50-270Z` — blank/unresponsive recovery, baseline/page-commit recovery, old window identity, and close admission.
- `02-41-30-488Z` through `03-06-04-989Z` — topology/projection evidence and cleanup.
- `03-27-11-509Z` — duplicate placeholder label.
- `03-36-51-693Z` and `03-53-01-878Z` — dropped AppKit fullscreen-exit terminals.
- `04-16-33-865Z` and `.desktop-e2e-artifacts/2026-08-15T04-24-33-471Z-darwin` — reproducible macro-close deadlock. A macOS `sample` showed the projection-lock/window-actor lock inversion fixed by `564319d3`.

Final affected-phase proof is `.desktop-e2e-artifacts/2026-08-15T04-29-07-867Z-darwin`; final exact-SHA focused, smoke, full, and extended roots are the four roots reported above. Earlier green roots on older code were not used for the final verdict.

Affected user journeys are `RUNTIME-LAUNCH-DESTINATIONS-008`, `RUNTIME-TAB-TOPOLOGY-009`, `MACRO-OWNERSHIP-TRANSFER-010`, and `RUNTIME-MIXED-RECOVERY-011`. They already existed in `docs/e2e-coverage.json`, and their routes/coverage classification did not change, so the manifest required no edit. Adjacent desktop E2E and focused lower-layer regressions were updated.

## Production isolation after E2E

After the debug E2E renderer had run, `pnpm run build`, `pnpm run check:desktop-e2e-isolation`, and `git diff --check` were run again and all returned 0. Debug APIs, ACL, fixtures, and evidence hooks did not enter the production bundle. Owner-locked macOS ad-hoc signing, Windows unsigned distribution, updater signing, `.sig`, and SHA-256 policy were not changed.

## Remaining blockers

- Extended hardware only: **BLOCKED: requires two physical mixed-scale displays**.
- Windows validation for product/runtime changes after `b04dca362e3d8dbd0ec77bcf6ded84f0c25ade32` remains pending Windows CI. Windows desktop E2E was not run on this macOS host. The prior Windows smoke/focused/full PASS and extended mixed-scale BLOCKED conclusions remain bound to the handoff SHA, not the new exact tested SHA.
- macOS desktop E2E profiles run here: focused cross-domain, smoke, full, extended. Windows desktop E2E profile status for the new code: pending CI.

## Final verdict and pushed commit

PASS for the required macOS acceptance surface at exact tested SHA `564319d336240fe62a36f9296f98d606e0a7481e`. Focused cross-domain, smoke, and full are green with exact-SHA/clean-worktree evidence; full has 12/12 journeys PASS. Extended is correctly BLOCKED because the two physical displays are not mixed-scale. The final pushed commit is intentionally a report-only successor to the exact tested SHA; its exact hash is the commit containing this report and is also recorded in the completion handoff after `origin/main` is updated.
