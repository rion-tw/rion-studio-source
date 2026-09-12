# Electron Chromium Regression Audit

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
