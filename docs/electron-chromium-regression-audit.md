# Electron Chromium Regression Audit

## 2026-10-02 Windows toolbar follow-up

This follow-up compares the Windows host at `299fb6c1` with `v8.4.2`
(`0b6e42f0`) and the retained macOS implementation. The tab-strip and shortcut
sources are unchanged between `v8.4.0` and `v8.4.2`. The older v32 report below
records its own baseline; its historical parity labels are not current Windows
desktop acceptance evidence.

| Feature | Finding and disposition |
| --- | --- |
| Tab `+` launcher | Missing from the Windows renderer. Restore the scoped native Roles/Workspaces menu, checked live owners and save-transient-window action using the existing Core launch/save lanes. The macOS launcher implementation is shared without changing its AppKit host fence. |
| Tab context menu | HTML menus were underneath child WebContentsViews. Use an Electron native popup parented to the exact game window. Reload, mute, hide, move, detach and Stop retain captured projection/generation/lifecycle fences. |
| Crowded tab row | Tabs could become unreachable with no overflow controls. Add visible left/right controls and wheel scrolling; keep `+` and window controls outside the scrolling row. Reveal a newly active tab and report updated native drag geometry. |
| Close-button preference | Windows ignored `alwaysHideTabCloseButton`. Apply it to every tab and retain native-menu Stop, middle-click close and keyboard context-menu access. |
| Language/theme | Windows chrome and menus did not follow acknowledged application appearance. Project the existing four locales and light/dark theme; unsubscribe with the exact native owner. |
| Toolbar document reload | The host discarded its load listener after initial readiness. Retain it and republish the complete current projection after an authenticated local-document reload. |
| Queued Role overlay refresh | Final Windows tab testing exposed two spurious `ELECTRON_ROLE_OVERLAY_NOT_READY` errors. Refresh requests were queued by Role ID and could outlive their admitted document. Capture that document before queueing and cancel on replacement/retirement, preserving the established superseded outcome instead of refreshing the next document. Event-driven unit tests cover both replacement-ready and retired states. |
| Retired toolbar presentation | Restart/consolidation exposed late drag-geometry reports from a closed host. Cancel authenticated presentation-only geometry/hover reports when that exact host retires, without relaxing generation/revision checks for tab actions. |
| Content zoom | Reproduced: `Ctrl+Shift+=` worked, while the v8.4 `Ctrl+=` chord produced no Core zoom receipt. Restore Equal and numpad native accelerator aliases through the same focused-window callback. Retain Core's window multiplier, per-surface base zoom, native readback and compensation. |
| Window resize, maximize, minimize, fullscreen | Restore the correct Restore glyph/label in fullscreen; the existing Core action already returns to normal. Retain native DIP geometry, authoritative Windows events and revision-fenced placement. Native journeys check resize and minimize/restore; desktop results remain distinct from mock-based geometry tests. |
| Tab order, hide/reveal, move, tearout, close/reopen | Retain Core ownership and saved dormant topology. Native menu selection now runs through UI Automation on the exact HWND, outside any Role document; DOM menu presence is no longer visibility evidence. |
| Workspace Role/Web slots, navigation, dividers | Retain current slot identities, managed Chromium surfaces and native resize indicators. No old System WebView or external-browser path is restored. |
| Role/session data, CRUD, recovery, import/export | Retain current Rust stores, SQLite and bounded consented legacy import. The broad Rust/Vitest regression suites cover these unchanged paths; this follow-up does not claim new live desktop acceptance for every data journey. |
| Macro/input, extensions, updater | Retain the later owner-authorized Canvas-compatible default, trusted CDP allowlist, extension policy, updater signatures and SHA-256 checks. No intentional retirement or distribution decision is reversed. |

Authoritative inputs remain Core topology/preferences and existing acknowledged
appearance events. Electron owns native menus and non-serializable handles;
the renderer publishes only typed requests and presentation geometry. Opening
a menu does not change content bounds or hide game surfaces. Selection re-enters
the same ordered controller; stale/retired targets fail without replay. Menu
close releases the fullscreen toolbar hold. No production polling or timeout
reconciliation is added.

The overlay coordinator likewise retains its single per-Role FIFO owner. Its
authoritative ready/lifecycle callbacks admit and invalidate the exact frame;
queued refreshes now keep that frame fence through submission. No retry or
replacement-document fallback is introduced. This shared correction is covered
by Windows native tab lifecycle and focused coordinator tests; macOS execution
remains pending.

Affected Windows journeys: `RUNTIME-LAUNCH-DESTINATIONS-008`,
`RUNTIME-TAB-TOPOLOGY-009`, `SETTINGS-PERSIST-006`, `RUNTIME-TAB-RELOAD-031`,
`RUNTIME-TAB-AUDIO-032`, `FULLSCREEN-TOOLBAR-012` and `APPLICATION-SHORTCUTS-030`
(all prefixed `CHROMIUM-WINDOWS-`). Adjacent E2E
checks use visible launcher/menu/scroll controls, native border resize and saved
preferences. Document reload is `lower-layer-covered`: the focused host-factory
test emits the actual `did-finish-load` callback and checks complete rehydration
without changing Core topology. macOS native execution remains pending on a
macOS host; shared launcher and menu unit tests preserve AppKit behavior.

Local validation logs and desktop evidence are kept under
`.desktop-e2e-artifacts/windows-v84-audit` and the dated Windows run directories.
An initial Windows Update dialog dimmed/occluded the desktop: foreground and
first-paint checks from that interval are failures, not product acceptance.
Observed validation on this Windows host:

- Native Rust formatting/Clippy passed; Rust tests passed (1,231 tests, four
  ignored). Typecheck, lint and repository hygiene passed. Lint retains 23
  existing React refresh warnings.
- Final production `pnpm run build` passed, including renderer/extension bundle
  verification. `check:desktop-e2e-isolation` passed against that production
  output; the workspace is left with a production build, not the E2E build.
  Documentation/context checks and coverage validation passed (P0 54/54,
  P1 76/76, P2 4/4; paired cutover journeys 41/41 on each platform).
- The full Vitest run after the overlay fix passed 4,909 tests in 533 files; 48 tests in nine
  files were skipped by their existing platform/configuration guards. The
  native Windows foreground test also passed after the update dialog closed.
  The final retired-host geometry guard then passed all 39 focused controller,
  renderer and native-menu binding tests.
- Native Windows tab seed passed in
  `2026-10-02T07-27-58-131Z-win32` (one Windows test passed, one macOS-only test
  skipped): scoped launch while another tab loads, first paint, tab activation,
  native context-menu hide/move/detach, close/reopen and resize/minimize/restore.
- Native Windows shell passed all three tests in
  `2026-10-02T07-37-26-634Z-win32`: tray restoration, owned-window actions and
  Core-authorized zoom/fullscreen, including Equal and all restored numpad aliases.
- Final native fullscreen seed/restart passed in
  `2026-10-02T08-49-32-346Z-win32`, including the visible Restore label/glyph.
  Native tab tearout and cross-window attachment passed in
  `2026-10-02T08-51-36-098Z-win32` (one Windows test passed, one macOS-only test
  skipped).
- Final native tab seed/restart passed in
  `2026-10-02T08-53-30-680Z-win32` (one Windows test passed per phase, one
  macOS-only test skipped per phase). This run includes real narrow-window
  overflow arrows and `+`, scoped launch during sibling loading, native menu
  actions, close/reopen and restored topology, with an empty shell-error journal
  after both phases. It validates the overlay-document and retired-geometry fixes.
- The `full` alias resolves to `chromium-windows-smoke` on Windows (as does
  `smoke`). Its run `2026-10-02T07-39-02-830Z-win32` passed 35 phases, including
  the complete gap/resize/first-paint matrix, workspace recovery, toolbar
  preferences/restart, native mute/reload/failure recovery, background Macro,
  standby recovery and input recovery. It stopped at
  `chromium-macro-cutover-keyboard`; later phases were not executed by this run.
  The consumer assertions proved one Alt release and correct subsequent output,
  but `chromium-macro-modifier-reconciliation.ts:53` still expects detailed
  `compatibleModifierEvidence` in successful operational logs. The existing
  `compactAppliedTrustedInputContext` deliberately removes that field (predates
  this task). Preserve that logging contract; report this unrelated stale test
  assertion separately instead of treating the aggregate as passing.

Native profile outcomes must be read from their report, never inferred from the
presence of an automated journey in the manifest. This machine uses 200% display
scaling; mixed-DPI/multiple-monitor hardware and macOS execution remain pending.
At the initial local handoff, remote Windows/macOS CI had not been run; local
Windows results do not substitute for those CI jobs. Later CI outcomes are
recorded in the release follow-up below.

The native accelerator aliases use Electron's documented
[Windows hidden-item behavior](https://www.electronjs.org/docs/latest/api/menu-item)
and [Equal/numpad key names](https://www.electronjs.org/docs/latest/tutorial/keyboard-shortcuts).
They add no duplicate visible menu entries or global shortcuts.

### Release validation follow-up

The release audit confirmed the same stale modifier-log assertion in both native
jobs of the preceding CI run `36972724882`. The E2E-only observer now preserves a
bounded copy of original terminal records containing physical reconciliation.
The journey reads those records, requires the exact Role and an applied Digit1
request absent from its precondition snapshot, and retains the physical-reconcile
AltLeft dispatch assertion alongside the unchanged consumer/order/neutrality
checks. Production logging and input behavior are unchanged; no release gate or
coverage target is removed. This is an `internal-only` test-observation repair.

The Windows `chromium-macro-cutover-keyboard` phase and its native-input
prerequisite passed in `2026-10-02T09-38-09-903Z-win32`. The related compatible
input, modifier reconciliation and terminal-journal suites passed all 98 tests.

CI `36991243487` passed both native Rust/integration jobs and all portable checks;
preflight `36991244300` built both signed-updater candidates and the manifest.
Its desktop E2E attempts stopped in the extensions seed: Windows waited after
Role teardown, while the macOS process sample showed a native error dialog.
The same Windows seed/restart passed locally in
`2026-10-02T09-55-59-923Z-win32`. An E2E-only uncaught-exception monitor now
persists the original error before Electron's dialog can block diagnostics;
it does not register an exception handler or change production failure behavior.
Its two focused tests, Windows extensions seed
`2026-10-02T10-07-06-338Z-win32`, and production isolation validation passed.

The next Windows CI attempt `36994080574` passed extension install/restart.
Its shell shortcut phase exposed an uncontrolled NumLock precondition: numeric
keypad reset was delivered with NumLock off. The E2E fixture now enables NumLock
through native input, reads back the OS state, retains it through the exact Core
receipt, and restores/readbacks the original state in cleanup. Starting locally
with NumLock off, all three shell tests passed in
`2026-10-02T10-31-24-586Z-win32`, and NumLock was restored to off.
The packaged Windows black-box close action also now uses the current English
accessible label `Close window`; the old `Close Game Window` label was stale
after toolbar localization. These are `internal-only` harness fixes. The native
close fixture and adjacent shortcut suites passed all seven tests. Local package
creation is unavailable on this Windows arm64 Node/Rust host because production
distribution requires Windows x64; the x64 package black-box remains a CI gate.

CI `36996315108` passed 62 Windows desktop phases plus four expected forced-exit
recovery phases, then rejected a tab-reorder pointer endpoint outside the
scrolling strip on its 1024px desktop. The reorder fixture now uses the visible
maximize control to expose both endpoints together and restores the original
normal window afterward. Actual pointer hit-testing, native drag, exact topology
assertions and separate overflow checks remain intact. Occlusion errors also
include the tab/row bounds and hit element. This `internal-only` fixture repair
passed the five adjacent source checks and both native Windows tabs seed/restart
phases in `2026-10-02T11-23-22-032Z-win32` (one pass and one macOS-only skip per
phase). The affected existing journeys are Windows `TABS-VISIBLE-ACTIVATION-019`,
`GAME-WINDOWS-TABS-020`, `RUNTIME-LAUNCH-DESTINATIONS-008` and
`RUNTIME-TAB-TOPOLOGY-009`; their coverage targets are unchanged.

## Scope and decision

This is the single v32 execution report for the Electron Chromium cutover. It
audits the 122 active journeys in `docs/e2e-coverage.json`, including all 118
P0/P1 journeys, from the clean `e6218c55` baseline. It does not reopen the
retired Tauri/System WebView or external-CDP backlog.

The production input transport remains the in-process
`webContents.debugger` allowlist for `Input.dispatchKeyEvent` and
`Input.dispatchMouseEvent` on the exact managed Role WebContents. There is no
feature flag, dual write, `sendInputEvent`, AppKit synthetic submission,
external Chrome, reconnect, or fallback transport.

## Confirmed cutover regression

The diagnostic timeline establishes this event chain:

1. Physical `KeyY` starts a 250 ms `KeyJ` loop.
2. While main awaited a trusted DOM receipt for CDP `KeyJ`, preload treated the
   first unrelated trusted physical key or pointer event as the sequence
   mismatch and discarded the pending observation.
3. A mismatch after CDP invocation became
   `SYSTEM_TRUSTED_INPUT_INDETERMINATE`; the Role entered quarantine.
4. Compensation covered only the confirmed prefix. A current `rawKeyDown` that
   might already have reached Chromium was omitted, so a `KeyJ` keyup was not
   guaranteed.
5. The managed `KeyY` shortcut owner remained armed while automatic input was
   quarantined, making both Macro input and part of the player's native input
   appear dead.
6. `MACRO_INPUT_RECOVERY_STALE` after Role close was a secondary cancellation
   race, not the initiating fault.

This is a `cutover-regression`, introduced after the 8.4 refactor and exposed by
the CDP receipt promotion. It is not evidence against CDP as the single
transport; it is an ownership bug between physical-event provenance and the
CDP DOM receipt lane.

## v32 correction

- Isolated preload now emits an ordered raw trusted-DOM observation stream and
  never lets an unrelated event decide terminality.
- The retained AppKit path and exact Windows foreground HWND path publish a
  monotonic, per-owner physical-event sequence before DOM delivery. CDP events
  never enter that journal.
- Electron main correlates each DOM observation with the exact native physical
  cursor. Player events pass through without consuming the CDP sequence;
  unproven provenance, cursor gaps, stale surfaces, or same-owner ambiguity fail
  closed as indeterminate.
- Surface generation, document/frame token, input epoch, host generation, and
  focus/foreground proofs remain fenced before and after submission. A debugger
  detach or command rejection remains terminal for that document.
- An uncertain first keydown is included in the possible-applied set and gets a
  guarded cleanup keyup through the same CDP transport. Exact cleanup plus Core
  rollback publishes `cleanup-neutral`; any uncertain cleanup or rollback keeps
  `restart-required`.
- Role retirement cancels recovery ownership before surface retirement.
  A stale Core recovery ticket is classified as cancelled/superseded and is not
  surfaced as a shell error.
- Electron main retains the most recent 128 terminal input records in memory.
  Diagnostics include identities, CDP certainty, relation-only physical
  interleave, terminal code, cleanup, and recovery outcome. Typed text and raw
  key content are not retained.

The Rust/Electron runtime contract is v32. The public `window.rionStudio`
surface, renderer API, Macro JSON, SQLite schema, and user data remain
unchanged. The AppKit C ABI is v8 because the private native surface probe now
also returns physical-input sequence and exact-target eligibility.

## Baseline comparison

| Revision | Role in the audit | Verdict |
| --- | --- | --- |
| `v8.4.2` (`0b6e42f0`) | Last tagged 8.4 line sampled before the Electron migration series | Legacy comparison point; no retired shell is restored |
| `7bec758a` | Pre-migration runtime deadline and attribution fence | Legacy contract reference |
| `c80b0c68` | First Electron Chromium migration | Cutover boundary |
| `56f94eb6` | Trusted-input restoration and CDP candidate | Fixed before current baseline |
| `8bd2d878` | CDP promotion | First revision with the receipt-ownership risk audited here |
| `0a1be165` | Windows Chromium right-click ordering fix | Fixed before current baseline |
| `e6218c55` | Popup contract v31 and implementation baseline | Baseline retained; v32 starts here |

The baseline workflows are now terminal. [CI run 34707761268](https://github.com/rion-tw/rion-studio-source/actions/runs/34707761268)
failed, while [Electron Release Preflight 34707761617](https://github.com/rion-tw/rion-studio-source/actions/runs/34707761617)
passed for the exact `e6218c55` SHA. CI's portable checks, macOS native gate,
Windows Chromium shell E2E, package builds, and release preflight passed. The
CI aggregate remained red for three independent baseline failures: macOS Macro
keyboard E2E could not resolve an exposed canvas click point; the Windows
packaged runner retained two wrapper processes after its root command; and a
Windows close-test PowerShell invocation failed. None is evidence that v32
physical/CDP receipt correlation passed; all modified Windows native input
paths therefore remain `platform-pending` until the v32 Windows gates run.

## Rechecked items from the earlier plan

- Chrome Profile import already uses the native folder chooser and exact
  consent/confirmation journey on both hosts. No current product defect was
  reproduced.
- The CDP descriptor suite exhaustively covers every UI key, including distinct
  `KeyA` and `Digit0` identities on macOS and Windows. The prior mapping concern
  did not reproduce on `e6218c55`.
- Game/full CRUD cleanup remains covered by the paired CRUD and persistence
  journeys; no current cleanup regression was reproduced.
- Windows' complete Chromium shell profile passed at `e6218c55`, but the
  unrelated native-test and packaged-runner failures mean the aggregate is not
  promoted to a clean baseline.
- Workspace divider, Windows right-click, popup v31, and Electron-only cleanup
  are retained as `fixed-before-baseline`; they are not reimplemented here.

## P0/P1 journey ledger

The classifications are evidence labels, not substitutes for the platform
gates. Every active P0/P1 ID appears exactly once below. `platform-pending`
applies as a secondary gate to the four Windows v32 input journeys even though
their primary defect classification remains `cutover-regression`.

| Classification | Count | Meaning |
| --- | ---: | --- |
| `cutover-regression` | 8 | Directly paired with the physical/CDP receipt regression and v32 fix |
| `fixed-before-baseline` | 7 | Confirmed fix predates `e6218c55`; retained without duplicate work |
| `verified-parity` | 103 | Current paired implementation/evidence retained; no current-SHA regression reproduced |
| `test-gap` | 0 | No remaining P0/P1 journey is left without an automated route after the v32 additions |
| `legacy-contract` | 0 | Legacy contracts remain in historical compatibility records, not active P0/P1 journeys |
| `platform-pending` | 4 secondary | Windows v32 native input execution is pending CI |

### `cutover-regression`

```text
CHROMIUM-MACOS-APPKIT-MACRO-NATIVE-EFFECT-018
CHROMIUM-WINDOWS-MACRO-NATIVE-EFFECT-018
CHROMIUM-MACOS-APPKIT-MACRO-INPUT-RECOVERY-011
CHROMIUM-WINDOWS-MACRO-INPUT-RECOVERY-011
CHROMIUM-MACOS-APPKIT-MACRO-MODIFIER-CONTINUITY-008
CHROMIUM-WINDOWS-MACRO-MODIFIER-CONTINUITY-008
CHROMIUM-MACOS-APPKIT-MACRO-SHORTCUT-REENTRY-007
CHROMIUM-WINDOWS-MACRO-SHORTCUT-REENTRY-007
```

The paired recovery journey now reproduces the incident shape through visible
Role input: physical `KeyY` toggles a 250 ms `KeyJ` loop while `KeyW`, pointer,
Shift, and Alt input continues. It requires multiple trusted `KeyJ` cycles,
every player event, an empty page/Core held set after toggle-off, and no shell
error. The other six paired IDs retain key/button receipt, modifier continuity,
and shortcut ownership coverage around the same boundary.

### `fixed-before-baseline`

```text
CHROMIUM-MACOS-APPKIT-POPUP-012
CHROMIUM-WINDOWS-POPUP-012
CHROMIUM-MACOS-APPKIT-POPUP-MACRO-FOCUS-039
CHROMIUM-WINDOWS-POPUP-MACRO-FOCUS-039
CHROMIUM-MACOS-APPKIT-WORKSPACE-GAP-DIVIDERS-035
CHROMIUM-WINDOWS-WORKSPACE-GAP-DIVIDERS-035
CHROMIUM-WINDOWS-MACRO-MIDDLE-BUTTON-013
```

### `verified-parity`

```text
CHROMIUM-WINDOWS-EXTENSIONS-001
CHROMIUM-MACOS-APPKIT-EXTENSIONS-001
CHROMIUM-MACOS-APPKIT-APPLICATION-SHORTCUTS-030
CHROMIUM-WINDOWS-APPLICATION-SHORTCUTS-030
CHROMIUM-MACOS-APPKIT-QUICK-MENU-033
CHROMIUM-WINDOWS-QUICK-MENU-033
CHROMIUM-MACOS-APPKIT-GAME-CRUD-002
CHROMIUM-WINDOWS-GAME-CRUD-002
CHROMIUM-MACOS-APPKIT-LEGAL-007
CHROMIUM-WINDOWS-LEGAL-007
CHROMIUM-MACOS-APPKIT-PRIMARY-NAV-008
CHROMIUM-WINDOWS-PRIMARY-NAV-008
CHROMIUM-MACOS-APPKIT-ROLE-PERSIST-003
CHROMIUM-WINDOWS-ROLE-PERSIST-003
CHROMIUM-MACOS-APPKIT-WORKSPACE-PERSIST-004
CHROMIUM-WINDOWS-WORKSPACE-PERSIST-004
CHROMIUM-MACOS-APPKIT-MACRO-PERSIST-005
CHROMIUM-WINDOWS-MACRO-PERSIST-005
CHROMIUM-MACOS-APPKIT-MACROS-UI-017
CHROMIUM-WINDOWS-MACROS-UI-017
CHROMIUM-MACOS-APPKIT-MACRO-BACKGROUND-TAB-004
CHROMIUM-WINDOWS-MACRO-BACKGROUND-TAB-004
CHROMIUM-MACOS-APPKIT-MACRO-STANDBY-RECOVERY-023
CHROMIUM-WINDOWS-MACRO-STANDBY-RECOVERY-023
CHROMIUM-MACOS-APPKIT-MACRO-MIDDLE-BUTTON-013
CHROMIUM-MACOS-APPKIT-MACRO-MULTIROLE-005
CHROMIUM-WINDOWS-MACRO-MULTIROLE-005
CHROMIUM-MACOS-APPKIT-MACRO-OWNERSHIP-TRANSFER-010
CHROMIUM-WINDOWS-MACRO-OWNERSHIP-TRANSFER-010
CHROMIUM-MACOS-APPKIT-MACRO-TERMINAL-CLEANUP-006
CHROMIUM-WINDOWS-MACRO-TERMINAL-CLEANUP-006
CHROMIUM-MACOS-APPKIT-ROLE-KEY-BLUR-004
CHROMIUM-WINDOWS-ROLE-KEY-BLUR-004
CHROMIUM-MACOS-APPKIT-SETTINGS-PERSIST-006
CHROMIUM-WINDOWS-SETTINGS-PERSIST-006
CHROMIUM-MACOS-APPKIT-SYSTEM-SETTINGS-013
CHROMIUM-WINDOWS-SYSTEM-SETTINGS-013
CHROMIUM-MACOS-APPKIT-DIAGNOSTICS-EXPORT-029
CHROMIUM-WINDOWS-DIAGNOSTICS-EXPORT-029
CHROMIUM-MACOS-APPKIT-FULL-CRUD-010
CHROMIUM-WINDOWS-FULL-CRUD-010
CHROMIUM-MACOS-APPKIT-CRUD-REORDER-011
CHROMIUM-WINDOWS-CRUD-REORDER-011
CHROMIUM-MACOS-APPKIT-QUICK-ACCESS-015
CHROMIUM-WINDOWS-QUICK-ACCESS-015
CHROMIUM-MACOS-APPKIT-QUIT-GUARD-014
CHROMIUM-WINDOWS-QUIT-GUARD-014
CHROMIUM-MACOS-APPKIT-APP-RECOVERY-015
CHROMIUM-WINDOWS-APP-RECOVERY-015
CHROMIUM-MACOS-APPKIT-MIXED-RECOVERY-021
CHROMIUM-WINDOWS-MIXED-RECOVERY-021
CHROMIUM-MACOS-APPKIT-WINDOW-RECOVERY-UI-022
CHROMIUM-WINDOWS-WINDOW-RECOVERY-UI-022
CHROMIUM-MACOS-APPKIT-GAME-WINDOW-UI-016
CHROMIUM-MACOS-APPKIT-WORKSPACE-WEB-SLOT-016
CHROMIUM-MACOS-APPKIT-WORKSPACE-WEB-FULLSCREEN-017
CHROMIUM-MACOS-APPKIT-WORKSPACE-WEB-SECURITY-POLICY-027
CHROMIUM-MACOS-APPKIT-WORKSPACE-WEB-FILE-UPLOAD-028
CHROMIUM-MACOS-APPKIT-FULLSCREEN-TOOLBAR-012
CHROMIUM-WINDOWS-GAME-WINDOW-UI-016
CHROMIUM-WINDOWS-WORKSPACE-WEB-SLOT-016
CHROMIUM-WINDOWS-WORKSPACE-WEB-FULLSCREEN-017
CHROMIUM-WINDOWS-WORKSPACE-WEB-SECURITY-POLICY-027
CHROMIUM-WINDOWS-WORKSPACE-WEB-FILE-UPLOAD-028
CHROMIUM-WINDOWS-FULLSCREEN-TOOLBAR-012
CHROMIUM-MACOS-APPKIT-ROLE-SESSION-ISOLATION-003
CHROMIUM-WINDOWS-ROLE-SESSION-ISOLATION-003
CHROMIUM-MACOS-APPKIT-ROLE-EXPLICIT-RESET-007
CHROMIUM-WINDOWS-ROLE-EXPLICIT-RESET-007
CHROMIUM-MACOS-APPKIT-TABS-VISIBLE-ACTIVATION-019
CHROMIUM-WINDOWS-TABS-VISIBLE-ACTIVATION-019
CHROMIUM-MACOS-APPKIT-GAME-WINDOWS-TABS-020
CHROMIUM-WINDOWS-GAME-WINDOWS-TABS-020
CHROMIUM-MACOS-APPKIT-RUNTIME-LAUNCH-DESTINATIONS-008
CHROMIUM-WINDOWS-RUNTIME-LAUNCH-DESTINATIONS-008
CHROMIUM-MACOS-APPKIT-RUNTIME-TAB-TOPOLOGY-009
CHROMIUM-WINDOWS-RUNTIME-TAB-TOPOLOGY-009
CHROMIUM-MACOS-APPKIT-FONT-APPLICATION-033
CHROMIUM-WINDOWS-FONT-APPLICATION-033
CHROMIUM-MACOS-APPKIT-RUNTIME-TAB-AUDIO-032
CHROMIUM-WINDOWS-RUNTIME-TAB-AUDIO-032
CHROMIUM-MACOS-APPKIT-RUNTIME-TAB-RELOAD-031
CHROMIUM-WINDOWS-RUNTIME-TAB-RELOAD-031
CHROMIUM-MACOS-APPKIT-WORKSPACE-WEB-ONLY-024
CHROMIUM-WINDOWS-WORKSPACE-WEB-ONLY-024
CHROMIUM-MACOS-APPKIT-WORKSPACE-SHARED-ROLE-025
CHROMIUM-WINDOWS-WORKSPACE-SHARED-ROLE-025
CHROMIUM-MACOS-APPKIT-WORKSPACES-RECOVERY-026
CHROMIUM-WINDOWS-WORKSPACES-RECOVERY-026
CHROMIUM-MACOS-APPKIT-GAME-WINDOWS-NATIVE-001
CHROMIUM-WINDOWS-GAME-WINDOWS-NATIVE-001
CHROMIUM-MACOS-APPKIT-NATIVE-DISPLAY-001
CHROMIUM-WINDOWS-NATIVE-DISPLAY-001
CHROMIUM-MACOS-APPKIT-MACRO-SOURCE-ROLE-014
CHROMIUM-WINDOWS-MACRO-SOURCE-ROLE-014
CHROMIUM-MACOS-APPKIT-CHROME-PROFILE-IMPORT-033
CHROMIUM-WINDOWS-CHROME-PROFILE-IMPORT-033
CHROMIUM-MACOS-APPKIT-GRAPHICS-SETTINGS-001
CHROMIUM-WINDOWS-GRAPHICS-SETTINGS-001
CHROMIUM-MACOS-APPKIT-ROLE-SESSION-RECOVERY-033
CHROMIUM-WINDOWS-ROLE-SESSION-RECOVERY-033
CHROMIUM-MACOS-APPKIT-ROLE-SESSION-UPGRADE-034
CHROMIUM-WINDOWS-ROLE-SESSION-UPGRADE-034
```

## Completion gates

The v32 change is complete only when focused TypeScript/Rust/native tests and
the repository hygiene, typecheck, lint, test, Rust lint/test, build, desktop
E2E build/isolation/coverage, Electron native integration, macOS AppKit profile,
and packaged Electron profile pass. Windows native integration, Chromium smoke,
and packaged execution remain an independent CI gate; a local macOS result is
never recorded as Windows evidence.

## v36 input confinement follow-up

The paired P0 additions below are classified as `cutover-regression` on macOS
and `platform-pending` on Windows. They require a visible unbound Y lifecycle
with no macro transport and compare native bounds/presentation across managed
Y start/stop. DOM APPLIED alone is insufficient. The historical v32 baseline
above remains a record of that run, not evidence for this working tree.

```text
CHROMIUM-MACOS-APPKIT-INPUT-CONFINEMENT-045
CHROMIUM-WINDOWS-INPUT-CONFINEMENT-045
```


### Generic extension context menu follow-up (2026-09-14)

The macOS native menu click/cancel journey passed locally. The paired Windows
journey is automated but remains platform-pending until native Windows CI runs.
These additive journeys were introduced after the cutover classification above.

```text
CHROMIUM-MACOS-APPKIT-EXTENSION-CONTEXT-MENU-001
CHROMIUM-WINDOWS-EXTENSION-CONTEXT-MENU-001
```

## v41 diagnostic export coverage follow-up

The following P1 journeys classify the degraded diagnostic export as a prior
`test-gap`: an orphaned native host must remain in the exported evidence and
the visible Settings flow must complete the native save dialog. Windows native
execution remains `platform-pending` until its CI profile runs.

```text
CHROMIUM-MACOS-APPKIT-DIAGNOSTICS-DEGRADED-072
CHROMIUM-WINDOWS-DIAGNOSTICS-DEGRADED-072
```

## Native extension filtering follow-up (2026-09-18)

These P1 journeys close a `test-gap`: bootstrap readiness did not prove native
DNR request blocking. The fixture runs module-worker browser namespace APIs,
native session storage, CSS, and visible request actions inside the production
Role host, including Role reopen and an unassigned Role. Windows native
execution remains `platform-pending` until Windows CI runs. The separate native
DNR allocation restart failure remains open pending a rebuilt engine.

```text
CHROMIUM-MACOS-APPKIT-EXTENSION-FILTERING-001
CHROMIUM-WINDOWS-EXTENSION-FILTERING-001
```

## Windows local-host recheck (2026-09-19)

A Windows 11 ARM64 desktop recheck found that the Windows native adapter had not
compiled since `c0a1c992`: the mouse hook called `.contains()` on
`MSLLHOOKSTRUCT.flags`, which is a bare `u32` rather than the keyboard hook's
`KBDLLHOOKSTRUCT_FLAGS` newtype. No Windows Rust target, `cargo test`, clippy or
`build:electron:rust` could succeed, so every Windows native path added after that
commit was unexecuted rather than passing. With the mask corrected the workspace
builds warning-free and `cargo test --workspace --all-targets` is green.

Three stale callers surfaced once the addon ran again. The native-integration
suite and two probe scripts still requested runtime contract 37/38 against
`CHROMIUM_RUNTIME_CONTRACT_VERSION = 43`, and `probeChromiumInput.cjs` built a
parent binding that omitted `physicalInputSequence` and never registered the
exact HWND evidence owner that `windowsChromiumViewParentBinding` reads. These
were probe drift against production, not product defects; both are corrected.

Windows no longer keeps a native F11 owner. `c0a1c992` had already stopped the
low-level hook from capturing injected F11, and `SendInput` — the only way an
automated probe can drive a key — always sets `LLKHF_INJECTED`. Every shipped
Windows path therefore already reached fullscreen through Chromium, so the hook's
capture, latch and bounded dispatcher were unreachable in practice while still
owning a desktop-wide key. The owner authorised removing them on 2026-09-19. The
hook is now a pure physical-input evidence source for
`readWindowsPhysicalInputSequence` and `readWindowsPhysicalKeyboardEvidence`, and
F11 is owned above page delivery by the before-input-event handlers in
`src/electron/main/chromiumRuntimeHostFactory.ts` and
`src/electron/main/chromiumRoleQuickAccessShortcut.ts`. This aligns Windows with
macOS, which never had a native key hook for fullscreen.

Removing the capture exposed one real gap, now closed:
`src/electron/main/chromiumGlobalWebSurfaceRegistry.ts` had no
`before-input-event` owner, yet a focused Website slot shares its Game Window's
HWND, so the hook had been covering it. Website surfaces now own F11 through the
same shared lane, while Quick Access stays a Role-surface shortcut. Chromium
popups are unaffected: they are separate unregistered HWNDs the hook never
covered.

`scripts/probeChromiumShortcuts.cjs` lost its `native-hook` mode rather than
having it retargeted. An injected-input probe cannot distinguish a hook that
passes F11 through from one that captures only physical input, so any such
assertion would stay green whether the capture were present, removed, or
restored. The probe now compares the two Chromium APIs that can own the key and
records the measured difference behind CP-07: the before-input owner suppresses
both halves with no page delivery, while a registered accelerator completes on
key-down and still lets the managed page observe F11.

Correcting the first revision of this section: that probe is not the `spec` of
any journey, and attributing it to `CHROMIUM-WINDOWS-MACRO-SHORTCUT-REENTRY-007`
was wrong — that journey covers macro chord reentry. The probe's behaviour is
claimed by `CHROMIUM-WINDOWS-APPLICATION-SHORTCUTS-030`, whose manifest
description is updated with what the reduced probe now compares.

Physical F11 now toggles on key-down instead of key-up, and a held F11 can no
longer be cancelled by deactivating the window mid-press. No injected-input test
can observe either change, so `CHROMIUM-WINDOWS-GAME-WINDOWS-NATIVE-001` remains
the only route that can and stays `platform-pending` until the Windows
hardware-extended profile runs.

## v44 live tab tearout follow-up

Classification: `cutover-regression` on macOS (`c80b0c68` omitted the 8.4 live
floating-host event consumer); `test-gap` and new capability on Windows.
The paired physical-pointer journey covers held tearout, reattachment, reuse of
one transient host, retained Chromium content/Session identity, and empty-host
retirement without implicitly saving a window. Windows runtime evidence remains
`platform-pending` until the native Windows profile passes.

```text
CHROMIUM-MACOS-APPKIT-RUNTIME-TAB-TEAROUT-046
CHROMIUM-WINDOWS-RUNTIME-TAB-TEAROUT-046
```

## Widevine prototype follow-up (2026-09-23)

Classification: `test-gap` closed by a separate ECS/Widevine profile. The
macOS journey passed with public encrypted playback before and after restart;
Windows native execution remains `platform-pending`. Netflix acceptance and
production VMP signing remain separate gates, and the ordinary release keeps
official Electron 44.4.3 because the older ECS runtime crashes in the
Extension store journey.

```text
CHROMIUM-MACOS-APPKIT-WORKSPACE-WEB-DRM-PLAYBACK-095
CHROMIUM-WINDOWS-WORKSPACE-WEB-DRM-PLAYBACK-095
```
