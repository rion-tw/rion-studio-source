# Chromium Cross-Platform API Ledger

This execution ledger reduces Windows/macOS maintenance while preserving current
product semantics. It does not replace the [runtime migration contract](chromium-runtime-migration.md),
[migration execution gates](chromium-migration-execution-ledger.md), or
[updater transaction contract](updater-transaction-contract.md).

Research baseline: `33fff22550b8f1959c54c8231717c13dfc4d1b16`, Electron 43.4.1,
2026-09-06. Source inspection is not physical-platform evidence. The initial
research ran four Session/lifecycle Vitest files containing 56 passing tests;
it did not establish native replacement parity on either platform.

### Owner steering: macOS execution / Windows workstation acceptance

The owner directs this takeover to focus on macOS. Record Windows issues here
for a later GPT session on the separate Windows workstation; do not dispatch
Windows CI for acceptance. Runs 34117447948 and 34118324130 were already started
before this instruction. No later Windows result is required or claimed to close
these workstation gates. Required paired-platform coverage remains in the
repository; this execution decision does not remove or weaken CI definitions.

### Owner decision: remove physical mixed-DPI acceptance — 2026-09-07

The owner explicitly removes the requirement to obtain displays with different
DPI/scale factors, because neither the available workstations nor CI can supply
that test hardware. This supersedes every earlier pending mixed-DPI gate in this
ledger. The task is **removed by owner decision**, not passed by simulation.
Do not change display modes or purchase hardware to satisfy the removed gate.

Both stable and Chromium extended profiles now accept two real displays at the
same scale. They retain native placement, work area, display identity, scale
readback, drag/resize, maximize, fullscreen and minimize assertions. The stable
Windows journey requires WM_DPICHANGED only when the actual move changes DPI;
same-DPI placement still requires its exact native scale readback. No Windows
profile is executed by this macOS session. At this policy checkpoint physical multi-display and real sleep/wake were open;
the later 015dbaa2 report below completes macOS ordinary dual-display acceptance.
Real sleep/wake remains pending.

`tests/electron-display-scale-data.test.ts` adds 22 deterministic cases with
explicit macOS/Windows fixture data: 1x/1.25x/1.5x/1.75x/2x/3x scale factors,
negative display origins and platform work-area insets, unchanged logical window
placement without double scaling, rejection of stale native-scale fences,
scale-change round trips without coordinate drift, and invalid-scale rejection
without replacing the last valid topology. The four focused display/topology/
placement suites pass 50 tests. These results cover data transformations and
revision fences, not native DPI callbacks, physical input targeting or OS chrome.

Complete JavaScript validation passes 465 files / 3760 tests. The first full run
had 3759 PASS and one failure in chromium-tabs-parity-e2e-source.test.ts, whose
source guard still required the removed mixed-scale precondition. The guard now
enforces its absence and retains the native scale-readback assertion; the final
complete suite passes. Typecheck, source hygiene, documentation/context and E2E
coverage checks pass; P0 70/70, P1 77/77 and both cutover parity sets 41/41 remain
unchanged. The modified physical profiles have not run on either workstation.

Affected journeys: NATIVE-DISPLAY-001 and paired
CHROMIUM-MACOS-APPKIT-NATIVE-DISPLAY-001 / CHROMIUM-WINDOWS-NATIVE-DISPLAY-001.
This is an owner-approved acceptance-policy change with internal-only test and
documentation changes; runtime DPI support remains intact. CP-11/12/15 retain
other open requirements, so the API-ledger closure count remains 9/18.

The policy/test change is committed and pushed as
`a925e6373adf501eb8dafe12d3ba9f67e887faa7`. Full lint has 0 errors and 23 existing
warnings; full hygiene also passes. Production runtime content is unchanged from
806ddb0a by the intervening documentation and mixed-DPI acceptance-policy commits.

### Current acceptance checkpoint — 2026-09-08 (macOS only)

API closure remains **9/18**. The nine open items are CP-04, CP-08, CP-10,
CP-11, CP-12, CP-15, CP-16, CP-17 and CP-18; these are ledger items, not nine
individual test invocations. CP-17 is the gated production Tauri/System WebView
retirement; CP-18 records final validation. Physical mixed-DPI is removed by the
owner, while ordinary multi-display and real power/lifecycle evidence remain.
Earlier handoff tables below describe their historical checkpoint.

The current validation candidate is
**b8bae38bb10acb1e6d295c027c100d7267803815**, including the owner's Website changes
at **486e0842be6b14c132e9d4a33ece1c5a5fd16983** and the **8d68be93** WDIO
service-order correction. macOS-only CI **34149031009** passes shared checks
(3828 JavaScript PASS / nine platform skips), native validation (1681 Rust PASS /
five ignored; 14 Electron native PASS / two platform skips), stable full
(31 PASS + three expected force terminations / 40 journeys), and complete
Chromium E2E (56 PASS + four expected force terminations / 52 journeys).
All 60 Chromium phases prepare the native sampler once, with no original
undefined-windowHandle setup error. This run is now completely SUCCESS, including
fixture package/updater and packaged AppKit black-box. Earlier CI **34145679440** at 90614cef is completely SUCCESS,
including fixture package/updater and packaged AppKit black-box; the earlier
a8fab843 cleanup failure remains unexplained rather than overwritten.

The latest complete local hardware receipt remains **015dbaa2**, with 57 PASS +
four expected force terminations / 54 journeys and ordinary dual-display
acceptance. The later local replay fails while UserNotificationCenter owns
native foreground. The owner reports no visible prompt; the foreground identity
still does not change, so a manual switch to Finder/desktop is requested before
another physical replay. No Windows acceptance is dispatched. Later
source-identical documentation commits do not create another validation candidate.

| Gate | macOS current evidence | Windows next workstation |
| --- | --- | --- |
| CP-04 / CP-08 native and topology | 015dbaa2 local Rust 1681 PASS / 5 ignored and complete Chromium hardware profile PASS; b8bae38b native CI PASS; AppKit input retained | Final-source View-only native/full replay, including detach/compensation failure |
| CP-10 consented import | Visible consent/import/restart PASS in 015dbaa2 physical hardware profile and b8bae38b full Chromium CI | Native chooser and complete consent/import/restart acceptance pending |
| CP-11 / CP-12 hardware/lifecycle | Clean 015dbaa2 complete hardware profile and actual dual-display controls PASS; real sleep/wake pending | Physical display/input/session-end gates pending; mixed-DPI removed |
| CP-15 complete profiles | 015dbaa2 physical hardware 57 PASS + 4 expected force exits; b8bae38b Chromium 56 + 4 and stable 31 + 3 | Final-source full and hardware profiles pending |
| CP-16 package/updater | b8bae38b fixture package/updater/black-box PASS; a8fab843 cleanup failure still under diagnosis | Final-source package/update acceptance pending; production-key cutover remains separate |
| CP-17 / CP-18 retirement/final closure | Still gated; AppKit and Rust authority retained | No Tauri retirement based on macOS-only evidence |

### Next Windows workstation: execution order and evidence to retain

This is a handoff checklist, not a request to run Windows CI from the Mac. The
current complete macOS CI candidate is
b8bae38bb10acb1e6d295c027c100d7267803815 (Electron 43.6.0), including the later
Website changes and the WDIO initialization correction. The latest complete
physical Mac hardware receipt remains 015dbaa2. Preserve any Windows
working-tree changes, fetch the
shared branch safely, and record the actual complete HEAD SHA before building.
Confirm 8dff7722462f51d5407cf520bc7d37629829ede9 and b0c3c184 remain ancestors.
Later code changes must be distinguished from this acceptance
baseline; do not silently label an older binary as the newer source.

| Order / gate | Windows action and required evidence |
| --- | --- |
| 1. Native and shared regression, CP-04/08/18 | Run pnpm run lint:rust and pnpm run test:rust on Windows, retaining the updater 256-round winner test. Run the complete pnpm run test and record every failure/skip; do not expect or copy the Mac totals. Build both shells and verify production E2E isolation. Retired child-HWND exports must remain absent from the actual addon. |
| 2. Exact known failures, CP-04/08 | Inspect mixed-recovery-force's stale WebElement-origin correction and the new-window detach/compensation failure described in the Windows follow-up table below. Preserve exact logical/native window identity, real pointer hit, survivor topology, primary error and compensation error. A later successful projection cannot repair a failed terminal receipt. |
| 3. Complete profiles, CP-11/15 | Run chromium-windows-smoke and stable full, or their hardware/extended supersets when ordinary physical displays are available. Read the manifest/report instead of assuming Mac phase counts. Verify the document-root navigation locator on the real Windows UI. A focused repair must be followed by the applicable complete profile. |
| 4. Consented import, CP-10 | Execute visible consent, cancel, native directory picker, profile/game choice, final confirmation and fresh-process restart. Verify exactly scoped launch-origin cookie/LocalStorage data and unchanged source bytes. Native picker control ID 1152 still needs Windows evidence. Never replace consent with debug import or use a real user profile as the live runtime. |
| 5. Hardware/lifecycle, CP-12 | Retain real foreground/hidden trusted input, ordinary secondary-display controls and session-end/close-drain acceptance. Same-scale displays are allowed. Physical mixed-DPI is removed by owner decision; actual power/session-end evidence is separate from injected lifecycle signals. |
| 6. Package/install/update, CP-16 | Follow the existing Windows package workflow/runbook for the NSIS installed payload, Rust-owned updater transaction, signature/hash checks and packaged native black-box. Record exact source/version/package identities. Do not invent signing inputs, modify credentials or infer production-key transactions from fixture tests. |
| 7. Final ledger decision, CP-17/18 | Record complete SHA, OS/runtime, commands, artifact/run IDs, profile/phase/journey verdicts, normal flush/exit and expected-force outcomes. Keep real update, promotion and release-delta gates separate. Do not remove protected Tauri/System WebView code based only on Mac success or a subset of these Windows checks. |

The original Windows workstation JavaScript result remains **16 FAIL / 3641
PASS / 48 skipped**: 11 file-symlink EPERM failures, four original 10000 ms
failures (Vite React preamble, physical Macro modifiers, long-flow mind-map
growth, WebApp preset selection), and one later fixed document-reference failure.
The symlink probe found absent SeCreateSymbolicLinkPrivilege and Developer Mode;
record the new workstation's actual capability rather than skipping security
assertions. Original logs are under
.desktop-e2e-artifacts/windows-handoff-b0c3c184/view-only-full-js.log on the Windows
workstation. A focused documentation PASS or a separate hosted PASS is not the
missing complete workstation verdict. Keep the original security assertions and deadlines.

CI **34125930709** is now completed **SUCCESS**, exact checkout
806ddb0a76867e1027f924052f5d636a85441279, manual platform_scope=macos and no Windows
jobs. Package job **101754476949** completes package:electron:mac, previous-version
fixture construction, extension/runtime/package verification,
test:electron-updater:packaged and test:e2e:desktop:electron:packaged. The log
records "Verified darwin packaged updater transaction for 8.5.0." These use the
existing ephemeral CI updater fixture, not production signing keys or release
publication. The runtime verification identifies Electron 43.6.0 / Chromium
150.0.7871.250 / Node 24.20.0 / Node-API 10 / Rust Core 8.5.0 (darwin-arm64).

Artifact **10021756473**, packaged-chromium-role-black-box-macOS-34125930709-1,
contains packaged-smoke-report.json under
2026-09-07T13-56-11-918Z-9a59b2bc-e0df-40d9-8407-aaf416c810cd-darwin-packaged-black-box:
verdict=passed, exitCode=0, fixtureInteraction=visible-os-accessibility-click,
nativeHostKind=appkit-chromium, remoteDebugging=false, appVersion=8.5.0.
app.asar SHA-256 is 2230c59d1d5577359beb1ba9d50261d6a132f5cc62ce1ec545985799420dceea;
packaged executable SHA-256 is
82762f2fea802e4de80a9fc02879a34aa326be32fafc0e67e0e536f5c4072095.
This is packaged CI fixture acceptance, not the final production migration gate.

Local E2E runs in the isolated detached worktree
/Users/aron/.codex/worktrees/rion-macos-native-20260907 so the owner's independent
root electron-vite process and uncommitted feature work can continue. The initial
shared node_modules symlink was replaced with independent frozen-lockfile/offline
installed dependencies after the updater signer correctly rejected an escaped
workspace path. The shared target build cache is excluded locally as a build
input; no source is hidden. Node is explicitly pinned to
/Users/aron/.nvm/versions/node/v24.20.0/bin. Clean reports starting at 61f32424 refer
to this isolated checkout, not the owner's dirty root workspace. Production
runtime content advanced to 015dbaa2 after the independent 52cc4bb9 Website
entrance commit. The 61f32424 CI results below are historical for that new product
source; current-source native/full/package acceptance is tracked separately.

| Local follow-up report | Exact result and correction |
| --- | --- |
| 2026-09-07T13-52-57-443Z-darwin, f30f6c03, isolated Node 24.15.0 | Typed native tab click and window close advance successfully; tab drag still uses System Events AXFocusedWindow coercion and fails -1728. Commit 040aaedc shares the existing typed AppKit focus helper for drag and tab menus; real CGEvent drag and native menu actions remain unchanged. |
| 2026-09-07T13-57-05-717Z-darwin, 040aaedc, Node 24.20.0 | Tabs-visible seed and restart PASS. Hardware phase fails visible target-display persistence: WebDriver elementClick returns success, but SQLite retains the original display and Core has no update command. This is not a native display-move failure or a JSON property-order mismatch. |
| 2026-09-07T14-02-41-898Z-darwin, 040aaedc plus passive click diagnostic | Tabs seed/restart pass. Captured trusted left-click has expectedTarget=false and targets the page background, proving the display option was not clicked. No domain command is injected. A viewport-pointer diagnostic follows; acceptance remains pending at this checkpoint. |
| 2026-09-07T14-07-48-191Z-darwin, viewport-pointer diagnostic | Exact target hit exists before movement, but the submenu element becomes stale after real pointer movement; no click or domain update is claimed. This hardware journey now uses the supported visible submenu keyboard navigation, checks exact radio-item focus and records a trusted Enter key receipt. The pointer failure remains recorded, not labelled repaired. |
| 2026-09-07T14-10-31-124Z-darwin, visible keyboard selection | Trusted Enter reaches the exact secondary-display item with no modifiers. Target display and saved work area persist; the shown three-tab native host matches display ID, scale and work area. Next failure is the titlebar driver's old System Events AXRadioButton window traversal (-1728). Typed exact-PID/window helpers replace that same obsolete lookup in drag, resize, minimize and minimized readback; actual CGEvent/AXPress and native domain assertions remain required. |
| 2026-09-07T14-14-30-295Z-darwin, typed native controls | Seed/restart, display selection/show, physical titlebar drag, edge resize and Window-menu zoom/restore advance. Fullscreen inspection catches native normal at revision 24 while Core still reports maximized; recorded topology subsequently advances to revision 25 normal. The hardware wait now requires both the native predicate and exact Core window presentation before continuing, with the existing deadline unchanged. |



### 806ddb0a macOS native and stable completion

CI 34125930709 native job 101754644198 succeeds: Rust lint and complete workspace
tests pass (1677 passed / 5 ignored), retaining the updater 256-round test;
native Electron startup/compatibility tests have 14 PASS and two platform skips.
The native Tauri build also succeeds. Stable full job 101754477221 succeeds,
artifact 10020644743 / report 2026-09-07T13-11-46-652Z-darwin: exact clean source
806ddb0a, tauri-v22 full profile, 29 PASS plus three expected force terminations,
40 journey verdicts PASS. Shared checks, renderer assets and sanitizer/soak jobs
also succeed. Chromium/package job 101754476949 is still running at this
checkpoint; neither its full-profile result nor package/updater result is yet
claimed. No Windows job exists in this manually scoped run.

### 806ddb0a complete Chromium E2E and local hardware-driver follow-up

CI 34125930709 Chromium artifact 10020872712 / report
2026-09-07T13-11-49-757Z-darwin completes chromium-macos-appkit-smoke with
**56 PASS plus four expected force terminations; 52 journey verdicts PASS**.
Checkout is 806ddb0a; report worktreeDirty=true reflects the CI's ephemeral updater
trust/version fixture preparation, so this is not labelled a clean production
checkout or production-key update verdict. Packaging is still running at this
checkpoint. Macro background tab, tabs-visible seed/restart and Chrome-profile
import seed/restart all pass with finalFlush=true and processExited=true.
The tab evidence includes reordered, moved-existing, detached-with-successor,
hidden/revealed and restart-consolidated stages. Import evidence retains the same
cookie/LocalStorage markers after a fresh app restart under appkit-chromium.
The neutral physical-click path passes its trusted/exact-target/no-modifier
assertions; this does not retrospectively prove the old failing event's flags.

The owner confirms that the earlier system prompt is no longer present. Local
hardware-focused validation resumes on the same-scale displays, with these
separate failures retained:

| Local report | Exact finding and action |
| --- | --- |
| 2026-09-07T13-33-14-293Z-darwin, clean 8906ecb2 | The focused runner includes restart but omits its transitive seed prerequisite. Missing Chromium Tabs Target Window; finalFlush/processExited true. The runner now resolves the complete prerequisite graph once in dependency order, rejecting cycles and prerequisites outside the selected profile. Six focused planning cases cover the paired hardware profiles and invalid graphs. |
| 2026-09-07T13-36-44-612Z-darwin, 8906ecb2 plus runner fix | Seed now runs, but System Events native-tab traversal fails with osascript assistive-access error -1728. Current System Events UI-elements-enabled and AXIsProcessTrusted both return true; exact TCC attribution is com.openai.codex at /Applications/ChatGPT.app, with allowed Accessibility/PostEvent and AppleEvents decisions. No grant/reset is changed; the error is not sufficient evidence of missing owner permission. |
| 2026-09-07T13-44-26-375Z-darwin, plus native-tab adapter fix | Exact retained AppKit tab coordinates and typed PID/window/tab focus validation pass. The journey advances to the native close button, where System Events list-based AXPress raises the same -1728. A typed exact-PID/AXIdentifier close helper now checks Accessibility trust, foreground/focused window, AXCloseButton role/subrole/enabled state and AXWindow ownership before actual AXPress. Native close acceptance remains pending. |
| 2026-09-07T13-48-34-342Z-darwin | Build verifier refuses the overwritten production main bundle before any phase launches. An independent electron-vite dev process is rebuilding the shared out directory. Preserve that process and move further native acceptance to an isolated worktree; do not bypass the build verifier. |

Tab point calculation is shared with the existing native context-menu path.
Eight pure macOS geometry tests cover unequal-width tabs at negative screen
coordinates, wrong owners/order, duplicates, missing anchors and invalid bounds.
These changes are internal-only E2E driver/runner corrections. Primary native
actions, exact domain assertions and their existing deadlines remain required;
neither simulation nor a partial hardware run closes hardware acceptance.
Current follow-up validation: complete JavaScript suite 467 files / 3774 PASS;
typecheck PASS; lint 0 errors / 23 existing warnings; native close Swift typecheck
PASS. The initial geometry test imported the full E2E UI module and exposed a
TypeScript project-file boundary error; geometry is now a pure scoped module
included explicitly in the Node test project. No broader E2E module inclusion or
typecheck suppression is used.

| Windows follow-up | Exact evidence and next workstation acceptance |
| --- | --- |
| Post-cleanup native/full regression | Handoff 8dff7722 contains View-only cleanup. Preserve Rust lint/test with the unweakened 256-round updater test; run complete Windows native, production-build/isolation and chromium-windows-smoke acceptance on the final handed-off SHA. |
| New-window detach | fa217490 attempted a post-Show snapshot fix; the raw/logical snapshot distinction is corrected in the macOS follow-up below. CI 34117447948 job 101727469254 still fails: artifact 10017317351 / 2026-09-07T11-37-19-749Z-win32 / chromium-tabs-visible-seed reaches the final shell-error assertion at chromium-tabs-parity.e2e.ts:1059 with ELECTRON_CHROMIUM_NEW_WINDOW_COMPENSATION_FAILED. The visual detach/reveal topology stages have completed. Original failure remains unresolved; inspect the exact primary/compensation cause before changing behavior. |
| Stable primary navigation | Same CI job 101727469095 / artifact 10017111920 fails while screenshot shows the expected empty Role page. Current document-root locator repair has only DOM regression evidence (8 PASS); run stable smoke/full on Windows, preserving exact visible assertions. |
| Chrome import | 82db2663 adds actual consent, cancellation, native folder selection, confirmation, filtered transfer and restart phases. Windows native chooser ID 1152 and the full journey still need workstation evidence. Fixtures are isolated; do not substitute debug import calls or real user-profile keys. |
| Windows JavaScript suite | Historical workstation full suite is still not green (symlink EPERM and four original deadlines). Hosted 3e2d415a has 451 files / 3656 PASS, 48 skipped and the fixed document-reference failure. These are separate outcomes; focused tests never replace the workstation full verdict. |
| Hardware/lifecycle/install/update | Preserve physical input/display/DPI/session-end profiles and signed updater transaction/hash verification. No production publication, merge or credential change is authorized. CP-17 remains gated. |

### macOS native follow-up on 82db2663 working tree

This entry supersedes the earlier AX-permission and fa217490 post-Show hypotheses;
historical failures below remain failures. No Accessibility grant was changed.
The screenshot already showed the controlling app granted access. Exact PID AX
probes succeeded; System Events list-item coercion lost the process/window owner
and produced misleading -1719/-1700 errors. Native helpers now retain typed
AXUIElement ownership for focused AppKit windows and the attached NSOpenPanel
(including its verified Apple system XPC service). Visible menu/keyboard/folder
operations remain the primary user actions; no debug import command replaces them.

| macOS evidence | Actual outcome / remaining gate |
| --- | --- |
| Chromium shell | Local report 2026-09-07T12-12-02-138Z-darwin, chromium-shell-smoke PASS; finalFlush=true and processExited=true. Typed AX focus/shortcut correction is exercised. Full profile remains pending on final source. |
| Latest historical CI | 34114497057 / 3e2d415a macOS package job 101718052762 SUCCESS, including 54 PASS plus four expected force exits and package/updater. 34117447948 / fa217490 macOS package 101727469313 and 34118324130 / 82db2663 job 101730244136 FAIL tabs-visible-seed; their native and stable jobs succeeded. Neither failed run reached the appended import journey. |
| Detach diagnosis | embeddedWindowsShow returns a raw browser-slot snapshot, not the logical window projection. fa217490 incorrectly assumed it did. Current fix awaits the exact Show effect then reads appSnapshot for unique logical owner/tab/active/visible validation, preserving native effect failure. Realistic raw-return fixture fails eight cases before the fix and all 16 pass after it. Full native tabs acceptance remains pending. |
| Visible Chrome import | Reports 2026-09-07T12-17-55-553Z and 2026-09-07T12-25-23-493Z fail the import seed. Consent, cancel, exact native chooser, preview and confirmation execute. First failure: Rust serializes commitMarkerSha256=None as null; both TS descriptor parsers incorrectly rejected it. Matching null/absent/hash contract tests fail two cases before correction and 30 focused tests pass after correction. |
| Fresh import readback | After the null fix, sequence 70–77 snapshot/apply succeeds; sequence 78–81 verify fails CHROMIUM_PROFILE_IMPORT_FRESH_READBACK_MISMATCH and rolls back. Isolated bundled-Electron apply/verify probe finds LocalStorage persisted but cookies empty. Setting sessionData to the exact role Chromium path before ready produces exact cookie and LocalStorage persistence without relaxing sandboxing or verification. Visible UI seed and fresh-app restart now both PASS in local report 2026-09-07T12-33-18-293Z-darwin: exact one cookie/one LocalStorage marker, source digest unchanged, no pending import journal, finalFlush=true and processExited=true in both phases. Affected journey: CHROMIUM-MACOS-APPKIT-CHROME-PROFILE-IMPORT-033; Windows counterpart remains pending. |
| Native Rust | Current native lint PASS; complete Rust test PASS (1677 passed, 5 ignored across eight binaries), retaining the updater 256-round test. No Rust production source changed in this follow-up. |
| JavaScript baseline | Latest import follow-up: full suite 463 files / 3729 PASS; lint 0 errors and 23 existing warnings; hygiene, typecheck and E2E coverage PASS. Malformed commit-marker values remain rejected. Full native Chromium profile is next. |
| Physical displays | Two Studio Displays are physically present (IDs 2, 3), currently both scale 2. Read-only mode inventory exposes genuine scale-1 modes on the secondary display. No display mode has been changed yet; hardware-extended remains pending. Existing macro standby coverage injects serialized suspend/resume signals and does not establish actual machine sleep/wake evidence; CP-12 physical power acceptance remains separately pending. |

The sandbox diagnosis is supported by Electron v43.6.0
[GetNetworkContextsParentDirectory](https://github.com/electron/electron/blob/v43.6.0/shell/browser/electron_browser_client.cc#L1161),
which returns DIR_SESSION_DATA. Isolated helper userData previously pointed to a
new temporary directory outside the role store. The correction supplies only the
canonical Rust-issued role path through the inherited request before app ready.
Windows startup behavior is unchanged and its native acceptance stays with the
separate workstation. Ledger closure remains 9/18.

### c72d688e committed macOS fixes and local focus interruption

`c72d688e42b06eb0595a0f9282f8751692f7db36` commits and pushes the native AX,
raw/logical detach projection, nullable import descriptor, and macOS helper
sessionData fixes described above. The successful import report was produced
from that runtime content before commit; its report HEAD is therefore 82db2663
plus the recorded working-tree fixes, not a clean 82db2663 verdict.

Full local chromium-macos-appkit-smoke at c72d688e stops in extensions-seed:
report 2026-09-07T12-35-47-300Z-darwin, line 87 awaiting the future role's loaded
extension state. Store installation and visible role creation succeeded; Core
sequence 130 starts a native focus transition and no terminal focus arrives.
A diagnostic-only event observer then reproduces this in report
2026-09-07T12-40-38-789Z-darwin: nativeTransitionStateEvent shows visible=true,
minimized=false, focused=false, foreground=false; no focus event follows.
No deadline or assertion changed. Read-only native attribution identifies the
foreground app as UserNotificationCenter (PID 10663), while the test window
retains its exact AppKit AXIdentifier. The system prompt text is not yet known;
Computer Use refuses access to that system app. Owner input is requested and
local focus-dependent acceptance pauses pending identification of the prompt.
This is not yet proof of a runtime focus defect or a passed extension journey.

Failed-test Electron PIDs 75119 and 84663 were terminated only after exact
artifact-run arguments verified their ownership; their failed/unknown shutdown
verdicts remain failures. The unrelated pre-existing Electron process is retained.

Manual CI adds platform_scope=macos for this takeover; all is the default,
and push/PR/reusable release calls always retain both platform matrices.
Scope-specific concurrency avoids cancelling paired runs. Existing release
admission requires a push event, so manual diagnostic success cannot become
production release evidence. The new run must bind the exact final SHA and
contain no Windows jobs; package/updater evidence still uses CI fixture trust
and cannot close the production cutover gate.

### 01916dd5 macOS-only CI and production output

Exact source `01916dd5fb2f2b4df84d5ef8b1e10afc8daf9ab7` is pushed.
CI [34123638762](https://github.com/rion-tw/rion-studio-source/actions/runs/34123638762)
was dispatched with platform_scope=macos and that complete immutable ref.
Observed job inventory: macOS package/E2E 101747126644, stable E2E
101747126714, native validation 101747259668, and shared Linux checks/assets/
sanitizer only. No Windows job was created. Native validation and stable full E2E succeeded, as did all shared jobs. Chromium/package job failed at chromium-macro-background-tab; package/updater steps were not reached.

Local final checks: full Vitest 464 files / 3735 PASS; lint 0 errors / 23 existing
warnings; typecheck, full hygiene and production E2E isolation PASS. One initial
full-suite failure was a stale YAML-format source assertion after matrix syntax
changed; the assertion was updated to the explicit JSON platform declaration,
and the complete suite then passed. Tauri and Electron production builds PASS;
out/renderer is restored to production (38 sources / 3346159 bytes). Original
8dff7722 and b0c3c184 remain ancestors; the preserved graphics-work branch remains.

Affected runtime journeys: paired GAME-WINDOWS-TABS-020 and
TABS-VISIBLE-ACTIVATION-019 for exact detach ownership, and paired
CHROME-PROFILE-IMPORT-033 for descriptor/one-time transfer. macOS import seed and
restart are passed as recorded above; latest full/native tabs and Windows
workstation replay remain pending. Native AX driver and diagnostic observer
changes are internal-only; they retain visible primary actions. The observer's
real failed-run evidence records exact native events without creating progress.
CI-scope routing is internal-only, with 17 focused workflow checks and complete
JS validation; no product journey or coverage target was removed.

### 806ddb0a committed follow-up and remaining cleanup gates

Exact source `806ddb0a76867e1027f924052f5d636a85441279` commits the admitted-launch
correction and physical-click evidence below. Local complete JavaScript validation
passes 464 files / 3738 tests; Electron production build and E2E production
isolation pass. CI [34125930709](https://github.com/rion-tw/rion-studio-source/actions/runs/34125930709)
checks that exact source with platform_scope=macos. At this checkpoint, native
validation 101754644198, stable desktop E2E 101754477221 and Chromium/package
101754476949 are in progress. The job inventory contains no Windows job.

Closure remains 9/18. Seven open prerequisite workstreams are CP-04, CP-08,
CP-10, CP-11, CP-12, CP-15 and CP-16; CP-17 is the gated sole-entry removal
itself, and CP-18 is final validation and prevention of duplicate mechanisms.
These are workstreams, not seven remaining test cases or an estimate of effort.
The separate migration execution ledger additionally governs real updater
transactions, terminal promotion, the final v22-to-v23 release configuration
delta audit and exact-candidate native/physical release evidence. Those gates
overlap CP-16/CP-17 and must not be added as unrelated API-ledger tasks or waived
by a passing CI fixture. AppKit and Rust-owned data/macro/topology boundaries
remain required after Tauri/System WebView-only cleanup. Windows acceptance
stays assigned to the owner's later Windows workstation session.

### Admitted launch / clean-exit dependency correction (806ddb0a)

The exact unfinished records in 2026-09-07T12-40-38-789Z-darwin are the default
Role launch, native focus continuation, and cleanExitLifecycle; runtime clean
preparation never starts. Source tracing identifies the post-admission optional
cache reconciliation in ChromiumRuntimeLaunchCoordinator: it calls the same
settling snapshot reader used before actions, so it waits for native focus after
Core already admitted the launch. Renderer ingress drain then waits for that
request before the effect coordinator can cancel the native continuation.

The correction makes only the post-admission cache check non-waiting. It still
validates the full current Core/native/display envelope and leaves a mismatched
or unfinished target pending and non-reusable. Required pre-action reads still
wait for exact authoritative events; no timeout, optimistic promotion, or weaker
projection assertion is added. Three regression cases trap native-event drain,
projection settle, and next-projection wait after admission; all three fail the
old implementation without waiting for a deadline. After correction, launch,
clean-exit and bootstrap suites pass 84 tests. Native blocked-focus shutdown is
still pending; unit success does not clear the interrupted extension journey.
Affected journeys include paired RUNTIME-LAUNCH-DESTINATIONS-008, EXTENSIONS-001
and QUIT-GUARD-014. Windows execution remains a separate workstation gate.

### 01916dd5 macro physical-click evidence and follow-up

CI 34123638762 artifact 10019614396 / report
2026-09-07T12-47-04-742Z-darwin has 26 PASS and one FAIL. The failing
chromium-macro-background-tab reaches showChromiumMacroWindow line 529 after
its physical Show click; both before/after receipts have runtime revision 0 and
no windows, and the Core command journal contains no show/restore request.
The screenshot instead shows a selected row and bulk-selection toolbar.
useListSelection's click capture consumes modifier clicks as selection, so
inherited modifier flags are a concrete hypothesis; the old run did not record
its click modifiers and cannot by itself prove the exact input flags.

The physical driver now explicitly requests a plain left click (empty CGEvent
flags and click count 1) and records the actual trusted DOM click, exact target,
button and all four modifier booleans. It asserts the full receipt and never
retries the click. Missing input fails at the receipt boundary; the existing
Show/native completion assertion remains. Swift assertion failures use stderr
and exit(1), avoiding crash-report windows from fatalError. Swift typecheck,
TypeScript typecheck and hygiene pass; live Macro acceptance remains pending
on the next corrected source. Windows driver behavior is unchanged.

### 82db2663 import gate and exact navigation failure follow-up

`82db26639f123b068aec1bc83e888f2b608fdc65` is pushed with the visible Chrome
import seed/restart implementation. CI 34118324130 checks out that full immutable
SHA. Native import is still pending; implementation and manifest coverage do not
constitute executed acceptance.

CI 34117447948 at `fa217490` has shared checks and macOS stable full SUCCESS.
Windows stable full job 101727469095 fails `smoke-seed` in
`assertSeedPrimaryPage('/roles')`. Artifact 10017111920 / report
`2026-09-07T11-37-24-878Z-win32` shows the visible "No roles yet" heading and
Create role control, while the WebDriver log repeatedly searches the same parent
handle `8e20ecee-8045-4f3a-8891-5a071443b2d3` and returns no such element.
The assertion retained a page handle across lazy route rendering. The follow-up
resolves each assertion from the document, preserving page containment, exact
heading/action text, visibility, and forbidden header/kicker checks. A DOM page
replacement regression fails twice on the old implementation and all eight
platform-table cases pass with the fix; wrong/missing/hidden content still fails.
This establishes the harness correction, not the Windows native verdict.
Affected journeys include DASHBOARD-NAV-001 and the paired Chromium
GAME-CRUD-024 navigation assertions. Their visible actions and coverage remain.

Local Tauri production build, Electron production build and desktop E2E isolation
pass. The final output is the production renderer (38 sources / 3346159 bytes).
The import commit's full Vitest is 462 files / 3715 PASS. The navigation follow-up
passes its focused tests, typecheck, focused lint and full hygiene; native replay
remains required.

A minimal isolated Electron 43.6.0 BrowserWindow probe now returns one AXWindow
through the same osascript caller, without changing any permission. Evidence:
`.desktop-e2e-artifacts/macos-takeover-8dff7722/ax-target-probe.json`.
This narrows the local access problem to the Rion E2E target/launch context and
contradicts treating it as a blanket missing Electron or ChatGPT grant.

Physical inventory on this Mac now contains two Studio Displays: screen 2 at
(0,0), screen 3 at (2560,0), both logical 2560x1440 and scale factor 2.
The hardware profile requires distinct scale factors; the current arrangement
does not meet that gate. No simulated screen or system setting change is counted.
Windows physical/session-end and production updater/cutover evidence remain open.
Ledger count stays 9/18; Tauri retirement remains prohibited until its gates pass.

### fa217490 validation and consented-import E2E implementation

`fa21749094640f3dd678d90af180ff9547bf02a5` is pushed. Full local JavaScript
validation passes 462 files / 3715 tests; full lint passes with the existing
23 warnings; hygiene and typecheck pass. Its native Rust sources are identical
to the 1677 PASS / five ignored macOS run recorded below.
CI 34116948212 never checks out source: the dispatch incorrectly supplied the
short SHA as a ref name. No product test ran. Corrected immutable 40-character
input starts CI 34117447948; this is not an unchanged failed-test retry.

CI 34114497057 Windows native job 101718227707 finishes with Rust lint and
1669 Rust PASS / four ignored, plus native integration 8 files / 16 PASS.
Renderer validation has exactly one failure, the two deleted-path references
already corrected in `8dff7722`: 451 files / 3656 tests PASS, ten files /
48 tests skipped. None of the prior four timeout failures or symlink EPERM
failures occurs in this hosted execution. This separate run does not relabel
the failed Windows workstation suite or the failed CI job. Build after that
failed step is skipped. CP-08 latest native input evidence is obtained; full
post-deletion Windows profile acceptance still requires the detach repair.

Local `chromium-macos-appkit-smoke` at fa217490 builds successfully and passes
both extension phases, then fails `chromium-shell-smoke` at the visible native
shortcut: osascript Accessibility rejection -25211. Artifact
`2026-09-07T11-26-56-059Z-darwin`. A focused permission check in
`2026-09-07T11-34-45-011Z-darwin` confirms the same failure. The owner supplied
the Accessibility settings screenshot: ChatGPT and Codex Computer Use are
enabled. The actual parent is ChatGPT.app (bundle id com.openai.codex), and TCC
records Allowed for that responsible process; direct ChatGPT/System Settings
AX reads succeed while the E2E Electron target rejects access. The precise
target-specific cause remains unresolved; do not infer missing owner consent
or change permissions, credentials, or native assertions to force a pass.

Commit `82db2663` CP-10 adds paired CHROMIUM-MACOS-APPKIT / CHROMIUM-WINDOWS
CHROME-PROFILE-IMPORT-033 journeys in the two smoke profiles, with seed/restart
phases and a dedicated shared namespace. The actual visible consent/confirmation
and native chooser remain primary actions. A separate isolated Chromium fixture
generates origin-keyed LevelDB and test-owned Chrome SQLite cookies; real user
Chrome data and OS decryption keys are never touched. Assertions cover cancelled
consent/confirmation without Role creation, exact filtered counts, unchanged
source bytes, no pending journal, native host identity and cookie/LocalStorage
markers after visible Role launch and fresh application restart.

Local source fixture creation succeeds. The new focused profile reaches the
visible consent checkbox and native folder chooser, then encounters the same
Accessibility denial, before import or restart:
`2026-09-07T11-37-28-779Z-darwin`. The failed chooser also prevents the normal
final-flush acknowledgement: the report separately records
electronProcessExited=false and electronShutdownError. The process subsequently
exits; this is not retroactive clean-shutdown evidence. Bounded, argument-free
process ancestry diagnostics are now saved on native action failure.
Focused desktop harness / tab guards / import renderer tests pass ten files /
69 tests. Coverage is P0 70/70, P1 77/77, paired replacement parity 41/41.
Both actual import verdicts remain pending. Count remains 9/18.

### macOS takeover execution — 2026-09-07

Safely fetched and checked out `8dff7722462f51d5407cf520bc7d37629829ede9`;
both `3e2d415a` and `b0c3c184` are ancestors. The clean local-only graphics
commit `cef7fbb8` is preserved on `codex/macos-preserved-graphics-cef7fbb8`;
it is not applied to the takeover branch. Retired settings remain absent.

CI 34114497057 at exact `3e2d415a` was inspected without rerunning:
- Paired stable full jobs 101718052837 / 101718052815 SUCCESS.
- macOS native 101718227688 SUCCESS. Windows native 101718227707 passes
  Rust and native integration and is still in renderer validation.
- macOS Chromium artifact 10016353075, report
  `2026-09-07T11-02-40-837Z-darwin`, has 54 PASS and four expected force
  terminations in `chromium-macos-appkit-smoke`; package validation continues.
- Windows Chromium artifact 10016317719, report
  `2026-09-07T11-03-22-029Z-win32`, has 53 PASS, four expected terminations
  and one FAIL in `chromium-tabs-visible-seed`; the restart phase and package
  steps are not reached. MIXED-RECOVERY force/restart now passes.
- Shared checks 101718052475 fails two deleted-path documentation references;
  `8dff7722` already repairs them. Local full hygiene passes at the handoff SHA.
  The failed CI job is not relabeled successful.

Prior `fc69f683` CI 34111208046 macOS package job 101707644260 is now SUCCESS:
distribution payloads, packaged Rust updater transaction and packaged AppKit
Role black-box all pass. This is ephemeral CI trust, not production cutover.

The Windows detach failure reports
`ELECTRON_CHROMIUM_NEW_WINDOW_COMPENSATION_FAILED`. Its exact flow records
native reveal/focus applied at 2359 (window generation 72, topology 73), Core
Show completion at 2368, and a new placement projection at 2371 (topology 74).
The controller compares newly read Core/native snapshots after Show and
mistakes the in-flight placement for failed presentation, then attempts
compensation. Presentation must consume Core's terminal Show snapshot, whose
return is already conditional on the exact native effect completing. It now
checks unique window/tab ownership, exact one-tab membership, active tab and
visibility in that receipt without revoking success from later snapshots.
Admission, actual native acknowledgement, persistence, rollback and AppKit
ownership remain unchanged; failed native Show still rejects.

New platform-table regressions reproduce the placement race before the fix
and reject mismatched terminal ownership; related controller/transition tests
pass 2 files / 27 tests afterward. Typecheck, focused ESLint and diff checks
pass. macOS native checks on `8dff7722` (Rust unchanged by this TS repair):
Rust lint PASS; workspace tests 1677 PASS / five ignored, including the intact
256-round updater concurrent-winner test. Logs and downloaded CI artifacts:
`.desktop-e2e-artifacts/macos-takeover-8dff7722`. Repair native replay and full
JS/build validation remain pending. Affected paired journeys:
CHROMIUM-MACOS-APPKIT / CHROMIUM-WINDOWS TABS-VISIBLE-ACTIVATION-019,
GAME-WINDOWS-TABS-020 and RUNTIME-TAB-TOPOLOGY-009. Existing visible E2E
assertions are unchanged; focused regression coverage is lower-layer-covered.
Verified count remains 9/18 until the remaining native, import, hardware and
update gates are met. No publication, credential change or Tauri retirement.

### macOS workstation takeover — 2026-09-07

Current verified count is 9/18, not a macOS-only remaining queue.
Source candidate 3e2d415a7c3426979f0585543225510ae0cc23e4 includes
11a779d2 (View-only Windows input cleanup) and 3e2d415a (visible tab driver).
Both are pushed to codex/electron-chromium-v23-cutover. Fresh
[CI 34114497057](https://github.com/rion-tw/rion-studio-source/actions/runs/34114497057)
targets that exact source candidate; its native, full E2E, package and updater
results are pending. Do not rerun the original handoff jobs or retry unchanged
failures toward green.

Latest prior candidate fc69f683, CI 34111208046:
- macOS chromium-macos-appkit-smoke completes 54 PASS plus four expected force
  terminations (58 phases), artifact 10015095915. This validates the AppKit Stop
  full-projection ownership correction. macOS packaging advances through release
  artifacts to previous-version updater fixtures; updater outcome remains pending.
- Windows chromium-windows-smoke executes 49 PASS, one expected termination and
  one FAIL at chromium-mixed-recovery-force, artifact 10015019790. PointerAction
  retained a stale WebElement origin at native-runtime-tabs.ts:462 across a Core
  projection. Later phases and package/update steps were not reached.
- Both native jobs 101707810782 / 101707811091 and both stable desktop E2E jobs
  101707644477 / 101707644391 finish SUCCESS. Shared checks also pass.
  These receipts predate the View-only deletion and cannot validate that deletion.

The new driver retains visible primary pointer actions, exact native window
focus evidence and held Macro keyboard state. It reads fresh viewport coordinates,
checks the exact logical window and elementFromPoint hit target, then performs
pointer down/up. No retry, deadline extension or weaker domain assertion is added.
Affected Windows journeys are tab activation and MIXED-RECOVERY force/restart;
the macOS native tab branch is unchanged. Native replay remains pending.

Local Windows post-deletion validation:
- Rust lint PASS; Rust tests 1669 PASS / four ignored, including unchanged updater
  256-round parallel winner. Core 980/1, rion-node 50/1, updater 41/2.
- Tauri build, Electron production/dev build, actual addon retired-export guard
  and production desktop-E2E isolation PASS. Current local bundles are production;
  do not reuse them with an E2E skip-build option.
- View focused tests: seven files / 126 PASS. Shared pending-lane closure: four
  files / 66 PASS. Latest driver/adapter/docs guards: seven files / 60 PASS.
- Typecheck, full lint (zero errors, 23 existing warnings), full source hygiene,
  docs/context, Cargo dependency checks and git diff --check PASS.
  Coverage remains P0 70/70, P1 75/75, paired cutover 41/41.
- Full JS run is NOT green: 13 failed files, 439 passed, ten skipped; 16 failed
  tests, 3641 passed, 48 skipped. Eleven failures are symlink EPERM: current token
  lacks SeCreateSymbolicLinkPrivilege and Developer Mode is absent. Four original
  10000ms timeouts concern Vite React preamble, physical Macro modifiers, long-flow
  mind-map growth and WebApp preset selection; timing causes remain unresolved.
  One documentation graph failure from historical deleted-path links was fixed
  and focused verification passes. The complete suite was not rerun or relabeled.
  No OS privilege change, assertion skip or timeout increase was made.

Validation logs remain under the ignored local
.desktop-e2e-artifacts/windows-handoff-b0c3c184 directory:
view-only-lint-rust.log, view-only-test-rust.log, view-only-tauri-build.log,
view-only-electron-build.log, view-only-full-js.log, view-only-full-lint.log,
view-only-full-hygiene.log and cp09-closure-focused.log.
Do not transfer fixture secrets or assume local artifacts exist on the Mac.

| Remaining gate | Windows | macOS |
| --- | --- | --- |
| CP-04 / CP-08 projection and View-only input | Latest source native/full CI pending | AppKit Stop full profile passed at fc69; latest source regression pending |
| CP-10 Session/import | Session journeys passed; visible consented Chrome import still missing | Same import acceptance remains open |
| CP-11 / CP-12 capability and lifecycle | Real display, input and session-end evidence pending | Physical AppKit/display/lifecycle evidence pending |
| CP-15 full/hardware profiles | Latest full replay plus hardware-extended required | Latest regression plus hardware-extended required |
| CP-16 distribution/updater | NSIS hook compile fixed; full package/update replay pending | Fixture updater run pending; production-key cutover remains external |
| CP-17 / CP-18 retirement/completion | Tauri runtime must remain; ledger incomplete | Same gates; Mac success cannot replace Windows evidence |

Mac takeover: preserve existing local edits, safely fetch this branch and confirm
3e2d415a is an ancestor of the latest documentation handoff commit. Read AGENTS.md,
.agents/context.md, rion-task-router, this section and the original Windows
workstation handoff below; route the next files before editing. First inspect
CI 34114497057 and the still-running macOS packaging in 34111208046. Run required
native Rust checks and chromium-macos-appkit-smoke on the supported Mac for any
new native changes, then continue the remaining ledger gates from exact failures.
Windows local interactive replay was blocked by the Parallels prl_cc foreground;
do not treat elapsed time or Mac results as that missing Windows acceptance.
Keep Rust/AppKit data, topology and Macro authority. Performance diagnostics and
high-refresh settings stay removed. Do not publish, merge, change credentials or
remove the migration-gated Tauri runtime.

### CP-09 closure: nine of eighteen verified

CP-09 is now verified for the shared pending lane and DOM receipt decoder.
Both production adapters still import ChromiumTrustedInputPendingLane; native
sequence/focus evidence and Core scheduling remain outside that shared owner.
At exact 34a98f5b, both report journey inventories explicitly mark PASS for
MACRO-NATIVE-EFFECT-018, MACRO-BACKGROUND-TAB-004,
MACRO-STANDBY-RECOVERY-023 and MACRO-INPUT-RECOVERY-011 under each
CHROMIUM-MACOS-APPKIT / CHROMIUM-WINDOWS prefix (eight exact journeys).
Artifacts 10013584709 / 10013490282 and their profiles above are the evidence;
the macOS unrelated visible-tab Stop failure does not invalidate those
completed Macro journeys or turn its full profile green.

A fresh Windows focused run passes four files / 66 tests:
electron-chromium-trusted-input-pending-lane,
electron-macos-appkit-trusted-input-adapter,
electron-chromium-trusted-input-coordinator and
electron-chromium-role-trusted-input-preload.
The shared lane explicitly tests both platforms, duplicate/reentrant completion,
stale frames, partial native/DOM completion and cancellation/retirement failure.
CP-08 post-deletion native verification and CP-15 full/hardware gates remain
separate and open. Verified rows: CP-01, CP-02, CP-03, CP-05, CP-06, CP-07,
CP-09, CP-13 and CP-14 (9/18).

Post-deletion local Windows Rust completes 1669 PASS / 4 ignored: Core 980/1,
rion-node 50/1, updater 41/2 including the unchanged 256-round winner.
The three fewer tests are implementation-only tests in the retired HWND
modules. Tauri build passes (Rust build 2m45s); Electron build is running;
full JS validation has not started at this entry.

### Windows View-only cleanup after exact full-profile parity

The deletion gate now has 34a98f5b Windows native input (16 tests) and complete
chromium-windows-smoke (55 PASS + 4 expected terminations), including controlled
Reload, Macro terminal-cleanup seed/restart, background-tab and physical input.
Remove the obsolete child-HWND attachment/submission TS implementations, native
attachment/probe modules and lib.rs registrations, and implementation-only tests.
A fresh crate audit confirms windows-sys had only the removed SetParent consumer;
remove only rion-node's direct dependency/lock edge. Retain the windows crate,
native foreground and shortcut/F11 modules, AppKit input, and shared delivery.

The Windows adapter/contract now accept View identities exclusively. Existing
semantic adapter tests use View observations; new negative cases reject missing
or retired childHwnd owner kinds before preload arming. The stale-probe case
now exercises a regressed revision, because current View arming intentionally
allows a newer equivalent observation. Existing focus-change, exact geometry,
untrusted DOM, cancellation, deadline and hidden-input assertions remain.
Update two stale E2E source guards to inspect the active View admission and
submission modules. Seven focused files / 126 tests, typecheck and focused
ESLint PASS. Post-deletion Windows Rust lint passes (28.87s); tests/build and
native CI acceptance of this cleanup are still pending. The addon build now
rejects all four retired child-HWND exports in the actual compiled module.

The prior Core/NSIS candidate fc69f683 completes local Windows Rust:
1672 PASS / 4 ignored (Core 980 PASS / 1 ignored), unchanged updater 256-round
winner PASS. This is before the native-module deletion; do not merge totals.
Fresh CI 34111208046 targets fc69f683 exactly. Shared checks 101707644405 PASS;
Mac Chromium 101707644260, Windows Chromium 101707644415, paired stable
101707644477 / 101707644391 and native 101707810782 / 101707811091 remain
active at this observation. No original handoff CI was rerun.
Mac can resume at the latest pushed commit after the pending local cleanup
validation is recorded; future handoffs must distinguish these two candidates.

### AppKit Stop ownership and Windows NSIS corrections

Implementation commits: e139c1f7 (Core projection owner and regression),
09be3fdc (NSIS installer-only declaration and router coverage).
Full hygiene passes: source 2498, docs/context, unused analysis, Cargo
dependencies, P0 70/70 and P1 75/75, paired cutover parity 41/41 each.
Full workspace Rust results remain pending at this documentation commit.

The local Windows Core regression first exposes a test-helper gap:
effect_result did not recognize embeddedFollowRoleOwnership failures.
With that mapping repaired, the exact pre-fix AppKit Stop regression fails
Applied versus Indeterminate, matching macOS flow 649. The Core fix selects
an explicit internal close-projection owner. Only admitted AppKit Stop defers
the intermediate ownership projection to finish_appkit_projection; ordinary
Role/Workspace callers retain their survivor projection. The unused Role
persist_closed_tab flag was always false at all callers and is removed;
Workspace persistence policy is unchanged. Native host fences are unchanged.

Windows focused cargo test -p rion-core appkit_ passes 22 tests, including
Role Stop, surviving Workspace membership, explicit full-projection failure
(Degraded / topology committed / nativeApplied=false), and whole-window
cohort close. Windows pnpm run lint:rust passes (1m52s); the full workspace
test is running, not yet accepted. The affected visible journey remains
chromium-tabs-visible-seed under chromium-macos-appkit-smoke; its original assertion
is retained and native macOS replay remains mandatory. No new journey is
introduced; focused coverage is lower-layer-covered.

Windows Chromium job 101694497018 ultimately fails in NSIS uninstaller
compilation: warning 6001 for unused RionTauriV22InstallDirectory, with /WX
still enabled. Later package/update/black-box steps are skipped. Scope the
installer-only variable declaration with BUILD_UNINSTALLER, matching its
existing preInit use. Actual Windows NSIS 3.0.4.1 compile fixtures reproduce
before-uninstaller exit=1 / warning 6001, then after-uninstaller and
after-installer both exit=0 with /WX. No fixture executable is launched.
Evidence: windows-handoff-b0c3c184/nsis-hook-compile/*.log.
Existing packaging suite passes 1 file / 13 tests. This compile-only evidence
does not replace complete installer/updater acceptance. The router previously
did not classify build/*.nsh; add that scoped pattern to build-ci and verify
the explicit path now routes successfully. No credentials or publication.

### 34a98f5b paired full-profile evidence and exact AppKit Stop failure

CI 34107092799 Windows Chromium job 101694497018 completes
chromium-windows-smoke: 59 phases, 55 PASS and 4 EXPECTED_FORCE_TERMINATION,
zero FAIL. Artifact 10013490282 / 2026-09-07T09-39-16-918Z-win32 includes
Macro, settings/fonts, Session isolation/reset, recovery, visible tabs and
restart. Direct View ownership probe also passes; packaging/updater steps
are still pending completion and are not inferred from this E2E result.

macOS Chromium job 101694496918 / artifact 10013584709 /
2026-09-07T09-38-40-316Z-darwin executes 57 phases: 52 PASS,
4 EXPECTED_FORCE_TERMINATION, 1 FAIL (chromium-tabs-visible-seed).
Macro input recovery now passes with unchanged AppKit coordinate geometry.
The exact failing assertion at chromium-tabs-parity.e2e.ts requires no
runtime shell errors; it reports ELECTRON_MACOS_APPKIT_PHASE_PROJECTION_STALE.
Flow 621 admits Stop event 2555f0b4-f392-4baa-9084-82b664b82ef8;
destroy 623 completes at 637, then generic ownership projection 643 fails
at 644 because phase-only AppKit projection cannot change tab membership.
Receipt 649 is indeterminate with topology committed but nativeApplied=false.
A subsequent WindowState event's full projection succeeds at 655; that later
event cannot retroactively make the failed Stop successful. Core must let the
admitted AppKit Stop publish its exact full projection without an intermediate
phase-only membership change. Native fences and the E2E assertion stay intact.

At the same commit Windows native job 101694684990 passes Rust lint/test
(1671 PASS, 4 ignored) and native integration (8 files / 16 tests).
Its renderer step fails 3 tests: the stale scroll source guard fixed by
0da77bd8, plus 10000ms boundaries in production-promotion-readiness and
production-public-latest-recovery-cli; those two require separate diagnosis.
451 renderer files / 3672 tests pass, 10 files / 48 tests skip.
macOS native 101694685132 and paired stable full jobs
101694496979 / 101694497053 PASS. Local full ESLint at 0da77bd8 passes
with 0 errors and 23 existing react-refresh warnings.
These are separate exact results; neither failed job is relabeled green.
Local foreground UI remains gated by the recorded Parallels foreground
obstruction. Physical devices, consented Chrome import, external production
updates and CP-17 Tauri removal remain open.

### 34107092799 shared source guard correction

At 34a98f5b, shared checks job 101694496827 passes portable Rust and typecheck
but fails one of 3718 executed JS tests: the contained-fullscreen source guard
still requires the retired WebdriverIO scrollIntoView string. Other results:
461 test files / 3717 tests PASS; 2 files / 9 tests skipped.
The guard now follows scrollLayoutControlIntoView and requires the actual DOM
instant center scroll plus center hit-testing; original visible click, pointer
down/up, native upload, trusted input and exact popup assertions remain.
Focused suite passes 1 file / 7 tests, ESLint and typecheck pass.
Paired native/E2E jobs from this run continue independently; do not relabel
the failed shared job as green or restart it unchanged.

### CP-10 current native import restart evidence

Windows native job 101683102355 at 6ace94b2 passes
a_fully_verified_import_journal_allows_launch_without_new_role_evidence
(2026-09-07T09:11:53Z). Source inspection confirms this exact test retains
shutdown_checked()==Completed before reopening the v22 directory with v23;
it is the stronger boundary that previously exposed the Windows failure.
This current native result does not explain the historical timing failure or
replace visible consented Chrome import and full Session lifecycle E2E.
CP-10 remains open for those gates and the separately recorded local
foreground obstruction.

The background-parent contract cross-check at 53839b21 runs
chromium-view-focus-admission.test.ts and chromium-view-input-submission.test.ts:
2 files / 78 tests PASS. The source audit finds marker and directory iterator
handles leave scope before v23 role-tree publication, but identifies no
original OS error 5 lock owner; atomic publication and ACL policy are unchanged.

### 34a98f5b fresh CI and completed Windows native gate

Fresh CI 34107092799 targets 34a98f5b34c04895ffd5867bc8234f3942fd162b.
It is a new-source validation, not a rerun of either original handoff CI.
Run 34103441049 Windows native job 101683102355 is now fully PASS:
Rust lint/test (1671 passing, 4 ignored), unchanged 256-round updater winner,
Electron native integration 8 files / 16 tests, renderer 454 files / 3675
tests passing (10 files / 48 tests skipped), and Tauri build. macOS native
101683102221 and both stable full E2E jobs also pass on the same 6ace94b2.
The earlier local full-JS failures remain recorded; this is separate CI evidence.

Contract audit corrected stale text requiring a foreground parent for hidden
View input. Current validator, hidden admission tests and the paired native
owner probe instead preserve background-parent foreground identity without
focusing the target. This documents the already-implemented behavior, not a
new relaxation; Windows input removal and Tauri cutover gates remain unchanged.

### 2fc3b729 host foreground gate and production isolation

The exact launcher foreground precondition rejects before workspace launch:
artifact 2026-09-07T09-33-12-406Z-win32, log
windows-handoff-b0c3c184/session-launch-foreground-acceptance-x64.log.
Report remains FAIL but final flush and electronProcessExited=true now complete.
A subsequent read-only foreground inspection reports HWND 131140, PID 8380,
process prl_cc (Parallels), with an empty title. No runtime retry or forced
success was added. Local foreground-dependent acceptance awaits an interactive
Windows desktop; user was asked asynchronously to foreground the VM.
Do not classify this host obstruction as successful session isolation.

Focused Macro driver source tests (1 file / 3 tests), source hygiene (2498),
documentation and AI context checks pass. A fresh production Electron build
passes check:desktop-e2e-isolation; E2E instrumentation is absent in production.
These internal-only diagnostics require no new journey. Existing paired
Macro input-recovery and Role Session isolation journeys remain required.

### c93f6867 exact Windows Session launch focus diagnosis

Diagnostic-only observer 0c6cd8e4 reproduced the standalone isolation seed
failure at c93f6867, artifact 2026-09-07T09-28-52-380Z-win32; log
windows-handoff-b0c3c184/0c6cd8e4-session-transition-diagnostic-x64.log.
Native show sequence 2 is visible; native focus sequence 3 is visible but
focused=false/foreground=false. Both have windowGeneration 4 and topology
revision 6 matching the submitted transition. Thus this observation does not
support a stale-fence explanation: Windows did not grant native foreground.
The original Core refusal to acknowledge focus success is preserved.

The standalone isolation driver now establishes exact launcher PID/HWND
foreground through the existing native helper before visible launch/restore.
WebDriver still performs the visible menu/Show actions; no Core launch or
session mutation substitutes for user actions. Focused lint/typecheck pass;
native seed/restart acceptance is pending. macOS is unchanged by this Windows
test precondition. Core/native runtime source and Rust remain unchanged.

c93f6867 also requires DOM center hit evidence before native Role control
input and waits for trusted fixture navigation-requested before the original
Macro terminal assertion. This distinguishes native miss from domain failure;
macOS input-recovery acceptance remains pending.

### 009c4eb4 Windows font acceptance and 6ace94b2 paired CI

Windows local chromium-system-settings passes at
009c4eb4be0e0e069bd1d7aa0a713282164e5b07, including named/system font
CSS and Canvas application/reset and native diagnostics-export cancellation.
Artifact .desktop-e2e-artifacts/2026-09-07T09-12-23-954Z-win32;
log windows-handoff-b0c3c184/009c4eb4-system-settings-x64.log.

CI 34103441049 at 6ace94b2: full Tauri Windows 101682934758 and macOS
101682934917 pass; macOS native 101683102221 passes. Windows native
101683102355 has passed Rust lint/test; remaining steps were still running.
Windows Chromium 101682934832 passes 39 phases then fails system settings
at the covered English & Latin picker (875,14), matching the exact nested
scroll defect fixed and locally accepted at 009c4eb4. Artifact 10011979826,
report 2026-09-07T09-00-27-597Z-win32. All Macro cutover phases, workspace
recovery, Extensions persistence, upload and CRUD in those 39 phases pass.
Neither this partial CI nor isolated settings acceptance is a full-profile PASS.

macOS Chromium 101682935016 passes 29 phases then fails input recovery.
Artifact 10011727659, report 2026-09-07T08-59-04-877Z-darwin.
Fixture sequences 447-479 contain trusted canvas input but no
navigation-requested or active-navigation-failure target. The intended native
navigation click is not established; this is not proof of a Core Macro stop
failure. Exact native-point/hit-target evidence remains required.

Windows local chromium-role-session-isolation-restart at 009c4eb4 fails seed:
artifact 2026-09-07T09-20-32-234Z-win32; log
windows-handoff-b0c3c184/009c4eb4-session-isolation-x64.log.
Core browserWorkspaceLaunch 87/89 admitted, embeddedCreateTab 88/92
acknowledged 93/94; ownership effect ddae31b1-1446-4cc8-be0f-dbc0b881d43a
starts 97 and executor admission completes 109, with no terminal Core ack.
Both Roles remain launching and no Session is created. Clean exit rejects
CORE_SHUTDOWN_BROWSER_OPERATIONS_UNVERIFIED at 156-158; report retains
FAIL and electronProcessExited=false. Subsequent process inspection finds no
Electron process; that is not an authoritative successful flush. No unchanged
rerun, deadline increase, or relaxed shutdown/fixture assertion.

Ledger remains 8/18 verified. Full Chromium, session lifecycle, native input
retirement, packaging/update and physical-device gates remain open; retain Tauri.

### 5266ff87 Windows Macro close terminal ordering

Windows focused profile chromium-macro-cutover-terminal-cleanup-restart at
5266ff87 passes its physical-input prerequisite, then fails terminal-cleanup
seed at chromium-macro-cutover-cleanup.ts:210. Artifact:
.desktop-e2e-artifacts/2026-09-07T08-08-44-913Z-win32.
The immediate state read (Core flow 538/542) precedes browserWindowStop
completion (563); topology event 15 subsequently contains no windows or tabs.
The visible close click admits teardown but does not acknowledge its terminal
outcome. Capture the existing renderer journal cursor before closing each
window and await the absent-window Core projection; retain the exact window,
tab, trusted release, and neutrality assertions. No polling/deadline changes.
Typecheck, focused ESLint, and renderer-events.test.ts (1 test) pass.
Native seed/restart acceptance remains pending for this correction. Journey:
existing Macro terminal-cleanup; both platform profiles remain required.
### 64e1e1a9 Windows terminal cleanup accepted; visible submit correction

Windows local focused chromium-macro-cutover-terminal-cleanup-restart passes
at 64e1e1a96b933eaf6e8c912feece59cf4c081442: physical prerequisite, cleanup seed,
and fresh-process restart. Report journeys
CHROMIUM-WINDOWS-TRUSTED-INPUT-PHYSICAL-009 and
CHROMIUM-WINDOWS-MACRO-TERMINAL-CLEANUP-006 are PASS.
Artifact .desktop-e2e-artifacts/2026-09-07T08-16-04-165Z-win32;
log windows-handoff-b0c3c184/64e1e1a9-macro-terminal-cleanup-x64.log.
This does not close macOS cleanup or the full Chromium profile.

CI 34099004388 at 5266ff87: shared checks, renderer, sanitizer pass.
macOS Chromium job 101668899323 advances past workspace-slot selection but fails
chromium-entity-persistence-seed: submit button center (898,15) is covered by
app-content-window-drag-region. The shared submitEditor driver now scrolls the
visible button to the viewport center and waits for clickability before the same
WebDriver click. Enabled and resulting route assertions remain intact; no DOM
click or bridge mutation replaces the primary action. Both entity-persistence
platform profiles require acceptance. Focused ESLint, source hygiene (2495),
and coverage (P0 70/70, P1 75/75, paired cutover 41/41) pass.
### 2f766d23 Windows publication failure and persistence acceptance

Full Windows Chromium profile at 2f766d23 stops in chromium-extensions-seed:
visible submit reaches roleCreate:107, but Core rejects it at flow 108:
publish-role-tree / PermissionDenied / OS error 5. Artifact
.desktop-e2e-artifacts/2026-09-07T08-18-28-657Z-win32; log
windows-handoff-b0c3c184/2f766d23-chromium-full-x64.log.
The 13 deterministic role preconditions succeeded; creating the future role
after extension installation failed. No ACL cause or lock owner is established,
and no retry, permission relaxation, or successful full profile is claimed.
The failed application's exact final-flush phases completed and no Electron
process remained when subsequently inspected.

The independently targeted chromium-entity-persistence-restart at the same
commit passes seed and restart, validating the visible submit correction.
Artifact .desktop-e2e-artifacts/2026-09-07T08-21-25-288Z-win32; log
windows-handoff-b0c3c184/2f766d23-entity-persistence-x64.log.
CHROMIUM-WINDOWS-ROLE-PERSIST-003, WORKSPACE-PERSIST-004, MACRO-PERSIST-005
are PASS. This does not replace the failed full profile or macOS acceptance.
5266ff87 CI Windows Chromium 101668898969 confirms the same prior covered
submit failure as macOS, while Windows stable 101668899496 fails native hover
(root:macro). An isolated Windows encoded-PowerShell diagnostic confirms both
C# execution and try/finally execution; no helper-no-op explanation is claimed.
### 5d829a1b topology acceptance and failed-phase process fence

Windows chromium-macro-cutover-topology-restart passes physical prerequisite,
topology seed and restart at 5d829a1b7082c9b541e3e46ca159726026e62447.
Artifact .desktop-e2e-artifacts/2026-09-07T08-24-37-304Z-win32; log
windows-handoff-b0c3c184/after-2f766d23-macro-topology-x64.log.
macOS CI 34099004388 at 5266ff87: native job 101669048668 and stable full
desktop E2E 101668899092 pass. Windows native 101669048730 has passed Rust
and is still running its later native/build steps.

03c26581 adds bounded diagnostic capture to the Windows Tauri hover driver:
exact native acknowledgement, target CSS geometry/DPR, recent real mouse events,
and hovered elements on failure. Typecheck and focused lint pass. Native
diagnostic acceptance is pending; no hover parity is claimed.

The runner now observes final flush and existing native-process exit boundaries
for failed Electron phases too. Previously result.code === 0 bypassed that
fence despite the documented failed-fixture process leak and subsequent EBUSY.
A failed journey remains FAIL; shutdownError and processExited are separate
report fields, so cleanup failure cannot erase the primary journey failure.
No deadline extension, retry, forced kill or product lifecycle change is added.
Focused shutdown/user-data policy tests pass (2 files / 11 tests), typecheck,
focused ESLint and source hygiene (2498 files) pass. This is internal-only
test-harness work; native success/failure path observation remains required.
Exact-PID containment after an exit-boundary failure remains pending.
### 575c26a4 local native hover and publication-lock differential

Windows Tauri E2E build passes (6m14s), then focused smoke-seed passes at
575c26a44e0585db885a0b4b9ac21b89470020a2: 53.8s test, all native hover/30-frame
node and edge stability assertions retained. Artifact
.desktop-e2e-artifacts/2026-09-07T08-34-09-633Z-win32.
Logs windows-handoff-b0c3c184/5d829a1b-tauri-hover-diagnostic-build.log and
575c26a4-tauri-hover-diagnostic.log. This local pass does not explain the prior
hosted hover failure or establish full stable Windows acceptance.
Fresh CI 34101150931 targets 575c26a4; no old workflow was rerun.

An isolated Windows directory-rename differential reproduces OS error 5 when
a child marker file remains open, both without and with FILE_SHARE_DELETE.
The closed-handle control succeeds. Each case runs once in its own retained
ignored fixture; no retry or product permission changes. This shows the
original publication error is not sufficient evidence of an ACL defect.
The original lock owner is still unknown; current process is not elevated.
Reference: Microsoft Learn Moving Directories / Win32 file security and
access rights. The original full-profile failure remains open.
### e3383d17 build-output mismatch and boundary integration repair

The subsequent Windows app-CRUD dependency chain fails at the initial screen
in artifact .desktop-e2e-artifacts/2026-09-07T08-36-02-500Z-win32.
The immediately preceding Tauri build overwrote shared out/renderer with its
compatibility renderer (vite.tauri.config.ts / tauri.conf.json), while the
Electron main/preload remained intact. The old skip-build verifier checked only
those two bundles. The verifier now invokes the existing complete Electron
renderer purity/document gate before fixture startup. A focused regression
rejects a valid E2E main/preload paired with the Tauri renderer.
Rebuilding with RION_STUDIO_DESKTOP_E2E_BUILD=1 restores the pure Electron
bundle (38 sources, 3341534 bytes); log
windows-handoff-b0c3c184/after-e3383d17-restore-electron-bundle.log.
The failed report retains FAIL with electronFinalFlush=true and
electronProcessExited=true, providing the new failed-phase fence's native
observation. No process leak or product startup acceptance is inferred.

CI 34101150931 stops at the boundary gate because the new
desktopE2eElectronShutdown.mjs path was not registered. Add only that exact
migration-harness path to the existing token allowlist. verify:system-only
now passes; build-verifier/boundary tests pass (2 files / 14 tests), focused
ESLint, typecheck, source hygiene and coverage pass. Neither boundary policy
nor runtime/product assertions are weakened. These are internal-only harness
repairs; both full native profiles remain pending.
### 57798548 Windows twelve-phase acceptance and source-role driver repair

Artifact .desktop-e2e-artifacts/2026-09-07T08-41-49-203Z-win32 binds
57798548e64ef0a9b5a8ab998ef0d5653f3d947b. The app-CRUD dependency chain passes
entity persistence, Workspace Web slot, contained Web fullscreen, fullscreen
toolbar, Quick Access and settings persistence, each seed plus restart
(12 phases). All 12 report electronProcessExited=true.
Macro UI seed then fails in macro-source-role.ts:9 because Electron Chromium
does not provide Browser.getWindowForTarget for WebDriver getWindowSize.
The failed phase also records native process exit without converting FAIL.
Log windows-handoff-b0c3c184/57798548-app-crud-chain-x64.log.
Source-role layout now uses the already established exact-URL BrowserWindow
geometry path for compact 960x640 and restoration, retaining visible actions,
layout assertions and source-role execution/cleanup evidence.
Focused lint, typecheck, boundary gate and source hygiene pass. Macro UI,
native effects and subsequent CRUD phases remain pending.

CI 34101943696 targets 57798548 and passes the repaired boundary gate.
Earlier 5266ff87 Windows native job 101669048730 is fully SUCCESS, pairing
the already successful macOS native gate. At 575c26a4, Windows stable CI
101675671018 retains a hover failure. Its diagnostic proves trusted
mouseover/mousemove at (637,416) on root:macro with matching requested geometry
and DOM hover; active class remains absent. This excludes a simple wrong-point
or absent-native-input explanation. Establish an explicit native pointer move
outside the canvas before each tested enter, and retain relatedTarget in
diagnostics. This is an enter-transition precondition; the hosted failure
cause and acceptance remain pending, with all 30-frame assertions intact.
### 8f4095c2 compact source-role progression

Focused Windows macro-ui-restart at 8f4095c2 advances through entity seed/restart
and the repaired native geometry path, then fails the visible Loop button:
WebDriver element 4884 resolves to button=Loop and its center (756,15) is
covered by app-content-window-drag-region. Artifact
.desktop-e2e-artifacts/2026-09-07T08-51-19-246Z-win32; log
windows-handoff-b0c3c184/after-57798548-macro-ui-x64.log.
Scroll that exact control to center and require clickability before its
unchanged click. Focused lint and coverage pass; native replay remains pending.
The failed phase has a valid final flush but exceeds the existing 45-second
native process-exit fence; its failure is preserved. Subsequent read-only
process inventory finds no Electron process. No kill or extended wait is used.

Both Chromium CI jobs at 57798548 (101678154768 Windows, 101678154780 macOS)
reach the same source-role Browser.getWindowForTarget failure; both require
the 8f4095c2 geometry repair and later compact-loop acceptance. Windows stable
101678154604 retains the same observed trusted-input/absent-active-class
failure as 575c26a4, before the explicit outside-to-inside precondition.
### 4b7d1a06 Windows Macro UI accepted

Focused chromium-macro-ui-restart passes all four required phases at
4b7d1a06: entity persistence seed/restart and Macro UI seed/restart.
Macro UI seed takes 18.6s and restart 11.5s, with compact source-role authoring,
role selection, Start/Stop, persistence and unchanged cleanup assertions.
Artifact .desktop-e2e-artifacts/2026-09-07T08-55-42-228Z-win32;
log windows-handoff-b0c3c184/4b7d1a06-macro-ui-x64.log.
Both geometry and Loop control corrections now have local native evidence.
macOS Macro UI, hosted Windows hover precondition, remaining CRUD/native-effect
chain and full-profile acceptance remain pending.
### 6ace94b2 Windows eighteen-phase app-CRUD chain accepted

The focused chromium-app-crud-final-restart dependency chain passes 18/18
phases at 6ace94b206bc349aa9239d0d065d50781ade890c, all with final flush and
electronProcessExited=true. Artifact
.desktop-e2e-artifacts/2026-09-07T08-58-48-545Z-win32; log
windows-handoff-b0c3c184/6ace94b2-app-crud-chain-x64.log.
This is a focused chain within chromium-windows-smoke, not its complete profile
and not 18 closed ledger items.

The report marks 16 journeys PASS: Windows POPUP-012, ROLE-PERSIST-003,
WORKSPACE-PERSIST-004, MACRO-PERSIST-005, MACROS-UI-017, MACRO-NATIVE-EFFECT-018,
SETTINGS-PERSIST-006, FULL-CRUD-010, CRUD-REORDER-011, QUICK-ACCESS-015,
WORKSPACE-WEB-SLOT-016, WORKSPACE-WEB-FULLSCREEN-017,
WORKSPACE-WEB-SECURITY-POLICY-027, WORKSPACE-WEB-FILE-UPLOAD-028,
FULLSCREEN-TOOLBAR-012 and MACRO-SOURCE-ROLE-014 (CHROMIUM-WINDOWS- prefix).
Thus visible native upload/security, trusted key/three-button effects,
source-role execution, CRUD cleanup and fresh-process persistence are accepted
for this source on the local Windows host. Original publication OS error 5,
hosted hover, complete profile, macOS parity, physical devices and production
updates retain their outstanding gates. Fresh CI 34103441049 targets 6ace94b2.
### f6f8b8e5 font-picker failure identifies ineffective desktop scroll precondition

Focused Windows system-settings fails in artifact
.desktop-e2e-artifacts/2026-09-07T09-07-55-497Z-win32: English & Latin picker
at (1162,15) is covered by the fixed drag overlay despite the existing
scrollIntoView({block:"center"}) call. Report retains FAIL and confirms exit.
The captured WebDriver log and installed webdriverio 9.31.6 source show desktop
scrollIntoView sends a wheel action at viewport (0,0), computes deltas against
window.scrollX/Y, and waits for those window offsets only. Rion scrolls nested
content containers. The logged call succeeds without bringing this control
clear of the overlay.

Add an explicit layout-precondition helper using standard DOM scrollIntoView
with instant center alignment for the actual element and its scroll ancestors.
Use it for font picker/action controls, settings navigation, the repaired
workspace-slot/submit/Loop controls and mind-map layout precondition. All primary
clicks, native hover inputs and product assertions remain real WebDriver/native
input. This is not a scroll-gesture implementation or a runtime state mutation.
Typecheck, focused lint, migration boundary, source hygiene and coverage pass;
native font/settings and related layout acceptance remain pending for the fix.
No scroll completion is inferred from a window-offset polling loop.
## Status and ownership

`open` means implementation or audit remains; `probe` requires a bounded
equivalence experiment; `conditional` depends on that experiment; `gated`
requires existing migration/release evidence; `implemented` means code and focused
checks are complete while explicitly listed native acceptance remains; `verified` requires the stated
deliverable and its evidence. A documented retained adapter is a valid audit
outcome, not an implemented replacement. Never infer completion from API
availability, a filename, elapsed time, or a portable mock.

Rust owns domain state, filesystem policy, stores, topology, Macro scheduling,
and domain operation terminality. Electron owns Chromium handles and translates
authoritative events into revision-fenced Core effects and receipts. Prefer
standard Web APIs, then public Electron APIs, then shared Rust facilities, with
minimal native adapters where equivalent behavior is unavailable. AppKit native
windows, tabs, gestures, geometry, focus, fullscreen, and trusted input remain
required. Do not introduce an engine selector or public automation transport.

The UI-driver follow-up also verifies production bundle isolation: an initial
check intentionally rejects the currently built E2E bundle; rebuild Electron
main/preload/renderer with RION_STUDIO_DESKTOP_E2E_BUILD=0, then the production
Cargo graph/config/bundle isolation gate passes. Restore the E2E bundle with
RION_STUDIO_DESKTOP_E2E_BUILD=1 for subsequent native journeys. This is bundle
isolation evidence, not a production-addon or package acceptance claim.
Logs: 33c-ui-driver-production-bundles.log and 33c-ui-driver-e2e-bundles.log.
### 33c3738c native acceptance, exact UI failures, and workstation obstruction

Windows local Rust 1.98.1 x64 full workspace tests pass: 1,671 passed, 0 failed,
4 explicitly ignored; Core 979 tests / 192.20s and updater 41 tests / 1.81s.
The terminal_receipt_create_new_commit_has_exactly_one_concurrent_winner test
retains all 256 rounds. The log is ca7a0b3a-test-rust-x64.log: it started before
the E2E/bootstrap-only 33c3738c commit, with unchanged Rust sources. Windows lint
already passed. macOS ca7a0b3a CI 101656222944 actually runs and passes Rust lint,
1,679 tests (5 ignored), and native integration 14 passed / 2 platform skips.
Do not accept that run's Windows pnpm-driven job greens, which were no-ops.

Local Windows Electron 43.6.0 / Chromium 150.0.7871.250 native integration at
33c3738c passes 8 files / 16 tests in 93.37s, including exact hidden/sibling and
background-parent View input ownership, trusted DOM delivery and focus retention.
Log: 33c3738c-native-integration-x64.log. The E2E addon/build and renderer purity
check also pass (33c3738c-build-chromium-e2e-x64.log).

CI 34096644201 binds 33c3738c7b1bfb7cc62183af082d1fcfce1d6f6d. The repaired
Windows bootstrap runs actual scripts. Windows Chromium artifact 10009032625 /
2026-09-07T07-42-22-412Z-win32 passes Extensions seed/restart, shell smoke,
physical input, Game CRUD seed/restart, then fails entity persistence seed.
Both Chromium jobs (Windows 101661672889, macOS 101661672817) reject a workspace
slot click under the fixed titlebar drag overlay (x=801, y=20 Windows / y=9 Mac).
Use the shared clickWorkspaceSlot UI driver to scroll the exact slot to the
viewport center, require clickability, and perform the visible click. Apply it
to the same slot-selection pattern in persistence, workspace, isolation, CRUD
and recovery journeys; never dispatch a synthetic DOM click or remove the overlay.
Affected paired journey families include ROLE-PERSIST-003, WORKSPACE-PERSIST-004,
MACRO-PERSIST-005, FULL-CRUD-010, CRUD-REORDER-011, APP-RECOVERY-015,
WORKSPACE-WEB-SLOT-016, WORKSPACE-WEB-FULLSCREEN-017 and MIXED-RECOVERY-021,
plus their stable app-journey coverage. Native replay remains pending.

macOS stable full job 101661672820 passes at 33c3738c; macOS native job
101661840847 passes. Windows stable 101661672944 fails the newly added
MACROS-UI-001 hover gate (root:macro never gains its active class). Artifact
10009152776 / 2026-09-07T07-42-14-572Z-win32 shows the visible measured graph.
Use a Windows Tauri native pointer driver after the authoritative main-focus
receipt, binding PID, client origin/size and the unobscured DOM target; verify
native foreground/root HWND and exact cursor readback. Preserve all 30-frame
active-node, visibility, geometry and edge assertions. Chromium and AppKit paths
retain their existing drivers. C# declarations compile locally; TypeScript,
focused lint, source hygiene (2,495 files) and coverage pass. Native hover
acceptance is pending. The caption diagnostic's five focused tests also pass.

Local Macro terminal-cleanup attempt 2026-09-07T07-53-05-966Z-win32 fails its
physical prerequisite before any cleanup seed. Diagnostic-only follow-up
2026-09-07T07-57-13-017Z-win32 records expected probe HWND 1574310 / PID 18648,
actual HWND 16385086 / PID 20736, hitTest=2, point=(935,189). The obstructing
PickerHost.exe owns a Shell_SystemDim overlay; subsequent exact process-window
inspection identifies a Windows Security system dialog. It is not a Rion View
failure and has NOT been attributed to the pnpm reproduction. The owner was
asked to complete/dismiss the system dialog; no credentials or system-dialog
controls were operated. Local input replay is pending removal of that observed
obstruction. The diagnostic preserves the original caption rejection.

The isolated workspace layout assertion from the earlier all-file Vitest failure
passes once with its original assertion (1 passed / 8 filtered skips, 6.99s;
ca7-layout-failure-isolated.log). Keep the all-file run failed; an isolated pass
neither proves a contention cause nor replaces the outstanding Windows gate.
### Windows all-file Vitest qualification on the upgraded toolchain

The local all-file run ends at 434 passing / 19 failing / 10 skipped files,
3,626 passing / 42 failing / 48 skipped tests (1,121.34s). It ran alongside the
cold Windows Rust build on the ARM64 VM using x64 tools. Exact failures include
EPERM during symlink fixture creation, existing 10-second test deadlines,
secondary ENOTEMPTY cleanup after timed-out writers, and one workspace layout
assertion (Single versus Nine grid). These remain failed evidence, not an
accepted host-performance explanation. No timeouts, isolation, assertions, or
symlink security policy were weakened. The Linux shared CI job 101656032208
passes its complete checks at ca7a0b3a; this does not replace Windows evidence.

The subsequent bootstrap/navigation edits pass adjacent workflow/coverage tests (2 files, 28 tests, 28.18s), TypeScript, focused ESLint,
source hygiene (2,494 files), and unchanged coverage thresholds. The real native
pnpm command is selected through PATH and executes its child; a mismatched pin
is rejected. Remaining Windows all-file failures require isolated attribution
and an actual native acceptance run after the higher-priority Rust/input gates.
### Exact ca7a0b3a failures: Windows pnpm no-op and seeded empty pages

The isolated Windows npm installation reproduces the action's pnpm 12.3.4
bootstrap with allowed pre/postinstall scripts. Its generated .bin/pnpm.ps1
calls ../pnpm/pnpm without .exe: --version returns empty output and exit 0.
The same installed pnpm/pnpm.exe returns 12.3.4. The native entrypoint also
executes a child Node command with the expected exact output. Add
scripts/selectWindowsPnpm.ps1 before setup-node caching in CI: select the
installed native executable, require the repository-pinned version and actual
child execution, then add its directory to GITHUB_PATH. No trust fixture,
credential, package version, or gate assertion is replaced. Evidence lives in
pnpm12-npm-shim-* and pnpm12-native-github-path.txt under this handoff directory.

Windows stable job 101656032228 reports success but runs no desktop script and
uploads no artifacts. This is a no-op, NOT Windows E2E acceptance. All pnpm-driven
Windows checks in CI 34094846253 need the repaired bootstrap before acceptance.

macOS artifact 10008366946 / 2026-09-07T07-19-44-811Z-darwin proves Extensions
seed/restart and shell smoke PASS with final flush and exact process exit. It
then fails Game CRUD seed primary navigation at chromium-game-crud.e2e.ts:64.
Screenshot shows the intended empty Roles page (No roles yet / Create role),
which intentionally has no PageHeader. The same newly added unconditional header
assertion fails stable macOS smoke seed (artifact 10008407183).

Use shared seed-navigation assertions for exact empty Roles, Workspaces and
Macros headings/create actions; require no header on those known empty pages,
and retain visible headers on other pages. Preserve visible sidebar clicks,
route acknowledgement, absent kickers and absent Play category. This corrects
the incoming c270d0b3 test's precondition mismatch without changing product UI.
Affected journeys: DASHBOARD-NAV-001 and both Chromium PRIMARY-NAV-008 entries;
manifest descriptions now state empty-page outcomes. Updated native acceptance
is pending; previous AppKit cohort and Windows Macro fixes remain to be reached.
### Electron 43.6 native revalidation and CI bootstrap failure — 2026-09-07

Candidate ca7a0b3ae364bb45bf9780cb4b6dba80a38f6b57 preserves remote 44cef4f3
and the three rebased fixes. Windows Rust 1.98.1 x64 lint passes (16m13s,
CARGO_INCREMENTAL=0); full workspace tests are running. Full JavaScript lint
passes with 0 errors / 23 warnings. Documentation and context validation pass.
The all-file Windows Vitest run is still collecting symlink and timed-out test
failures; no assertion or deadline has been relaxed, and it is not a green gate.

New CI 34094846253 binds ca7a0b3a. Windows Chromium job 101656032137 stops
before E2E: the fixture-version bash step reports
RION_STUDIO_ELECTRON_PACKAGE_VERSION: unbound variable. The preceding PowerShell
pnpm run prepare:electron-updater:ci step returns success without script output
or the fixture receipt. macOS executes the same preparation successfully.
Investigate the pnpm 12 native binary / Windows npm-generated shim boundary;
this is not evidence of a fixture signer or product updater failure. Do not
rerun this unchanged candidate to try to obtain acceptance.

CP-01 incremental source audit of the preserved Extensions feature identifies
Session.extensions getAllExtensions/loadExtension/removeExtension with exact
extension-unloaded acknowledgement, Core-issued per-role leases, and a separate
nonpersistent extension-store Session plus unprivileged WebContentsView.
Core retains package/configuration/lease authority; Electron owns native handles.
The new CHROMIUM-WINDOWS-EXTENSIONS-001 and
CHROMIUM-MACOS-APPKIT-EXTENSIONS-001 seed/restart journeys are present in both
profiles. Their current-candidate native acceptance remains CP-11/CP-15 pending;
source inspection and 41/41 declared parity do not establish it.
### Concurrent remote feature/toolchain baseline preserved — 2026-09-07

Before pushing the validated local fixes, fetch discovered remote 44cef4f3 with
Extensions, Macro source-role mode, UI changes and stable dependency upgrades.
The safety ancestry check stopped the push. Rebase preserved all remote work
and replayed only the three unpublished local fixes without conflicts:
05558a1c -> 4b324460 (held modifiers), a02fe4ff -> c6a23df8 (AppKit close cohort),
b49e2c39 -> d86b1081 (stable viewport acknowledgement). Earlier artifacts remain
at their original source revisions; they are not acceptance of this merged
feature/toolchain baseline. No PR merge, release publication or credential edit
was performed by this handoff work.

New required runtime: Node 24.20.0 x64 (official archive SHA-256 verified), pnpm
12.3.4, Rust 1.98.1 x86_64-pc-windows-msvc, Electron 43.6.0 (PE machine 0x8664).
Use the isolated RionValidation/corepack-x64 cache and Node tool-directory pnpm
shim: the system ARM64 Corepack cache otherwise selects ARM64 optional packages.
Frozen dependency rebuild preserves pnpm-lock.yaml. Typecheck and three focused
files / 13 tests pass under the new toolchain. The first Windows Rust gate
failed before compilation because rion-platform aliased windows 0.62.2 twice
as windows and windows-webview2 after the upstream upgrade aligned versions.
Use its one existing windows dependency for the optional WebView2 probe; retain
system-webview-probe and its target cfgs, with no Tauri removal. Compile-only
correction; updated native gates and exact pinned-Electron input probes remain
required. Logs: remote-44cef4f3-* under windows-handoff-b0c3c184.

New-baseline validation progress: TypeScript and focused ESLint pass; the three
runtime-focused files (13 tests) and architecture boundary file (5 tests) pass.
Source hygiene passes 2,492 tracked files after extracting the unchanged
rendererLogCommand helper from main/index.ts, which upstream Extensions changes
had grown to 65,550 bytes (over the 65,536-byte limit). This extraction changes no
runtime behavior. E2E coverage passes P0 70/70 and P1 75/75; both Chromium cutover
profiles retain 41/41 parity. Coverage counts are automation declarations, not
native journey acceptance. CI 34089874671 at 121ec958 is complete: both native
Rust jobs pass (macOS 101641170380, Windows 101641170382); macOS stable passes,
while macOS Chromium and both Windows E2E jobs retain the failures documented
below. The current 43.6 baseline native/full gates remain pending.
### Stable Windows ownership claim waits for document viewport — 2026-09-07

CI 34089874671 stable Windows job 101641016111 / artifact 10006740224 fails
p1-cross-domain-topology-force at cross-domain-runtime.e2e.ts:999: the reclaimed
Role document viewport is absent. The driver waits for running ownership and a
fixture session event, then immediately asserts DOM/controller dimensions. Those
receipts do not acknowledge viewport application. Capture the native event cursor
before the visible Role-slot claim and consume the existing exact-label
windows-role-viewport-observed helper before reading the assertion snapshot.
Retain every bounds/parent/visibility/zoom assertion and the existing event wait
policy. Typecheck and focused lint pass; stable Windows full native replay is
pending. Journey RUNTIME-TAB-TOPOLOGY-009, adjacent MACRO-OWNERSHIP-TRANSFER-010.
This E2E correction does not remove or change the gated Tauri runtime.
### AppKit whole-window retirement uses the Core cohort barrier — 2026-09-07

At 05558a1c, Windows physical input and keyboard cutover pass (6.1s / 43.9s),
including the unchanged held-Shift assertion and exact final flush/process exit.
Artifact 2026-09-07T06-34-54-694Z-win32; log held-modifier-keyboard-x64.log.

CI 34089874671 macOS artifact 10006918721 records 50 passed phases, four expected
force terminations, then tabs visible seed fails waiting for dormant state.
Controlled Reload, paired Web navigation/restart and all Macro cutover phases
pass at 121ec958. Exact tabs flow: native closeWindow 757 admits generation 3 /
revision 35; first DestroyTab 759 completes at 771; FollowRoleOwnership 775 sends
two tabs while the native AppKit projection retains the original cohort. It
rejects at 776 with ELECTRON_MACOS_APPKIT_PHASE_PROJECTION_STALE; receipt 781 is
indeterminate, so the remaining tabs never close. The AppKit event now invokes
the existing Rust whole-window close path, retaining the original event identity,
generation/revision/cohort and the exact native acknowledgement barrier before
logical RemoveWindow. No phase-only projection is interleaved with individual
destructions. Failure attempts the remaining exact destroys but never removes
an unacknowledged logical window. The new three-Role regression failed before
repair and passes after repair, including first-destroy failure. Logs:
appkit-cohort-{before,after}-x64.log. Windows Rust formatting/Clippy and full workspace pass: 1,646 tests / three existing ignored; Core 955 (190.97s), updater 41 (1.13s), unchanged 256-round concurrency. Logs: appkit-cohort-{lint-rust,test-rust}-x64.log. Fresh macOS
native tabs acceptance are required; no stale phase assertion was relaxed.
Journeys: CHROMIUM-MACOS-APPKIT-GAME-WINDOWS-TABS-020 and
TABS-VISIBLE-ACTIVATION-019; CP-04 remains pending paired final acceptance.
### Exact held-key cancellation in the Windows tab hover driver — 2026-09-07

At 121ec958, native Windows Electron integration passes all eight files / 16
cases (75.97s); log web-admission-native-integration-x64.log. Complete local
chromium-windows-smoke artifact 2026-09-07T06-15-41-026Z-win32 records a clean
worktree, 29 passed phases, then chromium-macro-cutover-keyboard fails at its
unchanged trusted Digit4 / shift=true assertion (received shift=false, sequence
609). Fresh CI 34089874671 Windows Chromium job 101641015956 independently fails
the same assertion at sequence 597 after passing the earlier shortcut boundary.
Neither is a full-profile pass. WebdriverIO 9.30.1 moveTo() invokes perform()
without skipRelease; its default releases all action sources. The Windows tab
hover added in 0c0a285d therefore releases the held Shift before returning to the
Role. Local WebDriver evidence contains these releaseActions at 06:30:45.393Z
and 06:30:49.078Z between continuity key-down and Digit4. Use the explicit visible
pointer move with perform(true), preserving the existing key source. Keep native
foreground/identity checks, visible activation and all Macro assertions intact.
Journey: CHROMIUM-WINDOWS-MACRO-MODIFIER-CONTINUITY-008, adjacent keyboard/blur
journeys and Windows tabs activation. Focused native replay remains pending.
CI stable Windows separately fails p1-cross-domain-topology-force at its exact
Role document viewport check; native macOS validation and shared checks pass.
The stable failure and macOS Chromium verdict remain independent obligations.
### Global Web navigation releases the Core mutation lane — 2026-09-07

The CP-04 audit found embeddedLoadWebSurfaces still awaited native navigation in
the shared effect admission lane after the equivalent Role path was corrected.
Return an event-bound continuation, reserve exact opening Web identities, reject
duplicate pending creation and managed Role aliases, and include opening surfaces
in exact tab retirement. Readiness must retain the original tab and host records;
late completion cannot resurrect a retired surface. Cancellation retains exact
native close acknowledgement and the original failure. Four focused tests cover
both platforms with pending navigation, newer ownership admission, duplicate
rejection and close-before-readiness. The adjacent executor/Role tests passed
82 cases; typecheck, focused lint and source hygiene pass. Lower-layer-covered
admission race; existing paired WORKSPACE-WEB-SLOT-016 and WEB-ONLY-024 remain the
native acceptance routes, including gated loading and restart. No new deadline,
polling, native owner replacement or Tauri removal. Fresh native profiles remain
required; CP-04 is not closed by these unit tests.
### Passive AppKit window-state supersession and Windows tabs acceptance — 2026-09-07

At 0c0a285d, Windows chromium-windows-smoke tabs visible seed/restart passed
(94.5s / 28.1s), with empty shell-error journals, final flush and exact process
exit. Artifact: 2026-09-07T05-56-36-912Z-win32; log:
windows-handoff-b0c3c184/native-tab-foreground-tabs-x64.log. This accepts the
Windows TABS-VISIBLE-ACTIVATION-019 / GAME-WINDOWS-TABS-020 repair; matching
macOS and the latest complete Windows profile remain pending.

CI 34087008739 at cbdcbeac finished with both native validation jobs, both stable
desktop E2E jobs, shared checks, renderer build and sanitizer passing. Chromium
package jobs failed earlier as recorded below. Exact macOS controlled Reload
flow: windowState adapter sequence 1 at generation 3 / revision 5; newer Core
ownership completes at flow 124; projection revision 6 is rejected at 127;
receipt 133 incorrectly reports failed against current revision 8. Extend the
existing passive Layout supersession rule to WindowState, requiring the exact
superseded error, no committed topology, unchanged generations, non-regressing
revisions and at least one strictly newer revision. User actions remain excluded.
The focused regression failed before repair and passes afterward for Layout and
WindowState with no advance, same-generation advance and generation replacement.
Windows Rust formatting/Clippy and full workspace pass: 1,645 passed / three
existing ignored, Core 954 in 182.60s, updater 41 in 1.49s including unchanged
256-round concurrency coverage. Logs: appkit-window-state-{before,after,lint-rust,
test-rust}-x64.log under the handoff evidence directory. Lower-layer-covered race;
existing MACOS-APPKIT-RUNTIME-TAB-RELOAD-031 retains its empty shell-error assertion
and requires fresh native CI. CP-04 remains implemented pending native parity.
### Windows visible tab driver requires native foreground — 2026-09-07

At 2ca9b21f, artifact 2026-09-07T05-51-42-331Z-win32 passed seed and restart's
previous reorder/selection boundary, then exact native topology asserted focused
true against false after a WebDriver tab/page click. Membership, visibility and
revision were coherent. The Windows helper clicked a DOM button in a background
native parent without bringing that parent forward (unlike the AppKit driver).
Capture PID in the launcher, bind the visible tab's native UIA close control to
its exact HWND, use the existing native foreground helper, then click the visible
tab button. The driver does not invoke a runtime action or change production
focus policy. Retain focused=true and every existing deadline. Focus/control
helper tests and typecheck/lint/hygiene verify the driver boundary; native replay
remains required for TABS-VISIBLE-ACTIVATION-019 / GAME-WINDOWS-TABS-020.

### Windows tabs seed accepted; inactive drag selection corrected — 2026-09-07

At 64dcfdc5, artifact 2026-09-07T05-45-15-608Z-win32 passed tabs visible seed
(64.9 seconds), empty shell-error journal, final flush and exact process exit.
Restart restored/distributed/moved its tabs, then failed the unchanged post-drag
selection assertion. Core embeddedTabReorder 1069 completed at 1097; persisted
order was Gamma/Alpha/Beta but activeTabId remained Beta. No activation command
followed the Windows drag. Route selection of the dragged tab through the
existing Core action only after successful reorder, retaining native generation
and visible membership checks before selection; a closed window cannot be
activated. The focused expected-call regression failed before repair; 24 adjacent
chrome/renderer tests pass, including retirement during reorder. Typecheck, lint
and source hygiene pass. AppKit selection remains native-owned. Update Windows
GAME-WINDOWS-TABS-020; restart and full profile remain pending.

### Reopen topology assertions consume accepted evidence — 2026-09-07

At 393affb8, artifact 2026-09-07T05-41-01-163Z-win32 accepted the reopened
three-tab cohort, then a redundant fullscreen inspector read failed at Core 56 /
native 55, generation 39, identical membership/presentation/preferences. Run the
unchanged exact native topology/display assertions against the owner/inspection
already captured inside the existing showSavedWindow admission. Preserve its
55-second deadline and generation-increase assertion; no added wait or weakening.
Typecheck, focused lint and source hygiene pass; native tabs replay remains pending.

CI 34087008739 at cbdcbeac has independent earlier failures: Windows Chromium
job 101632871695 times out its native shortcut helper in chromium-shell-smoke;
macOS Chromium job 101632871762 completes controlled Reload actions but its
shell-error journal contains MACOS_APPKIT_CHROMIUM_PROJECTION_SUPERSEDED.
Artifacts 10005647362 and 10005718589 are downloaded under the handoff evidence
directory for exact diagnosis. These jobs were not rerun. Neither accepts later
local tab changes or permits legacy runtime deletion.

### Exact hover and post-move completion races — 2026-09-07

At cbdcbeac, artifact 2026-09-07T05-35-12-072Z-win32 completed all visible seed
actions and retained three shell errors: hideToolbar submitted projection 12
against 13; queued hideToolbar read a destroyed BrowserWindow; a redundant
post-presentation exactTabOwner read observed the detached target at Core 74 /
native 73 (generation 72, identical membership). The native close stream repair
is confirmed by absence of its two earlier errors. Fullscreen hover is now
submitted only when that presentation can change; exact native close cancels
queued hover presentation. Move completion validates unique tab ownership and
visibility in the existing post-show observation, without a second inconsistent
post-terminal observation. Four regressions failed before repair and all 33
adjacent tests pass afterward, including both platforms for post-move placement.
No stale user-action fence, ownership assertion or empty shell-error journal is
removed. Paired TABS-VISIBLE-ACTIVATION-019 / GAME-WINDOWS-TABS-020 still need
native replay; manifest descriptions retain those obligations.

Windows Rust checks at cbdcbeac passed: formatting/Clippy; workspace tests 1,645
passed / three existing ignored, Core 954 in 211.94s, updater 41 with its unchanged
256-round concurrency test. Logs: role-publish-diagnostics-{lint,test}-rust-x64.log
under windows-handoff-b0c3c184. Fresh CI 34087008739 targets cbdcbeac; both native
jobs and Chromium package profiles were still running when dispatched.

Artifact 2026-09-07T05-32-10-877Z-win32 failed before E2E in addon copy with EBUSY.
The prior failed fixture PID 15504 was still alive despite final flush; its exact
command line and creation time matched 2026-09-07T05-21-36-270Z-win32. Only that
fixture and its repository Electron children were terminated. The next build
copied the addon successfully. The failed-E2E cleanup path does not wait for
native process exit (the runner currently fences successful phases only); this
remains a separate cleanup task, not a successful clean-exit acceptance.
The original publish-role-tree failure did not recur during this diagnosed
replay, so its OS cause remains unproven; no rename retry or ACL relaxation exists.

### Paired component acceptance and first-role publication diagnostic — 2026-09-07

CI 34081543779 at 718dc83abef08da489620d3bd268fe8d1bf350dc has now completed:
Windows native 101617756987 and macOS native 101617756979 are SUCCESS, as are
both stable desktop profiles and shared checks. Chromium package jobs still fail
at the later tabs seed; they are not full-profile passes. Downloaded reports
10004161262 (Windows) and 10004119340 (macOS) both record PASS for system settings,
settings persistence seed/restart, Role isolation/reset seed/restart, Macro
terminal-cleanup seed/restart, and app/mixed/window recovery. Both system-settings
records assert retiredPerformanceSettingsAbsent and cleanExit; adjacent visible
settings/font/diagnostics journeys and native provider probes supply CP-02/06/13
acceptance. Native path/import regressions plus persistent restart close CP-03's
shared-path scope. These four component rows are now verified (8 of 18 total),
without declaring later runtime edits or CP-10 consented import accepted.
Reports identify the source commit above and worktreeDirty=true; this is preserved
as a reported build condition, not represented as a clean-worktree release gate.
Profiles: chromium-windows-smoke and chromium-macos-appkit-smoke; journeys
CHROMIUM-{WINDOWS,MACOS-APPKIT}-SYSTEM-SETTINGS-013, FONT-APPLICATION-033,
DIAGNOSTICS-EXPORT-029 and the corresponding persistence/session journeys.

At 692b4750, local artifact 2026-09-07T05-21-36-270Z-win32 did not reach tabs:
Core roleCreate:47 rejected at publish-role-tree, with no role persisted.
The previous diagnostic discarded the OS rename error; retain only its kind and
numeric code (no paths), preserving atomic publication failure and exact cleanup.
This diagnostic is internal-only, adds no retry/deadline or permission bypass,
and does not establish the cause of that separate filesystem failure.

### Native close stream and remaining terminal errors — 2026-09-07

At 3aa30075, Windows artifact 2026-09-07T05-11-12-221Z-win32 completed the
visible tabs seed actions including native resize/minimize/restore, but its final
empty-shell-error assertion rejected five errors. The closed stream incorrectly
called the fullscreen observation reader after BrowserWindow destruction. Making
the fake native fullscreen accessor reject after destruction reproduced `failed`
instead of `closed`; reading the controller's retained Core fence fixes that
regression (60 host/chrome tests pass). Viewport validation/cache is extracted to
windowsRuntimeHostGeometry to restore the 64 KiB host-factory limit; hygiene and
typecheck pass. Toolbar stale-command diagnostics now retain command/projection
identity, and new-window diagnostics retain Core/native generation/revision and
membership; native errors retain their stack in the process log. These diagnose
the remaining command race without suppressing the shell error journal. Paired
journeys CHROMIUM-{WINDOWS,MACOS-APPKIT}-TABS-VISIBLE-ACTIVATION-019 and GAME-WINDOWS-TABS-020 remain pending; no input or Tauri deletion gate is
released by this focused evidence.

### Minimized native viewport preservation — 2026-09-07

At 4c572d72, artifact 2026-09-07T05-06-16-754Z-win32 passed physical resize and
exact layout comparisons, then failed show-after-minimize. Core-flow 2019
rejected native content bounds before restore could be submitted. A minimized
Windows host may report an empty native content rectangle; that is not a new
viewport. Retain the exact last unminimized native content bounds per host and
skip minimize-only layout/placement publication. Restore/resize replaces it with
fresh native bounds; invalid bounds outside minimize still reject. The new
regression failed before repair; 60 host/chrome tests passed afterward. No generic
invalid-geometry fallback, polling, or deadline change was added. The native
geometry subsection and paired tabs journeys remain pending.

### Reopened generation belongs to the accepted snapshot — 2026-09-07

At 8c0fe409, artifact 2026-09-07T05-03-50-998Z-win32 passed the exact reopen
predicate, then an extra one-shot generation inspection overlapped the next
placement projection (Core 56 / native 55, generation 39 and equal ownership).
Return generation from the already-accepted showSavedWindow snapshot and retain
the greater-than-old-generation assertion against that same evidence. This
removes an inconsistent second observation, not an assertion or a native fence.

### Resize probe document prerequisite — 2026-09-07

At 791c65b4, artifact 2026-09-07T05-01-55-033Z-win32 reached resize but the new
helper read the desktop E2E PID bridge after switching into the sandboxed runtime
chrome document, which intentionally has no such bridge. Capture PID in the
launcher before switching, then use only the runtime close control in native
chrome. Preserve that preload isolation; do not expose the debug bridge there.

### Windows native resize driver — 2026-09-07

At c592bcc7, artifact 2026-09-07T04-58-41-423Z-win32 advanced through the repaired
cross-window move, then failed in the resize driver before any resize gesture:
ChromeDriver window/rect invoked unsupported Browser.getWindowForTarget.
Use the exact visible tab close control to resolve its owning HWND, verify PID
and foreground, read GetWindowRect in per-monitor DPI awareness, and drag its
real OS border with DIP deltas converted by GetDpiForWindow. The visible action
and subsequent exact layout/resize-event assertions remain unchanged; no debug
resize command replaces the user action. This E2E-only repair still awaits native
acceptance in the paired tabs 019/020 journey (Windows geometry subsection).

### Windows moved-tab layout target — 2026-09-07

Focused tabs at 7f0d2314, artifact 2026-09-07T04-54-15-191Z-win32, passed initial
loading admission, all three Role launches, whole-window close/reopen, selection
and reorder. It then failed moving Beta into the existing target window.
Core-flow 1843 rejected the ownership projection because the tab layout still
carried the source target while resolving against the destination native host.
Project the tab specification with the already-fenced destination hostTarget
before layout, and commit that same specification only after native projection.
The strengthened move regression failed with window-1 versus window-2 before
repair; 56 projection/layout/executor tests passed afterward. Paired tabs journeys
019/020 remain pending overall; this is partial progress, not a profile pass.

### Role load admission releases the projection lane — 2026-09-07

At c8dfc9d1, artifact 2026-09-07T04-43-34-681Z-win32 retains the actual fence
failure: Core window generation 3 / revision 6 versus native generation 3 /
revision 5, with equal tab membership, display, bounds and target. Core-flow 142
accepted browserWindowsRuntimeWindowPlacement while embeddedLoadRoles 138 held
the application effect lane. Its revision-6 projection could execute only after
load completion 763, which the E2E gate deliberately withheld. Earlier observer
and ChromeDriver issues were real but did not resolve this product dependency.

Managed Role loading now completes admission after paths/native creation are
submitted, returns the existing Core event-continuation contract, and releases
the mutation lane while the exact navigation remains pending. Opening owners
stay separate from ready Role snapshots and input eligibility. Duplicate loads
are rejected; close/destroy can reach the exact opening generation; a retired
owner cannot be resurrected by late navigation completion. Core cancellation
still closes the exact surface and no navigation deadline changes. The global
Web loader is separately unchanged and must be audited against the same boundary.

102 focused tests passed across executor, bootstrap, coordinator and paired
Role load admission cases. The tests prove a revision-8 projection completes
while navigation is pending, duplicate admission rejects, and late completion
after native tab destruction rejects without resurrection. Existing cancellation
assertions now await the continuation terminal. Paired TABS-VISIBLE-ACTIVATION-019
and GAME-WINDOWS-TABS-020 remain the native acceptance journeys; pending until
an exact-source native run completes.

### Gated loading diagnostic transport — 2026-09-07

At a2ed80eb, focused tabs artifact 2026-09-07T04-38-43-221Z-win32 crossed
initial Core/native admission. The after-click body.getText command at
04:39:23.038 blocked ChromeDriver until native load retirement at 04:40:08.256;
fixture transport cancellation followed at 04:40:08.280. The later fixture
waiter timeout is a consequence, not a missing initial launch. During the gate,
retain the exact Core/native tab inspection and read Windows loading controls
with the existing native UI Automation helper. Defer body diagnostics until
outside that gate. No native navigation deadline or loading assertion changes.

### Initial Core observer prerequisite — 2026-09-07

Commit 1d9811c7 passed Windows Electron native integration: 8 files / 16 tests
(75.79 s), log close-selection-native-integration-x64.log. Focused tabs at
2026-09-07T04-35-31-475Z-win32 still failed the initial loading gate. Inspection
showed the second missing prerequisite: Core ownership was bound only by the
first effect acknowledgement, while initial loading held that batch open.
Bind both actual CoreAddonClient and runtime at successful bootstrap; identify
each missing owner in inspection errors. This follow-up is E2E-only and retains
all runtime, identity, revision, and loading assertions. Native tabs still pending.

### Native tabs failure attribution after 718dc83a — 2026-09-07

CI 34081543779 retained exact clean-SHA reports: Windows artifact 10004161262
has 51 PASS / 4 EXPECTED_FORCE_TERMINATION / 1 FAIL; macOS artifact 10004119340
has 50 PASS / 4 EXPECTED_FORCE_TERMINATION / 1 FAIL. Both failed tabs-visible-seed;
these are partial profile results, not complete platform acceptance.

Windows loading admission inspection reported no observed runtime owner. The
E2E observer discovered its owner only through the first snapshot, while the
first gated navigation needed that observer before release. Bind the actual
bootstrap owner at successful startup; retain exact Core/native inspection.

macOS Core flow 737 accepted closeWindow. DestroyTab 739/751 released background
Alpha, but native selection changed from surviving Gamma to Beta. Core projection
758 retained Gamma and correctly rejected the mismatch at 759; receipt 765 was
indeterminate. Preserve a surviving active tab when no explicit Core successor
is supplied. Both-platform regression tests failed before the repair; all 60
close-selection/executor/AppKit-projection tests passed afterward. The native
journey now explicitly proves the complete three-tab cohort and last-tab
selection before whole-window close. Affected paired journeys: TABS-VISIBLE-
ACTIVATION-019 and GAME-WINDOWS-TABS-020. Native validation remains pending for
this repair and focus-arming commit ecd9f128. No fence or deadline was weakened.

### Windows user focus during Macro arming — 2026-09-07

`718dc83a` passed focused topology seed/restart with its physical prerequisite
(artifact `2026-09-07T03-57-25-179Z-win32`). Its local complete profile then
recorded 30 PASS / 1 FAIL at topology seed, before visible Stop became enabled
(`2026-09-07T04-00-42-048Z-win32`). Raw View observations 217/218 and 219/220
retain role `8890f463-5f65-4bee-a9ee-715ebb3a6df0`, generation 1, binding 1,
parent, geometry and zoom; only user focus moved from Role View 4 to launcher 1.
Browser action 40 was superseded during arming at Core-flow 466; cleanup 41
applied with input neutrality. This is an arming/admission race, not a Stop UI
selector failure or the earlier clock mismatch.

The follow-up validates the same owner/frame/visibility/geometry across arming,
accepts only non-regressing exact View probe revisions, then binds submission
to the newly validated user focus. Complete pre/post native focus observation
and trusted DOM receipts remain mandatory. Legacy HWND validation is unchanged.
Both foreground and hidden arming regressions failed before the repair;
95 adapter/host/submission tests passed afterward, including changed geometry
and forged post-submission focus rejection. No deadline or E2E assertion changed.

Fresh CI [34081543779](https://github.com/rion-tw/rion-studio-source/actions/runs/34081543779)
was dispatched once for pushed `718dc83abef08da489620d3bd268fe8d1bf350dc`.
Both stable full desktop jobs (101617629343 Windows, 101617629362 macOS), portable
checks, and macOS native 101617756979 passed. Windows native 101617756987 passed
Rust and native Electron steps and was in renderer validation at observation.
Chromium jobs failed at `chromium-tabs-visible-seed`: Windows 101617629229 did
not observe loading Role admission; macOS 101617629271 did not reach dormant
after close. Downloaded artifacts 10004161262 and 10004119340 are retained under
`.desktop-e2e-artifacts/windows-handoff-b0c3c184/ci-718-*` for exact diagnosis.
The original two handoff CI runs were not restarted. No release workflow ran.
### Windows first native topology receipt — 2026-09-07

`6af00a91` passed focused Macro UI seed/restart (4 phases including entity
prerequisites, artifact `2026-09-07T03-33-27-712Z-win32`) and topology seed/restart
with physical input prerequisite (3 phases, `2026-09-07T03-35-56-759Z-win32`).
The complete `chromium-windows-smoke` run at that clean SHA reached topology
restart and failed restoring window `c8e00000-0000-4000-8000-000000000023`
(`2026-09-07T03-37-31-156Z-win32`). This is a distinct launch-cache failure.
The first Workspace completed at Core-flow sequence 205; restore rejected at
216 with `ELECTRON_CHROMIUM_LIVE_WINDOW_TARGET_UNAVAILABLE`.
Native observation 2 had the newly created host with generation/revision 0/0;
subsequent observations bound the same host to generation 4, revisions 6 and 9.
The launch cache permanently discarded the exact pending admission on that
initial 0/0 observation, before its first authoritative topology receipt.

A focused regression reproduced the rejection after the exact native receipt
arrived. The repair retains only the initial 0/0 pending admission, validates all
other source/attempt/display/Web identities, and still refuses reuse until an
exact positive Core/native generation and revision agree. It adds no retry,
polling, deadline, or inferred success. All 47 launch-coordinator tests passed.
Affected paired journeys are `CHROMIUM-*-MACRO-OWNERSHIP-TRANSFER-010` and
`CHROMIUM-*-MACRO-MULTIROLE-005`; the existing adjacent topology restart performs
the visible Show and exact restored-cohort assertion. Native E2E remains pending
for this follow-up. Legacy Windows input and Tauri deletion remain gated.
### Windows Core clock validation — 2026-09-07

The follow-up to `6f1468f1` uses the same exported Rust Core scheduler clock for
Electron trusted-input admission, native submission, and receipt observation on
both platforms. AppKit retains its native input authority and calls that same
Core clock. No timestamp clamping, deadline extension, or receipt-order assertion
was introduced. JavaScript diagnostic observation timestamps are explicitly
labelled as a separate clock.

Windows x64 on this ARM64 Parallels workstation passed Rust lint (40.36 seconds),
all 1645 Rust tests (3 ignored), including the unchanged 256-round updater
publication race, and native integration (8 files / 16 tests, 82.27 seconds).
Focused coordinator/runtime tests passed (2 files / 24 tests). Full hygiene passed
with P0/P1 70/70 each and both Chromium parity profiles 40/40. Logs are under
`.desktop-e2e-artifacts/windows-handoff-b0c3c184/macro-clock-*`.
The paired `CHROMIUM-*-MACROS-UI-017` journeys now name the exact clock boundary.
Native macOS and complete Windows profile acceptance remain pending; these
checks do not close physical-host, update, or migration-removal gates.
## Windows workstation handoff — 2026-09-07

The owner is moving execution to a Windows workstation because hosted CI is
slow. Continue the entire 18-task ledger locally where Windows evidence is
available; do not restart the research or treat this as a new smaller goal.
The macOS agent stops editing after this handoff to avoid concurrent writers.

### Repository and current implementation

- Repository: `https://github.com/rion-tw/rion-studio-source`; branch:
  `codex/electron-chromium-v23-cutover`. Fetch the latest branch, preserve any
  Windows-local work, and verify `08dae0ce` and `7ec46086` are ancestors before
  testing. The handoff itself is a later documentation-only commit.
- No uncommitted implementation remains on the sending workstation. Closed
  rows are CP-01, CP-05, CP-07 and CP-14 (4/18); the execution register below
  remains authoritative for every other deliverable and gate.
- `7ec46086`: hidden Chromium View admission accepts a background parent
  without acquiring focus. Visible admission still requires real native focus.
  Tests and the production View-owner native probe cover hidden key/middle
  input under foreground/background parents. Main files:
  `src/electron/main/chromiumViewFocusAdmission.ts`,
  `scripts/probeChromiumInput.cjs`,
  `tests/electron-chromium-view-owner.native-integration.ts`.
- `46f831fc`: Windows ACL traversal tolerates descendants disappearing with
  native errors 2/3, preserving all other errors, root protection and reparse
  exclusion. The unchanged updater 256-round concurrent publication test must
  pass; do not retry failed rounds toward success.
- `2e139861`: Core projects a surviving Chromium window after Role/Workspace
  tab close. Windows topology seed/restart passed after this repair.
- `e85d2ea5`: stable recovery tests observe the committed Core window-definition
  event from a pre-action cursor. Both stable full profiles passed at that SHA.
- `efbff1c7`: migration restart test uses checked shutdown. This exposes an
  earlier shutdown failure directly; it does not fix its underlying cause.

### Evidence already obtained and active CI handles

Latest runtime repair `7ec46086` passed local macOS typecheck, lint (23 existing
warnings), full hygiene, 452 Vitest files / 3644 tests, Rust lint and 1650 Rust
tests (4 ignored), Tauri build, Electron E2E build, production Electron build
and production E2E isolation. No local desktop UI profile ran in that batch.
CP-05 completion audit at `08dae0ce` additionally passed 44 font-related tests.
The documentation-only handoff passes full hygiene, lint (23 existing warnings),
452 Vitest files / 3644 tests (167.86 seconds) and `git diff --check`.

| Exact candidate / run | Evidence or live handles at handoff |
| --- | --- |
| `7ec46086` / [34068441192](https://github.com/rion-tw/rion-studio-source/actions/runs/34068441192) | Windows Chromium job 101581254621 in shell E2E; Windows stable 101581254735 in full E2E; Windows native 101581357691 in Rust workspace tests. macOS Chromium 101581254826, stable 101581254848 and native 101581357690 queued. Re-read status before using it. |
| `46f831fc` / [34067927527](https://github.com/rion-tw/rion-studio-source/actions/runs/34067927527) | Windows native 101579982133 in Rust workspace tests; Windows stable 101579879735 SUCCESS. Windows Chromium 101579879720 failed before the later hidden-admission repair. macOS jobs were still live. |
| `e85d2ea5` / [34067494537](https://github.com/rion-tw/rion-studio-source/actions/runs/34067494537) | Stable macOS 101578732099 and Windows 101578732120 SUCCESS; both reports bind exact SHA, full tauri-v22 profile, 29 PASS + 3 EXPECTED_FORCE_TERMINATION phases. |
| `2e139861` / [34067205038](https://github.com/rion-tw/rion-studio-source/actions/runs/34067205038) | Windows Chromium 101577953053: 32 PASS including topology seed/restart, then terminal-cleanup-seed failure. Core browser-action receipt rejects hidden admission with ELECTRON_VIEW_BACKGROUND_FOCUS_INVALID; fixed in `7ec46086`, native acceptance still pending. |
| `1422ea67` / [34063144726](https://github.com/rion-tw/rion-studio-source/actions/runs/34063144726) | Earlier paired native input gates passed; macOS Chromium report has 52 PASS + 4 expected terminations. This is older evidence, not latest-candidate acceptance. |
| `a20bddec` / [34061202087](https://github.com/rion-tw/rion-studio-source/actions/runs/34061202087) | macOS Chromium job 101561949187 SUCCESS including fixture package/update and packaged black-box. Production publication is not covered. |

Existing `/tmp/rion-*` paths in historical entries belong to the Mac and are
not transferred. Retrieve reports from GitHub Actions instead, e.g.
`gh run download 34067494537 -n desktop-e2e-Windows-34067494537-1 -D <local-dir>`.
Inspect `report.json` commit/profile/runtimeTarget and each phase; `always()`
probe success after a failed E2E step does not make the job successful. Do not
cancel/restart these live runs solely because they are slow, or merge receipts
from different SHAs into a single-candidate acceptance claim.

### Recommended Windows execution order

1. Read root/scoped `AGENTS.md`, `.agents/context.md`, the task-router skill and
   routed context. Use pinned Node/Rust versions and `pnpm install --frozen-lockfile`.
   Read `docs/e2e-coverage.json` and adjacent harness setup before driving UI.
2. Run `pnpm run lint:rust` then `pnpm run test:rust` on Windows; retain full
   output. This directly checks the ACL repair and the 256-round updater test.
   Run Cargo builds sequentially to avoid contention. Address the first actual
   failure from its exact native evidence rather than rerunning until green.
3. Run `pnpm run test:electron:native-integration`. Inspect the native View-owner
   test specifically: all eight direct View key/middle samples, including four
   hidden-admission receipts, must preserve foreground identity and trusted DOM
   evidence. The raw Chromium API probe without the addon is not a substitute.
4. Run `pnpm run test:e2e:desktop:chromium:windows` on an interactive unlocked
   Windows desktop. Start with terminal-cleanup-seed/restart diagnosis if needed,
   then complete the whole profile. A focused `--phase` run is not full-profile
   acceptance; inspect its declared prerequisites before using it. Preserve
   visible UI primary actions and exact Core/native/journal receipts.
5. Close the outstanding Windows settings/font/removal, Macro, storage/import,
   navigation/security/upload and recovery journeys from actual full results.
   Run `pnpm run test:e2e:desktop:full` for retained Tauri compatibility after
   shared/native changes. Use physical mixed-DPI/multi-display profiles only
   when the required real displays are present; otherwise leave those gates open.
6. After exact input parity, audit/remove the obsolete Windows HWND attachment
   implementation under CP-08: crates/rion-node/src/windows_chromium_input_attachment.rs (now retired),
   `windows_chromium_input_probe.rs`, associated lib exports,
   src/electron/main/windowsChromiumInputSurfaceAttachmentCoordinator.ts (now retired),
   `chromiumOwnedInputSubmission.ts` and legacy input-contract/adapter branches.
   They are still compiled even though product bootstrap no longer uses them.
   Preserve the current View input owner, required foreground reader/F11 and
   AppKit adapter. Do not delete before the listed native and journey gates pass.
7. Continue every remaining register row, including package/updater validation.
   CP-17 legacy Tauri deletion still depends on the migration/release gates;
   local Windows success alone cannot satisfy macOS or real updater transactions.
   Record exact commits, commands, journey IDs, profile results and open gates.

Manual Electron E2E build in PowerShell, only when needed separately from the
profile runner: set `$env:RION_STUDIO_DESKTOP_E2E_BUILD = '1'`, run
`pnpm run build:electron`, then remove the variable in a `finally` block.
`pnpm run build:e2e:desktop` builds Tauri; adding `--driver=electron` does not
select Electron. Before production isolation validation, remove that variable,
run `pnpm run build:electron`, then `pnpm run check:desktop-e2e-isolation`.
A Tauri E2E build can overwrite renderer output, so restore Electron production
output before interpreting isolation results.

### Unresolved failures and boundaries to preserve

- Core import restart: Windows native job 101572210336 / run 34065004149 failed
  `a_fully_verified_import_journal_allows_launch_without_new_role_evidence`:
  state-worker shutdown timed out after 3 seconds, then APP_INSTANCE_LOCKED.
  `database/state/section_01_schema_version.rs` checkpoints WAL and closes its
  connection before acknowledging shutdown; AppCore retains the instance lock
  while terminality is unproven. A 5-second SQLite busy timeout versus the
  3-second drain is only a hypothesis. If reproduced, identify the exact phase;
  do not enlarge deadlines, bypass the lock or retry reopen to hide it.
- macOS intermittent local Web chrome load stall remains unexplained despite
  later full passes (run 34059403980, job 101557109768). It is separate from
  Windows admission. Retain event diagnostics and the AppKit host requirement.
- macOS local UI execution was obstructed by UserNotificationCenter, which CUA
  refused to access. No dialog content was read or bypassed. This is not a
  Windows blocker; do not infer new macOS UI evidence from Windows execution.
- Performance diagnostics and high-refresh settings were explicitly retired;
  do not reintroduce either. General log/GPU/runtime diagnostics export stays.
  Rust retains domain/data/topology/Macro authority; renderer uses typed bridge.
- No production publication, merge, credential changes or release-gate waiver
  is authorized by this handoff. Keep ad-hoc macOS / unsigned Windows installer
  policy and mandatory updater signatures/hashes. Do not enable disabled
  publisher/finalizer jobs or discard required AppKit/data adapters.

## Windows workstation execution — 2026-09-07 (in progress)

The receiving checkout was clean on `main`; fetched and created the tracking
branch `codex/electron-chromium-v23-cutover` at
`b0c3c184fb1d2d30d66175c67780a6108dde7184`. Confirmed `08dae0ce`, `7ec46086`
and the handoff commit are ancestors. No local changes were discarded.
This workstation is Windows **ARM64**, distinct from hosted Windows x64.
Local tools: SHA-256-verified Node 24.18.0 ARM64, pnpm 11.13.0, Rust
1.97.0-aarch64-pc-windows-msvc; frozen-lockfile installation passed.

| Candidate / check | Observed result |
| --- | --- |
| Local `b0c3c184`, `pnpm run lint:rust` | PASS, Windows ARM64; 1m31s. Full log: `.desktop-e2e-artifacts/windows-handoff-b0c3c184/lint-rust.log`. |
| Local `b0c3c184`, `pnpm run test:rust` | PASS, Windows ARM64: 1,642 tests, three existing ignored; Core 952 tests in 240.04s. The unchanged 256-round `terminal_receipt_create_new_commit_has_exactly_one_concurrent_winner` and `a_fully_verified_import_journal_allows_launch_without_new_role_evidence` passed without retries. Full log: `.desktop-e2e-artifacts/windows-handoff-b0c3c184/test-rust.log`. |
| Local `b0c3c184`, focused Vitest | PASS: projection/coordinator 43 tests, View focus admission 20 tests. Native Electron integration is running next. |
| Local `b0c3c184` + runtime-read repair, native integration | PASS: eight files / 15 tests, 111.23s, Windows ARM64 Electron 43.4.1 / Chromium 150.0.7871.224. Production View-owner probe includes all eight trusted key/middle samples, four applied hidden admissions, and preserved foreground identity. Log and native reports are under `.desktop-e2e-artifacts/windows-handoff-b0c3c184/`. |
| Run 34067927527, job 101579982133 | Final API verdict SUCCESS, including Rust workspace, native Electron integration, renderer tests and Tauri build. macOS native 101579982173 and both stable desktop jobs also SUCCESS; both older Chromium package jobs FAILED. |
| Run 34068441192, job 101581254621 | FAILED at `chromium-workspace-web-only-seed`, before Macro terminal cleanup. Downloaded artifact 9999811663; `report.json` binds `7ec46086`, `chromium-windows-smoke`, `chromium-v23-windows`. |

The latest Chromium failure is `execute/async` script timeout in
`chromium-workspace-web-only.e2e.ts:344`, reading `getEmbeddedRuntimeState`
after visible tab close. Core flow records successful `embeddedTabStop` and
empty browser/logical windows at revisions 27/28; native topology records an
empty final snapshot. Local Web chrome reached `did-finish-load`, then exact
destruction. This is not evidence of the earlier local chrome load stall or
hidden View admission failure. Investigate the snapshot/projection read fence
against local reproduction; do not lengthen the deadline or weaken equality.
The post-failure direct View probe has eight received samples and four applied
hidden-admission receipts, but does not close the full journey. The profile has
10 PASS phases before its failure. Windows stable job 101581254735 subsequently
completed successfully; Windows native job 101581357691 passed Rust tests and
entered native Electron integration on the next read.
Neither cited CI run was restarted. macOS, x64, hardware and real updater gates
remain separately required; CP-08 deletion and CP-17 removal remain gated.

The runtime-read repair adds `browserStatuses` to the coordinator's ordered
projection progress fence. `browser_runtime_snapshot_without_persistence`
publishes this authoritative event after the final tab isolation/removal, even
when neither another SQLite `stateChanged` nor another native effect follows.
The former reader ignored this event. Two platform-table regressions failed on
the original implementation and passed after the repair; all 65 focused
projection/focus tests passed. The reader still validates exact Core/native
identity and topology; no polling, deadline extension or equality relaxation was
added. Both WORKSPACE-WEB-ONLY-024 journeys now additionally require the empty
renderer topology from a pre-close event cursor, alongside the existing runtime
read and restart assertions. Typecheck and coverage passed (P0/P1 100%); the full
Windows Chromium profile is running against the qualified working tree.

The first ARM64 full-profile attempt
`.desktop-e2e-artifacts/2026-09-07T00-30-34-572Z-win32/report.json` failed at
shell startup, before any UI journey: ChromeDriver's log records
`UPDATE_PLATFORM_BUILD_MISMATCH`. `crates/rion-node/src/updater.rs` deliberately
accepts Windows x86_64 builds only. Preserve that product architecture check;
prepare pinned x64 Node/Rust/Electron on this ARM64 Windows host instead of
claiming ARM64 product support. This is a toolchain correction, not a retry of
the CI Web-only failure or a native acceptance pass. x64 execution under Windows
ARM64 emulation must be distinguished from hosted x64 and physical hardware.

Full hygiene initially found `/bin/ps` unresolved on Windows. It is the existing
absolute macOS OS executable in `darwinProcessGroupLiveness.mjs`, not a missing
JavaScript dependency. Added that exact path to Knip `ignoreUnresolved`; full
hygiene then passed, retaining existing export/type warnings and all other
dependency checks. No runtime implementation or assertion was suppressed.

Final run 34068441192 status: macOS native 101581357690, Windows native
101581357691 and both stable desktop jobs 101581254848/101581254735 SUCCESS.
macOS Chromium 101581254826 FAILED at `chromium-tabs-visible-seed`:
`closeAndReopenSavedWindow` did not observe the exact window become dormant.
Artifact 10000177203 was downloaded locally. Unlike the Windows snapshot wait,
the macOS inspection keeps returning a live two-tab native host; Core records
no close command before test cleanup. The helper caller omitted its already
known `gameWindow.id`, causing the macOS helper to discover a target through
whole-window Accessibility traversal. Pass that exact ID on both platforms;
this removes an ambiguous targeting path but is not yet proof of the macOS
failure's root cause or a successful close. Keep the native dormant assertion
unchanged and require a new macOS verdict for TABS-VISIBLE-ACTIVATION-019 /
GAME-WINDOWS-TABS-020. No AppKit product adapter was replaced.

Pinned x64 Node 24.18.0 and Rust 1.97.0 are now installed for the supported
Windows product build. Preserved the ARM64 dependency tree under ignored
`.desktop-e2e-artifacts/toolchain-backup/node_modules-arm64`; a clean x64
`pnpm install --frozen-lockfile` passed without lockfile changes. Merely running
install over the ARM64 tree did not supply x64 optional native bindings.
Windows x64 `pnpm run lint:rust` passed in 15m29s under ARM64 emulation
(`lint-rust-x64.log`). The source repair is now committed as
`72bc7da318faff7849772dc292e4a1c69a1f0b50` (local commit; no release or merge).
The matching working-tree x64 `pnpm run test:rust` passed: 1,642 tests, three
existing ignored, 11m50s cold compilation and 185.48s Core execution. The unchanged
256-round updater concurrent-publication test passed in this run, and the exact
import-journal restart test also passed. Log: `test-rust-x64.log`. x64 typecheck
passed (`typecheck-x64.log`). This is a four-core Parallels ARM virtual machine;
these x64-emulated Windows results are not physical mixed-DPI/display evidence.
The sequential x64 native-integration run uses a separate `x64-native/` report
directory so that the earlier ARM64 reports remain intact.
`pnpm run test:electron:native-integration` passed all eight files / 15 tests
in 93.13s. The production View-owner report has all eight `received` direct
key/middle samples, all trusted DOM events, preserved foreground identity, and
four `applied` hidden admissions including background parents. The log is
`native-integration-x64.log`; input, shortcuts, View-owner, fullscreen and font
JSON reports are in `x64-native/`. Full `chromium-windows-smoke` execution is
now running against `72bc7da3` plus this documentation-only evidence update.
The current run root is
`.desktop-e2e-artifacts/2026-09-07T01-13-12-592Z-win32`. Its first 12 phases
passed, including both `chromium-workspace-web-only-seed` and restart. This
directly exercises the formerly failing last-tab close read and the additional
empty renderer-topology event assertion for
CHROMIUM-WINDOWS-WORKSPACE-WEB-ONLY-024. No deadline or assertion was relaxed.
The full attempt subsequently stopped with **30 PASS / 1 FAIL** at
`chromium-macro-cutover-topology-seed`; terminal-cleanup was not reached.
After Role ownership transfer, fixture sequence 668 records trusted `KeyS`
keydown, but the consumer keyup required at `chromium-macro-cutover-topology.ts:178`
never arrives. Core flow rejects browser-action-16 with an invalid terminal
receipt, then browser-action-20 with incomplete native submission; their cleanup
actions expire before preload arming. This is distinct from hidden-parent
admission and from the repaired Web-only read. The native View remains focused
and attached in the final observations. Preserve the consumer release assertion.

The E2E-only `trustedInputDiagnosticsObserver.ts` now retains bounded in-memory
raw adapter/submission receipts and timing fields, returning original promises,
receipts and exceptions. It writes on `will-quit`, outside input delivery.
Typecheck passed. A focused topology-seed run is collecting this missing failure
evidence; it is not a retry intended to establish full-profile acceptance.
The focused run `.desktop-e2e-artifacts/2026-09-07T01-35-17-545Z-win32`
completed its topology UI assertions, but the runner failed with `ENOENT` for
`chromium-windows-trusted-input-physical/windows-input-physical-probe.log`.
Its selected-phase dependency list omitted the native prerequisite that the
unchanged validator requires. Added platform-aware prerequisite selection,
preserving seed/restart order and avoiding duplication in full profiles; the
eight-test Macro cutover suite passed. This fixes the focused harness, not the
original input failure. All captured receipts in that focused UI run were
applied; the original partial-submission failure remains unresolved.
Next, the independent terminal-cleanup restart selection runs physical input,
cleanup seed and cleanup restart with the diagnostic observer installed.
Its first build was stopped by a missing adjacent `.d.mts` export, which is now
added. The following attempt
`.desktop-e2e-artifacts/2026-09-07T01-41-56-974Z-win32` failed the physical
prerequisite before cleanup: `SYSTEM_TRUSTED_INPUT_FOREGROUND_DEADLINE` while
admitting the probe's visible Role. No cleanup verdict was produced. Added
failure-only exact View observation to that probe and asked whether the VM
remained unlocked and free from competing desktop input. Full hygiene passed,
including unchanged P0/P1 100% and paired cutover 40/40 targets. A diagnostic
attempt now retains the missing foreground facts; neither intermittent UI
failure is considered repaired by instrumentation alone.
The diagnostic physical attempt returned `parentForeground: false` while the
View remained attached/visible and Electron reported its content focused.
The exact admission guard correctly rejected that combination. The standalone
probe is spawned by WDIO's background Node process. Windows explicitly restricts
[programmatic foreground activation](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setforegroundwindow).
The probe now establishes its initial foreground precondition with one visible
caption click, fenced by PID, HWND, native hit-testing, occlusion and per-monitor
DPI coordinates. It happens before the first foreground sample; no click or focus
repair is added during hidden/background delivery. Native verification of this
precondition passed in the subsequent focused run below. Future UI runs stream their original runner output,
avoiding separate PowerShell log-reader launches during focus-sensitive work.

The next focused attempt, `.desktop-e2e-artifacts/2026-09-07T02-07-46-063Z-win32`,
passed the physical prerequisite and failed terminal-cleanup seed before Window B
could show. Core effect 505 acknowledged Window A's native destruction with an
empty topology; snapshots 512/514/516 retained Window A and its old tab despite
empty role ownership. No Core effect was rejected. Windows `browserWindowStop`
had omitted the Core logical-window removal performed by the AppKit close path.
The working correction commits removal after exact native acknowledgement, with
generation/revision/tab membership checked under the Rust authority barrier.
Visibility quarantine uses that same commit. New platform-explicit Rust tests
cover successful stop, saved configuration, surviving topology, failed destroy
and a changed topology during acknowledgement. The paired terminal-cleanup
journeys now explicitly assert absence of Window A and its tabs before launching
Window B. The harness correction is committed as `d890d609`. Focused harness
tests passed (13), typecheck/lint/full hygiene passed (23 existing ESLint
warnings; P0/P1 100%, paired cutover 40/40). Windows x64 workspace Rust tests
passed: **1,644 passed / three existing ignored**, Core 954 in 196.29s;
the unchanged updater 256-round race passed again. Logs:
`windows-handoff-b0c3c184/window-stop-test-rust-x64.log` and
`window-stop-full-hygiene.log` under the artifact root. Final Windows x64
`lint:rust` passed in 57.89s (`window-stop-lint-rust-final-x64.log`). Native
terminal-cleanup validation is next; neither full-profile acceptance
nor legacy input deletion is authorized by this correction. AppKit projection
quarantine also uses the shared Core terminal commit, preserving its native
authority and including hidden tabs in teardown. Its platform-aware Rust
quarantine regressions passed; native macOS validation remains pending.

Core correction commit: `4d42c351`. Its first E2E build attempt (`02-42-58`)
could not replace the addon because the earlier `02-07-46` failed run still
owned it. Exact user-data-path-matched orphan processes were terminated; no
user app process was targeted. The next attempt,
`.desktop-e2e-artifacts/2026-09-07T02-45-33-761Z-win32`, passed physical input,
Window A projection removal, Window B held-key close and cleanup, then reached
Window C's shutdown Macro. Core stop receipts 525/739 completed. It failed at
the final visible application Close helper: the PID-only UIA selector required
one window even though the scenario deliberately retained a Game Window.
The helper now selects the process's fixed `Rion Studio` main-window title,
retaining unique-window and unique native Close-button assertions. Typecheck
and the eight-test Macro cutover harness suite passed. The failed attempt's
post-test cleanup wrote `electron-final-flush.json` with `complete: true`;
this does not substitute for the primary visible application Close assertion.

`e72f5cbf` passed the complete focused physical prerequisite + terminal-cleanup
seed/restart selection on Windows x64 (Electron 43.4.1 / Chromium 150.0.7871.224).
Run `.desktop-e2e-artifacts/2026-09-07T02-49-57-194Z-win32`, profile
`chromium-windows-smoke`, target `chromium-v23-windows`; seed UI 49.8s and
restart UI 4s. CHROMIUM-WINDOWS-MACRO-TERMINAL-CLEANUP-006 now has native
evidence for exact window removal, held-key tab/window cleanup, visible main
Close and clean restored input. This focused result does not close the separate
full-profile topology input-receipt failure or paired macOS/hardware gates.

The first focused system-settings attempt at `e72f5cbf`,
`.desktop-e2e-artifacts/2026-09-07T02-52-13-859Z-win32`, completed preference,
font-application and removed-controls assertions, then failed native diagnostics
Cancel discovery. Exact UIA inspection of PID 13488 found main HWND 1442506 with
owned child dialog HWND 525698, title `Export Rion Studio Diagnostics`, class
`#32770`. The root-only UIA selector omitted that child. Cancel HWND 3997956
had native class `Button` and ID 2, but UIA reported `Pane` with no supported
patterns on this host. The existing upload driver is extracted unchanged to
`windows-native-dialog.ts`; diagnostics now reuses its native owner, class,
control-ID, foreground, visibility and hit-test fences to click Cancel.
It successfully cancelled that exact failed-run dialog; this manual cleanup
does not count as journey acceptance. Typecheck/source hygiene and 19 focused
tests passed; all prior upload hit-test assertions remain, now reading the
shared source. Coverage remains P0/P1 100% and paired 40/40. Native settings
and upload acceptance for this harness correction are pending.

Dialog harness commits: `be57da38` plus `6f1468f1` (source-test project-boundary
correction). The first intervening build stopped at TS6307 before UI execution;
the fixture source is now read rather than directly imported into the node test
project. `6f1468f1` then passed **chromium-system-settings** on Windows x64,
run `.desktop-e2e-artifacts/2026-09-07T03-01-32-360Z-win32` (19.3s UI).
This exercises CHROMIUM-WINDOWS-SYSTEM-SETTINGS-013,
CHROMIUM-WINDOWS-FONT-APPLICATION-033 and
CHROMIUM-WINDOWS-DIAGNOSTICS-EXPORT-029: actual font application, absent retired
controls, visible native diagnostics Cancel with exactly one cancelled journal
entry and zero Core export invocation, and subsequent legal-dialog cancellation.
CP-02/CP-06/CP-13 Windows settings acceptance is now satisfied; current-candidate
macOS and other migration/hardware/update gates remain separate.

The complete Windows profile at `6f1468f1` stopped after **22 PASS / 1 FAIL**
at Macro UI seed, run `.desktop-e2e-artifacts/2026-09-07T03-02-59-012Z-win32`.
Workspace Web fullscreen seed/restart, including native upload, passed with the
shared dialog driver. The Macro failure now has exact raw receipt evidence:
`browser-action-2` (focus) scheduled at **1788750894672** by Rust, while its
applied JS receipt completed at **1788750894671**; JS dispatch began at
1788750894668. Core flow 133 correctly rejects the out-of-order receipt and
138 rejects Macro start. This is a demonstrated clock-domain mismatch, not a
missed running-state sample. The working correction exposes the exact Core
Macro epoch clock through Node-API and supplies it to both platform adapters,
Windows View admission/submission, and receipt validation. AppKit native
submission also reads the same Rust helper. No timestamps are clamped, deadline
extended, or ordering assertion relaxed. Two platform-explicit regressions keep
the one-millisecond early receipt rejection; 25 focused TypeScript tests and
the native Rust clock unit test passed. New native integration checks that the
clock remains native even when JavaScript Date.now is replaced. Full native
validation is pending; the earlier topology failure is not independently
attributed until its recorded sequence or new exact verification supports it.

The completed uncontended x64 Vitest batch (`vitest-x64-uncontended.log`)
reported 452 files: 430 passed, 12 failed, ten skipped; 3,582 tests passed,
15 failed, 48 skipped, 742.31s. Eleven failures are exact `symlink` `EPERM`
errors, two are `spawnSync bash ENOENT`, and two renderer cases hit the unchanged
10-second limit. Git Bash exists at `C:/Program Files/Git/bin/bash.exe`; focused
Bash validation now adds that existing directory to PATH. The initial-click
helper's tests are separate from that batch's selected test files. No symlink
test was skipped or substituted, and no timeout was enlarged. These results
remain qualified Windows-VM evidence, not a green full suite.

The x64 full Vitest batch with two workers was interrupted after repeated
failures while competing with the cold Rust compilation on this four-core host.
It is **incomplete**, not a passing suite. Its log is
`vitest-x64-after-install.log`; several failures cluster at the existing 10-second
test boundary, while file-symlink fixtures fail immediately. An independent
Node file-symlink probe returned `EPERM` on this workstation, which lacks
`SeCreateSymbolicLinkPrivilege`. Preserve those security assertions and the
existing deadlines. Native/E2E validation will run without competing full-suite
work; symlink-dependent checks still require a capable Windows environment.

## Feature and capability inventory

The feature names below cover all nine entries in `docs/e2e-coverage.json`.
Capability rows also cover infrastructure outside the renderer feature registry.
Paths identify entry points to follow, not evidence that every native branch has
been executed. `shared` describes source architecture, not completed parity.

| Features / capability | Source and event flow | Assessment / task |
| --- | --- | --- |
| app-shell, dashboard, games, roles, workspaces, settings: CRUD, legal, preferences, portable data | `src/renderer/src/features` -> typed bridge -> `crates/rion-core/src/app`; committed Core snapshots -> renderer | Shared React/Rust authority; retain it. CP-01, CP-12, CP-14 |
| quick-access, application shortcuts | `src/electron/main/chromiumRoleQuickAccessShortcut.ts`, `src/electron/main/electronFocusedApplicationShortcutController.ts`; authenticated input -> command -> Core/native receipt | Shared command flow with Cmd/Ctrl and native host differences. CP-07, CP-12 |
| roles / workspaces: browser persistence and isolation | `src/electron/main/chromiumRoleSessionRegistry.ts`, `src/electron/main/chromiumGlobalWebSessionRegistry.ts`; Rust path/owner -> Session handle lease | Shared `session.fromPath`; repeated path policy. CP-03, CP-10 |
| Explicit reset and migration | `src/electron/main/chromiumRoleBrowserDataClearCoordinator.ts`, `src/electron/main/chromiumSessionMigrationImporter.ts`; Core intent -> exact isolation -> helper readback -> terminal result | Shared Chromium storage, distinct transaction semantics. CP-10 |
| game-windows: navigation, reload, popups | `src/electron/main/chromiumRoleNavigationLifecycle.ts`, `src/electron/main/chromiumPopupLifecycleCoordinator.ts`; WebContents events -> exact surface/operation receipts | Shared browser APIs; native presentation retained. CP-04, CP-11 |
| game-windows: topology, display, fullscreen, recovery | `src/electron/main/chromiumRuntimeAppKitProjection.ts`, `src/electron/main/chromiumRuntimeWindowsProjection.ts`, `src/electron/main/electronDisplayTopologyController.ts`; Core revision -> adapter -> native evidence | Shared screen inventory; duplicated surface application/compensation. CP-04, CP-12 |
| macros: scheduling, overlay, trusted input | `crates/rion-core/src/macro_runtime`, `src/electron/main/chromiumTrustedInputCoordinator.ts`; Core input lane -> native submission -> authenticated DOM/native receipt | Common authority/coordinator; platform submission remains. CP-08, CP-09 |
| Fonts, audio, zoom | `src/electron/main/chromiumRoleFontsCoordinator.ts`, `src/electron/main/chromiumRoleSurfaceRegistry.ts`; bounded preload receipt or exact WebContents readback | Shared rendering/effects and v23 Chromium family enumeration; `crates/rion-platform/src/system_fonts.rs` remains for v22 only. CP-05, CP-06, CP-11 |
| Security, permissions, downloads, file upload | `src/electron/main/chromiumSecurityPolicy.ts`; exact Session synchronous policy callback or native chooser -> page File receipt | Shared policy; Role and Global Web security domains must stay distinct. CP-11, CP-15 |
| settings: diagnostics export | `src/electron/main/electronDiagnosticsComposition.ts`; native save dialog -> exact window fence -> Core export | Owner retired performance diagnostics and high-refresh settings on 2026-09-06. General log/GPU/runtime export remains. CP-02, CP-13 |
| Application lifecycle and shell services | `src/electron/main/applicationLifecycleController.ts`, `src/electron/main/windowsSessionEndCoordinator.ts`, `src/electron/main/electronNativeShellActions.ts` | Shared suspend/resume, dialogs, clipboard and shell APIs; Windows session-end adapter required. CP-12 |
| Filesystem, encryption, Chrome import | `crates/rion-platform/src/filesystem.rs`, `crates/rion-platform/src/protected_data.rs`, `crates/rion-platform/src/chrome_cookie.rs` | Necessary OS effects under Rust authority; not browser APIs. CP-14 |
| Packaging, update, release, desktop test infrastructure | `crates/rion-updater/src/platform_install`, `scripts`, `.github/workflows`, `e2e/desktop` | Share orchestration, preserve installer and physical UI mechanisms. CP-15, CP-16, CP-17 |

## Execution register

P0 addresses a functional or persistence gap; P1 removes major duplicated
mechanisms or proves compatibility; P2 contains maintenance/governance work.
Owners are responsible subsystems, not assignments to unavailable people.

| ID | Priority / owner | State | Dependency | Deliverable and completion evidence |
| --- | --- | --- | --- | --- |
| CP-01 | P1 / Architecture | verified | none | Catalog all nine features and infrastructure, identify authoritative sources and replacement candidates, preserve explicit open/probe/gated work and link the active catalog. This ledger is the initial source-audit deliverable; physical verification is separately tracked. |
| CP-02 | P0 / Diagnostics | verified; paired settings/removal acceptance at 718dc83a | CP-01 | Owner-directed complete removal of performance measurement UI, IPC commands/events, sampler, power/thermal probes and exported sample payload in both shells. Preserve general diagnostics export and verify absent controls on both platforms. |
| CP-03 | P0 / Core + Sessions | verified shared path boundaries; paired native Rust and restart acceptance at 718dc83a | CP-01 | Share Rust Chromium engine-path conversion and Electron canonical-path/ownership helpers across Role, Global Web and maintenance helpers. Reject unsupported device paths consistently without moving stores. Test drive/UNC/case/alias/owner boundaries and persistent restart on Windows. |
| CP-04 | P1 / Runtime projection | implemented; c72d688e corrects raw/logical detach ownership, 015dbaa2 macOS native/full hardware replay passed; Windows workstation acceptance pending | CP-01 | Extract equivalent snapshot, bounds, visibility, zoom, reparent and compensation steps; retain AppKit transaction/geometry and Windows host effects. Test stale revision, partial application, compensation failure and exact quarantine, plus paired topology/recovery journeys. |
| CP-05 | P1 / Fonts | verified adopt; production provider acceptance remains CP-06 | CP-01 | Evaluate queryLocalFonts on pinned Electron: family/CJK/duplicates, focus/activation, permission, reload, generic fallback and existing automatic settings loading. Allow enumeration only in an authenticated app frame; remote pages remain denied. Produce adopt/retain result with both native runs. |
| CP-06 | P1 / Fonts + bridge | verified v23 provider; paired native probes and settings acceptance at 718dc83a | CP-05 passes | Keep listSystemFonts Promise result, bounded Rust normalization/cache/fallback, and shell enumeration provider. Remove v23 native enumeration only after equivalent settings behavior is proven. Retain v22 reachability until CP-17. If CP-05 fails, close as a documented retained adapter. |
| CP-07 | P1 / Application input | verified retain; Windows lifecycle correction confirmed | CP-01 | Compare before-input-event and Menu with Windows F11 hook across main, Role, global Web, popup, focused/hidden hosts, repeat and key-up. Remove hook only with exact once-only routing and page suppression; do not substitute globalShortcut. |
| CP-08 | P1 / Trusted input | Windows full input parity passed at 34a98f5b; child-HWND implementation removed; post-deletion native validation pending | CP-01 | Evaluate sendInputEvent separately for foreground and hidden Role input, modifiers, held keys, middle button, zoom and reload. Preserve focus and owner/generation/epoch/DOM evidence. Partial replacement is permitted only with proven equivalent semantics; retain AppKit input. |
| CP-09 | P1 / Trusted input | verified shared coordination; all eight required paired Macro journeys PASS at 34a98f5b | CP-01 | Consolidate genuinely identical pending-sequence, frame, cancellation and retirement coordination around the existing shared coordinator. Preserve independent native evidence validation and Core scheduling. Test stale/duplicate/partial submission and paired Macro journeys. |
| CP-10 | P1 / Session maintenance | shared lifecycle passed at 34a98f5b; macOS visible consent/import/restart passed in clean 015dbaa2 full hardware profile; Windows consented import workstation acceptance pending | CP-03 | Share helper launch, process identity, response validation, drain and cancellation plumbing. Keep reset, migration and Chrome import data scopes/terminality distinct. Fresh-process DOM Storage readback remains required; test tampered/stale helper outcomes and restart persistence. |
| CP-11 | P1 / Browser capability owners | macOS complete hardware/capability profile passed at 015dbaa2; historical Windows navigation/upload/security passed at 6ace94b2 and settings/fonts at 009c4eb4; final Windows full/hardware pending | CP-01 | Trace navigation/reload/popups/audio/zoom/fonts/overlay/security/certificates/download denial/upload/HTML fullscreen from API through consumer and exact receipt to journey. Close shared capabilities with behavior evidence, not source tokens. Preserve distinct Session policies. |
| CP-12 | P2 / Shell | implemented; 806ddb0a corrects admitted-launch projection dependency and 61f32424 corrects native fullscreen exit; 015dbaa2 native/full hardware and physical display/control passed; real sleep/wake and Windows workstation profile pending; physical mixed-DPI gate removed by owner | CP-01 | Centralize command definitions, shell services, display event and exit-drain coordination where equivalent. Retain Cmd/Ctrl, AppKit, Mica/vibrancy and Windows session-end boundaries. Test cancel/close/drain/focus and paired shell journeys. |
| CP-13 | P1 / Diagnostics + settings | verified; paired retired-settings and persistence acceptance at 718dc83a | CP-02 | Owner-directed removal of high-refresh UI, shared settings and WKWebView feature writes. Ignore retired persisted/imported fields without losing other preferences. Preserve unrelated WebGL policy and AppKit hosting. |
| CP-14 | P2 / Platform data | retained adapters verified; both native Rust gates passed at 280027d7 | CP-01 | Record exact retained boundaries for file identity/ACL/atomic replacement/locks, Chrome discovery/quit/decryption and transfer encryption. Keep legacy migration distinct from ongoing consented Chrome import. Audit callers and both cfg targets; no safeStorage format assumption. |
| CP-15 | P1 / Desktop E2E | 015dbaa2 macOS full hardware 57 PASS + 4 expected force exits; b8bae38b stable full 31 PASS + 3 expected force exits and Chromium 56 PASS + 4 expected force exits; Windows workstation profiles pending | CP-01; alongside behavior tasks | Share fixtures, seed/restart scenarios and receipt assertions; retain native UI drivers. Upload must still click the remote file input and native chooser. Preserve all coverage targets and run paired smoke/hardware profiles where relevant. |
| CP-16 | P2 / Release tooling | b8bae38b macOS CI-fixture package/updater and packaged native Role black-box passed; Windows workstation and production gates pending | CP-01 | Share manifest/version/hash/signature/job coordination; retain native installer and locked verification. Reuse v22 release environment in final delta audit. No new credentials/infrastructure, no autoUpdater, and no publication inferred from this task. |
| CP-17 | P1 / Migration | gated | existing migration execution gates | Make Electron the sole production entry only after exact-candidate native parity, update transactions and release gates. Remove Tauri/System WebView-only code/dependencies/tests, retain AppKit and required data import/upgrade compatibility. Never waive existing gates. |
| CP-18 | P1 / Validation | 015dbaa2 macOS native and full hardware passed; b8bae38b complete macOS CI passed, including package/updater; current physical replay, Windows workstation and external gates pending | all applicable tasks | Prevent duplicated mechanisms from returning using focused behavior tests and dependency-boundary checks. Record actual macOS/Windows runs and remaining exceptions per task; branch count zero is not the goal. |

Start CP-02 and CP-03 after the baseline. CP-04 and CP-09 through CP-13 are
independent of native replacement approval, except for their listed data
dependencies. CP-05/07/08 must produce evidence before removal; CP-06 follows
only a passing CP-05. CP-14 through CP-16 can progress without enabling release.
CP-17 remains blocked by the existing migration gates. CP-18 accompanies every
change, not just the final batch.

## Probe protocols and retained boundaries

- **CP-05:** use the pinned bundled runtime and the actual trusted application
  origin/frame. Compare normalized families to the existing provider, including
  installed CJK families and generic fallback; exercise denial, reload and
  automatic settings entry. Never open local-fonts to Role/global-Web sessions.
  If equivalent behavior requires an unapproved user-flow change, retain the
  provider and document the precise mismatch rather than silently changing UX.
- **CP-07:** the existing Win32 hook filters plain F11 for an exact foreground
  HWND. Menu deliberately sets registerAccelerator=false. A replacement must
  capture both key halves once, suppress page delivery and never claim a chord
  belonging to another application. A synthetic DOM dispatch is not proof.
- **CP-08:** bind exact Role, parent, surface generation, input epoch and document
  before submission; require the expected trusted DOM sequence afterward. Test
  visible and hidden surfaces separately, including held-key retirement and
  ownership transfer. No focus acquisition is allowed to repair background
  delivery. Failed probes retain the native lane; do not weaken receipts.
- **CP-10:** cookie acknowledgements cannot stand in for DOM Storage durability.
  Do not replace fresh-process readback with a flush call or same-process reopen.
- **CP-12/14/16:** different native effects are legitimate when the OS contract
  differs. Centralize shared coordination, not native authority. Windows driver
  logs, macOS thermal data, DPAPI/Keychain, native chooser ownership, file locks,
  NSIS installation and AppKit gestures are not interchangeable browser effects.

## API research references

Official documentation was checked on 2026-09-06 and local Electron declarations
were inspected for the pinned runtime. Latest documentation is supporting
research, not proof that every feature exists or behaves identically in 43.4.1.

| API | Finding and consequence |
| --- | --- |
| [WebContents input](https://www.electronjs.org/docs/latest/api/web-contents#contentssendinputeventinputevent) | sendInputEvent requires its containing BrowserWindow to be focused; hidden-surface/background equivalence is unproven. before-input-event/before-mouse-event are candidates, not native receipt substitutes. |
| [Local Font Access](https://developer.chrome.com/docs/capabilities/web-apis/local-fonts) | queryLocalFonts enumerates installed fonts behind local-fonts permission; exact-frame admission and existing UI behavior require CP-05. |
| [Session](https://www.electronjs.org/docs/latest/api/session#sesflushstoragedata) | flushStorageData returns void in pinned declarations; fresh-process durability proof remains. session.fromPath is already the common store entry. |
| [powerMonitor](https://www.electronjs.org/docs/latest/api/power-monitor) | suspend/resume are shared; shutdown is not a Windows event. Retain query-session-end coordination. |
| [safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage) | Platform key providers/security semantics remain different. API presence proves neither Chrome key access nor existing transfer-format compatibility. |
| [autoUpdater](https://www.electronjs.org/docs/latest/api/auto-updater) | Platform-specific update mechanisms do not replace the current Rust trust/transaction and installer contracts. The repository explicitly excludes autoUpdater. |

## Interfaces, acceptance and evidence

Preserve the public `window.rionStudio` API by default. New providers are internal
ports. Rust-generated shared types remain authoritative; change contracts and
all consumers together if terminal status, completion scope or ordering changes.
No generated file may be hand-edited. Diagnostic samples must carry exact
operation and surface identities; unavailable metrics must remain unavailable.

Tests pass platform explicitly and drive authoritative events. Cover stale,
duplicate, cancellation, supersede, stream failure, partial mutation and exact
native retirement. Finite diagnostic measurement may use the existing declared
sampling boundary, but timers cannot discover state or imply a successful
operation without its exact sample receipt. No new production polling.

Relevant paired Chromium journey suffixes include APPLICATION-SHORTCUTS-030,
MACRO-BACKGROUND-TAB-004, DIAGNOSTICS-EXPORT-029, ROLE-SESSION-ISOLATION-003,
WORKSPACE-WEB-FILE-UPLOAD-028, RUNTIME-TAB-TOPOLOGY-009 and
RUNTIME-TAB-RELOAD-031. Use the full MACOS-APPKIT/WINDOWS IDs from the coverage
manifest. Add P0/P1 journeys for newly exercised diagnostic/font behavior;
source tests alone cannot certify visible user actions.

Run focused tests first, then routed source hygiene, typecheck, lint, tests and
builds as applicable. Native/shared-contract changes require native lint:rust
and test:rust. Journey changes require check:e2e-coverage. Final native evidence
must include chromium-macos-appkit-smoke and chromium-windows-smoke; input and
display changes also require their hardware-extended profiles. Windows stays
pending when unavailable locally, even when platform-table tests pass.

For every execution update record the task ID, changed mechanism, source
revision or working-tree qualification, exact check/profile, outcome and artifact
location when produced. Do not copy historical migration evidence as current
proof. Do not edit immutable validation archives. Completion means all tasks
have implemented or justified-retained outcomes with required native evidence,
not that this ledger exists or that an API compiles.

### Execution evidence

- CP-01: initial feature/capability inventory and CP-01 through CP-18 register
  created from the research baseline; catalog and migration cross-links added.
  No product behavior changes are claimed by this documentation entry.
- CP-03: implemented in the working tree following the research baseline. The
  shared Rust engine-path serializer serves Global Web and Role path records;
  Electron Role, Global Web, ownership, both clear coordinators and the Role
  fresh-clear helper use one canonical wire-path boundary. Windows drive and UNC
  forms remain ordinary absolute paths; device and drive-relative/root-relative
  forms cannot reach Session creation. No profile data was moved, no new public
  interface or timer was added, and stable-v22 consumers remain compiled.
- CP-03 focused evidence: the initial eight-file Vitest batch passed 106 tests;
  after adding device/root-relative regressions, the two changed path/Role suites
  passed 48 tests. Two Rust Chromium-path tests passed, including canonical-root
  Role-store reopen. These are lower-layer-covered changes; existing paired
  ROLE-SESSION-ISOLATION-003 and WORKSPACE-WEB-SLOT-016 journeys remain the native
  acceptance gates. No journey behavior or coverage target was changed.
- At the initial CP-03 handoff, CP-02 and CP-04 through CP-18 remained pending.
  No replacement probe or desktop profile had run in that batch. CP-03 still
  needs both Chromium restart profiles, especially
  physical Windows persistence; it is not marked verified.
- Working-tree validation: check:hygiene (including documentation, AI context,
  source hygiene, Cargo dependency and E2E coverage checks), typecheck,
  lint:rust, the full native macOS Rust workspace tests, build and
  build:electron passed. Lint exited successfully with 23 warnings in unrelated
  renderer files; focused changed-file lint passed without warnings.
- The sandboxed full Vitest run passed 425 files and failed three environment-
  dependent files (DMG/Seatbelt and the loopback HTTP fixture). Those three files
  subsequently passed with the required native/loopback access: four DMG/Seatbelt
  tests and 14 runtime-fixture tests. The initial sandboxed Rust run failed five
  Keychain protection tests; the full workspace rerun with native access passed.
  This is a qualified working-tree result, not an immutable CI candidate or a
  desktop E2E run. Windows native checks remain pending CI.


### Owner-directed retirement: CP-02 and CP-13

On 2026-09-06 the owner explicitly retired performance diagnostics and the
high-refresh setting. These instructions supersede the original sampling-wiring
proposal. Both transition shells now remove the controls, typed commands/events,
operation controller, page sampler, native process/GPU sample readback,
power/thermal probes, high-refresh WebKit feature write and exported foreground
sample. General log export, application/runtime/GPU metadata, AppKit hosting and
unrelated WebGL experiment selection remain. The experiment launcher's retired
sampling-duration option is removed as well.

Rust and renderer settings no longer contain a performance section. Startup
repair ignores old boolean, enum and malformed retired values, preserves other
preferences, and is idempotent. Portable import accepts legacy preferences and
current export omits retired fields. Rust-owned generation removes the ten
retired TypeScript binding outputs; no generated contract was hand-edited.

Working-tree evidence for this batch:

- Full Vitest: 425 files, 3,243 tests passed. After the final native-source and
  documentation corrections, five focused files passed 50 tests; the experiment
  launcher, E2E source boundary and documentation graph passed another 13 tests.
- Production `build` and `build:electron` passed after sequential shell builds;
  `check:desktop-e2e-isolation` passed on the final production bundles.
- Native macOS `lint:rust` and `test:rust` passed: 1,638 tests, four existing
  ignored tests. Typecheck and lint passed; lint retains 23 unrelated renderer
  Fast Refresh warnings. Source hygiene and E2E coverage checks passed without
  changing any coverage target.
- `chromium-macos-appkit-smoke`, focused `chromium-system-settings`: PASS,
  including exact native diagnostics-save cancellation, clean exit and SQLite
  evidence that retired performance settings are absent. Local report:
  `.desktop-e2e-artifacts/2026-09-05T23-39-39-594Z-darwin/report.json`.
- Stable macOS `full`, focused `system-settings`: PASS. Local report:
  `.desktop-e2e-artifacts/2026-09-05T23-40-16-292Z-darwin/report.json`.
- Initial attempts are not acceptance evidence: the first stable run failed
  before reaching the initial screen while shell builds shared renderer output;
  sequential rebuilding passed. The first Chromium UI run passed but its old
  SQLite validator still required Disabled; the validator now requires absence
  and the complete phase rerun passed.
- Affected journeys: SETTINGS-SYSTEM-001, paired
  CHROMIUM-MACOS-APPKIT/WINDOWS-SYSTEM-SETTINGS-013 and paired
  CHROMIUM-MACOS-APPKIT/WINDOWS-DIAGNOSTICS-EXPORT-029. These are focused phases,
  not evidence that either entire profile or hardware-extended profile ran.
  Windows native lint/tests and both Windows settings phases remain pending CI.

CP-04 through CP-12 and CP-14 through CP-18 have not been completed by this
retirement batch. In particular, no font/input equivalence probe or final
migration/release gate is waived by removing these features.


### Shared surface projection: CP-04

The working tree now uses `chromiumRuntimeSurfaceProjection.ts` for both AppKit
and Windows Role/global-Web snapshot capture, bounds/visibility/zoom application,
acknowledged reparent journaling, reverse reparent compensation and surface
restoration. Snapshots copy bounds and retain the captured generation, so later
record or geometry mutation cannot redirect restoration to a newer surface.
Each restoration effect is attempted independently and failures still trigger
the existing exact window quarantine. Failed reparent submissions never enter
the acknowledged journal.

AppKit retains its native host/divider prepare/commit/rollback order, changed-only
surface application and adapter-sequence fence. Windows retains its Core layout
resolution, toolbar projection and host quarantine. No platform input, AppKit
chrome, domain owner, timer or public contract changed. Windows' rollback now
attempts visibility restoration even when zoom/bounds restoration fails, then
quarantines as before; this shares the best-effort compensation rule.

- Four focused projection/executor Vitest files passed 69 tests. The six new
  platform-explicit helper regressions additionally passed after strengthening
  reverse-order assertions; they prove immutable captured geometry/generation,
  independent restoration after failure, unchanged-effect suppression, failed
  submission exclusion and continued reverse rollback after a missing host.
- Typecheck, focused ESLint, source hygiene and production Electron build passed.
- Full Vitest: 425 files / 3,248 tests passed; one macOS packaged-process cleanup
  test reported an indeterminate OS process-tree cleanup. Its complete five-test
  file passed when rerun alone. This qualified result is not an unqualified full
  green suite. Logs: `/tmp/rion-cp04-full-tests.log` and
  `/tmp/rion-cp04-process-rerun.log`.
- E2E omission for this refactoring batch: `lower-layer-covered`, backed by both
  existing platform projection suites and shared failure regressions. Paired
  RUNTIME-TAB-TOPOLOGY-009 and application-recovery native acceptance remains
  outstanding. Prior settings E2E runs do not certify these changed paths.

CP-05/06 font experiments are the next independent item. CP-07/08 input probes,
CP-09 through CP-12, CP-14 through CP-18 and all recorded native/release gates
remain active; CP-04 implementation does not close their requirements.


### Local Font Access experiment: CP-05 / CP-06

A reproducible bundled-Electron probe now lives in
`scripts/probeChromiumLocalFonts.cjs`, exercised by
`tests/electron-local-fonts.native-integration.ts`. It uses isolated temporary
Electron/Core data, sandboxed file-backed fixtures and no debugging transport.
It compares the existing Rust provider with Chromium enumeration and records
exact-frame permission decisions. Production permission policy and enumeration
are unchanged while CP-06 remains conditional.

Observed on native macOS with Electron 43.4.1 / Chromium 150.0.7871.224:

- Automatic enumeration without user activation returned 705 faces / 251 unique
  families. Shown-window and reloaded-document enumeration returned the same
  families, including PingFang TC/SC and installed CJK families.
- Permission denial, a child frame, navigation to another file, and a different
  WebContents in the same Session all returned empty lists. Permission checks
  provide `isMainFrame` and the full `requestingUrl`, enabling exact application
  frame admission without granting Role/global-Web sessions permission.
- The current Rust provider returned its 16-family fallback. Independent native
  inspection produced 2,224,721 bytes of system_profiler JSON, exceeding the
  existing 2 MiB bound. Its 346 unique native family names comprise the same 251
  public families and 95 dot-prefixed private families; its broad `_name` walk
  also collects face/file names. These differences must not be mislabeled exact
  enumeration parity. Six fallback labels were absent from Chromium's actual
  installed-family inventory; stored font selections must remain compatible if
  the new enumeration provider is adopted.
- The isolated macOS integration test passed. The complete real native Electron
  integration command passed both files / six tests. Typecheck, focused lint,
  source/documentation/Cargo/E2E hygiene passed. The standalone local report is
  `/tmp/rion-cp05-report.json`; this is working-tree evidence, not immutable CI.

Both existing macOS and Windows native-validation jobs now execute the same
probe through the native-integration suite and upload their JSON report as a
Local Font Access compatibility artifact. Windows has not run for this working
tree yet. CP-05 remains open for its Windows observation and final equivalence
assessment; CP-06 is not implemented or declared retained merely because a
macOS API call succeeded. E2E omission for the probe itself is
`lower-layer-covered`: it changes no product behavior and directly exercises
native Chromium permission and enumeration behavior.


### Shared trusted-input coordination: CP-09

Both native adapters now use `chromiumTrustedInputPendingLane.ts` for pending
request ownership, exact frame identity, cancellation, retirement, DOM mismatch
and terminal completion. `chromiumTrustedInputDomReceipt.ts` supplies the common
bounded, closed-schema preload decoder and exact expected-event comparison.
AppKit native sequence evidence and Win32 HWND/process/focus/injection evidence
remain validated by their respective adapters; Core still owns scheduling.

The shared lane fences duplicate terminal events, removes only its own map
entries, admits reentrant work without overwriting another request, and completes
even when deadline cancellation or a retired frame throws. Native submission
without complete authoritative evidence remains indeterminate. Existing explicit
deadlines retain their classification; this introduces no polling or new timer.

- Five focused trusted-input test files passed 76 tests, including ten new
  platform-explicit shared-lane cases for reentrancy, stale frames, retirement,
  partial completion and independent cancellation failures.
- Full Vitest passed all 427 files / 3,259 tests. The first run exposed a missing
  migration-token admission for the CP-05 isolated font probe; adding its exact
  path to the existing allowlist fixed the gate. No broad scan exemption was
  added. Final log: `/tmp/rion-cp09-full-tests-rerun.log`.
- Typecheck, focused ESLint, full hygiene and production Electron build passed.
- E2E omission for this refactoring batch: `lower-layer-covered`, with the focused
  tests above. Native macOS and Windows acceptance remains pending for paired
  MACRO-NATIVE-EFFECT-018, MACRO-BACKGROUND-TAB-004,
  MACRO-STANDBY-RECOVERY-023 and MACRO-INPUT-RECOVERY-011 journeys under the
  CHROMIUM-MACOS-APPKIT and CHROMIUM-WINDOWS prefixes. The earlier settings
  profiles do not certify these input paths.


### Session maintenance transport audit: CP-10

The three operations already converge on one transport; no additional launcher
or platform switch is needed. The legacy Chrome-import naming of that private
transport is not a restriction to Chrome import. Verified call chain:

| Responsibility | Shared owner and evidence |
| --- | --- |
| Request launch | ClearFreshCoordinator, SessionMigrationFreshCoordinator and ChromeProfileImportCoordinator all call CoreAddonClient.launchChromeProfileImportHelperInternal. |
| Cancellation and JS buffer ownership | CoreAddonClient creates one cancellation UUID, binds AbortSignal, and waits for the original native launch promise. Aborting never resolves an operation while process cleanup is pending. |
| Process identity, pipes and drain | rion-node/chrome_profile_import_helper_launcher.rs launches the current executable with a fixed mode, owns the exact Child, requires bounded stdout EOF and clean child exit, and hashes PID plus response bytes into exit evidence. HelperProcessRegistry rejects drain-time admission and waits for registration release. |
| Windows-specific process presentation | rion-platform::background_command only supplies the required background-process flags; process ownership and exit rules stay in the common Rust launcher. |
| Wire validation | The common native response decoder and CoreAddonClient validator reject unsupported outcomes, bounds, framing and noncanonical exit evidence. chromeProfileImportHelperProtocol owns the common helper wire format. |
| Helper execution | runChromeProfileImportHelperProcess decodes one request, dispatches its family, writes one terminal frame, erases owned buffers, then exits. It awaits the response write; a failed terminal write produces a nonzero exit. |

Family-specific receipt identity and data semantics remain intentionally separate:
reset proves an all-store clear, cookie readback and exact Session drain;
legacy migration binds its inventory/journal and requires a distinct helper's
LocalStorage readback; consented Chrome import binds a transaction, origin scope,
backup and one-time verification capability. A shared permissive receipt schema
would lose these fences. Cookie flush or same-process reopen cannot replace the
fresh-process migration verification.

The helper-process suite now runs explicitly for both darwin and win32 paths.
New event-driven tests hold the terminal write pending and prove no exit or
response-buffer erasure occurs early; rejected writes prove a nonzero process
exit and buffer cleanup. Nine focused transport, coordinator and migration files
passed 121 tests, including stale/tampered outcomes, cancellation awaiting native
completion, reset uncertainty and distinct-session verification. These are
lower-layer behavior tests, not native Windows or persistence E2E evidence.
Native acceptance remains pending for the paired ROLE-EXPLICIT-RESET-007 journeys
and exact migration/import restart scenarios. E2E omission for this audit/test
batch is `lower-layer-covered`; no product behavior or coverage target changed.

Native macOS validation for this audit passed `lint:rust` and the entire
`test:rust` workspace (1,638 passed, four ignored), including the shared native
helper launcher's exact-child cancellation, bounded response framing,
pre-spawn cancellation and registry-drain tests. Typecheck, focused ESLint,
full hygiene and documentation checks also passed. Logs are
`/tmp/rion-cp10-rust-lint.log`, `/tmp/rion-cp10-rust-tests.log`,
`/tmp/rion-cp10-tests.log` and `/tmp/rion-cp10-fences.log`.
No desktop E2E profile ran in this audit batch; Windows native CI remains pending.


### Browser capability ownership: CP-11

The [capability audit](chromium-capability-ownership-audit.md) traces all requested
browser capabilities through their shared owners, exact completion sources and
behavior tests. It identifies two explicit desktop assertion gaps (live Role
font application and tab audio) for CP-15; settings controls and generic topology
journeys cannot substitute for those assertions. Certificate callback tests are
also labeled lower-layer evidence rather than claimed native TLS negotiation.


Fourteen focused capability/receipt files passed 190 tests. The macOS
`chromium-macos-appkit-smoke` profile's focused `chromium-controlled-role-reload`
phase passed the actual native-menu reload/failure/recovery journey
CHROMIUM-MACOS-APPKIT-RUNTIME-TAB-RELOAD-031. Report:
`.desktop-e2e-artifacts/2026-09-06T00-22-52-395Z-darwin/report.json`.

The same profile's `chromium-workspace-web-fullscreen-restart` focused run failed
in its seed dependency at native file selection: the AX chooser driver could
not find `rion-e2e.txt`. The failure screenshot also contains an older Rion
Studio crash-report dialog and another partially obscured system dialog; that
observation does not establish the cause. This is failed acceptance, not a
passed upload/fullscreen/security run. Preserve its report and screenshot:
`.desktop-e2e-artifacts/2026-09-06T00-20-11-427Z-darwin/report.json` and the seed
phase's `native-file-panel-failure.png`. CP-15 must diagnose the native chooser
failure and rerun the complete paired scenario without replacing visible upload.
Windows has not run this worktree's capability acceptance.


### Shared shell command definitions and lifecycle audit: CP-12

`electronApplicationMenuCommands.ts` now owns the application command items and
callback routing used by both native menus. Both wrappers retain their platform
menu layout while consuming the same new-window, quit, zoom and fullscreen
commands. Command/Ctrl accelerators, Windows mnemonic labels, macOS app/services
roles and Quick Open remain explicit presentation differences. Windows F11
continues to set registerAccelerator=false; CP-07's physical routing experiment
is still required before changing that owner. No Electron menu role bypasses the
Core-controlled fullscreen/quit path.

The other requested shell mechanisms already have a common owner:

| Mechanism | Common owner and retained boundary |
| --- | --- |
| Focused application commands | ElectronFocusedApplicationShortcutController authenticates the focused main/runtime/popup owner; ElectronApplicationShortcutController serializes main-window commands and fences queued work when quitting. Native AppKit runtime-window identity stays required. |
| Shell services | ElectronNativeShellActions delegates dialog selections and shell operations through common ports, then returns Core results. Selection cancellation returns null before any Core mutation; filesystem authority stays in Rust. |
| Displays | Electron screen display-added/removed/metrics-changed events feed ElectronDisplayTopologyController. Semantic revisions advance from captured display inventories, not polling. The native placement effects remain in the host adapters. |
| Power | ElectronApplicationLifecycleController serializes suspend/resume effects, fences stale epochs and drains its active lane on disposal. The platform field describes the published record; it does not select duplicate coordinators. |
| Close and quit | applyElectronMainWindowClosePolicy hides until final close is admitted. ElectronMainLifecycle and the renderer quit handshake own normal quit. prepareElectronCleanExit closes ingress, drains runtime/helper/browser-clear work and persists a clean marker only after authoritative completion. Fatal termination keeps its separate invalidation rules. |
| Windows session end | ElectronWindowsSessionEndCoordinator maps query-session-end into the same confirm/drain promise because the OS does not use ordinary Electron quit events for that path. It deduplicates repeated signals and preserves failure. |
| Window materials | windowOptions selects Electron vibrancy on macOS and Mica on Windows. These are requested native material differences, not duplicated lifecycle logic. |

Twelve focused command/menu/lifecycle/display/close/shell suites passed 63 tests,
including canceled dialog selection, stale focus, fullscreen interruption,
renderer quit confirmation, exact drain order and Windows session-end mocks.
No Rust/shared contract or native implementation changed in this batch. Native
Windows acceptance remains separate from these platform-explicit unit tests.


Full Vitest passed 427 files / 3,265 tests (`/tmp/rion-cp12-full-tests.log`).
Focused ESLint, typecheck and full hygiene also passed. The native macOS
`chromium-macos-appkit-smoke` profile passed both focused validations:

- `chromium-shell-smoke`: SHELL-001 and APPLICATION-SHORTCUTS-030, with actual
  focused command/zoom receipt evidence. Report:
  `.desktop-e2e-artifacts/2026-09-06T00-26-53-235Z-darwin/report.json`.
- `chromium-quit-guard-restart` including seed: QUIT-GUARD-014, covering keep
  editing, discard/quit, final flush and restart. Report:
  `.desktop-e2e-artifacts/2026-09-06T00-28-05-029Z-darwin/report.json`.

Windows native shell/shortcut/quit profiles and physical display/power acceptance
remain pending. The source refactor does not change journey behavior or manifest
coverage. OS-specific material/session-end boundaries remain retained.

After native E2E, the production Electron build and pure-renderer isolation
verification passed (`/tmp/rion-cp12-production-build.log`); the final local
output is the production build, with no E2E instrumentation.


### Platform data adapters: CP-14

The [platform data audit](chromium-platform-data-audit.md) traces native effects
and Core callers for file identity, permission repair, atomic replacement,
instance locks, Chrome discovery/close/cookie decoding and transfer encryption.
These adapters remain necessary for OS semantics and persisted-format
compatibility. Shared Rust orchestration remains the owner; no Electron
safeStorage conversion or live external-Chrome fallback was introduced.

The audit explicitly distinguishes source lock-marker observation from positive
process identity and tests with injected keys from native Keychain/DPAPI access.
The local Parallels command entry is a broken symlink and cannot provide a
Windows host; Windows native validation remains pending CI.


On native macOS, focused Rust validation passed: rion-platform all-targets
24 tests; Core session_transfer 27; chrome_profile_import four; session_import
eight; chrome_import 12 (75 total). Logs: `/tmp/rion-cp14-platform-tests.log`,
`/tmp/rion-cp14-transfer-tests.log`, `/tmp/rion-cp14-import-tests.log`,
`/tmp/rion-cp14-cookie-tests.log`, `/tmp/rion-cp14-contract-tests.log`.
Documentation/full hygiene checks passed. E2E omission for this documentation
and source audit is `lower-layer-covered`, with the focused behavior evidence
above. No macOS or Windows desktop E2E profile ran in this batch, and no native
implementation, import, cfg guard or persisted format changed.


### Release-tooling consolidation: CP-16

The updater manifest generator and release-asset verifier now share
`releaseFileHash.mjs` for streamed SHA-256-to-EOF. Each caller still owns its
regular-file/symlink/size checks and signature requirements. The protected
handle-based package-manifest reader is deliberately not replaced by this
path-based hashing helper; it has stronger identity requirements.

`releaseVersionPolicy.mjs` now owns the identical strict SemVer syntax used by
the production candidate, public-latest snapshot and compatibility receipt I/O.
Callers preserve their own errors and version-ordering checks. Numeric identifiers
are not converted to floating point; build metadata and noncanonical leading
zeroes remain rejected. Existing legacy entry-point argument normalization is
unchanged. This removes duplicate mechanisms without rewriting trust policies.

| Release concern | Shared mechanism and retained boundary |
| --- | --- |
| Version mutation | applyReleaseVersion.mjs updates package, Tauri configuration and all Rust workspace package versions together. Strict evidence validators now share syntax; compatibility receipt I/O continues to own exact comparison and newer-than checks. |
| Manifest and checksums | createTauriUpdaterManifest.mjs is a compatibility wrapper around createUpdaterManifest.mjs. Both platforms feed the same manifest, releaseArtifacts asset list, signature sidecars and checksum verification. |
| Signing environment | updaterSignerEnvironment.mjs constrains signer inputs. Existing TAURI_SIGNING_PRIVATE_KEY / TAURI_SIGNING_PRIVATE_KEY_PASSWORD names remain shared with the v22 workflow. No new secret or signing identity was added. |
| Cryptographic verification | electronProductionCandidate's Minisign verification still authenticates key ID, artifact signature and trusted-comment signature. Shared SHA-256 is evidence binding, not a replacement for this signature check. |
| Package build | Existing macos-latest/windows-latest matrices use shared orchestration while retaining native bundle/install steps. buildElectronRust selects only the library name and macOS linkage/ad-hoc signing effects. |
| Native distribution policy | electron-builder keeps macOS identity '-' and notarize=false. Windows installer verification still requires the unsigned policy. Native package identity and installed-payload verification remain platform-specific. |
| Candidate trust | electron-production-candidate reuses ci.yml, binds source/version/platform, runs exact native black-box checks before detached updater signing, and assembles both platform receipts. The existing protected environment remains in place. |
| Publication/cutover | Provisional publication, updater evidence execution and terminal promotion retain their disabled gates and owner prerequisites. CP-16 does not authorize publication, invent release credentials or substitute autoUpdater for Rust transactions. CP-17 remains gated. |

Six focused release/manifest/candidate/version suites passed 65 tests. Full
Vitest passed 428 files / 3,282 tests, including release workflow and trust-chain
regressions. Typecheck, lint (zero errors; 23 existing React Fast Refresh warnings)
and full hygiene passed. Logs: `/tmp/rion-cp16-tests.log`,
`/tmp/rion-cp16-full-tests.log`, `/tmp/rion-cp16-typecheck.log`,
`/tmp/rion-cp16-lint.log` and `/tmp/rion-cp16-hygiene.log`.
E2E omission for these release-helper refactors is `lower-layer-covered`, with
real temporary-file manifest/hash and candidate signature test evidence. No
native desktop E2E profile, Windows package build, production-key signing or
release transaction ran in this batch; exact-candidate native gates remain open.


### Desktop E2E recovery and shared scenarios: CP-15

The contained-fullscreen scenario already shares the fixture, seed/restart flow,
page actions and evidence assertions across both platform journey IDs. The
native-file-upload helper shares fixture bytes/hash verification and terminal
evidence while retaining AppKit AX and Windows UI Automation drivers. The
visible remote file input and actual OS chooser remain mandatory; no debug file
assignment or alternative upload path was added.

The macOS chooser now records bounded failure diagnostics (at most 300 native
nodes, depth 12, truncated labels; remote AXWebArea content excluded) to
`macos-native-file-dialog-failure.json`. A missing item now exits the Swift
selector normally with failure instead of fatalError, avoiding an additional
crash-report side effect. The existing screenshot and failed test verdict remain.
No permission prompt is automatically accepted or disabled.

The complete focused `chromium-macos-appkit-smoke` run for
`chromium-workspace-web-fullscreen-restart`, including seed and entity restart
dependencies, passed on macOS. Report:
`.desktop-e2e-artifacts/2026-09-06T00-38-00-929Z-darwin/report.json`.
POPUP-012, WORKSPACE-WEB-FULLSCREEN-017, WORKSPACE-WEB-SECURITY-POLICY-027 and
WORKSPACE-WEB-FILE-UPLOAD-028 all passed. Upload evidence proves exact native
application ownership, a visible action and the selected 57-byte file's SHA-256
matching its fixture; it is not merely a successful chooser return.

The prior failed run remains recorded above. This rerun did not reproduce the
missing-item failure, so its cause is still unproven. New diagnostics are for a
future recurrence, not evidence that the cause was repaired. Windows native
upload and CP-11's explicit live-font/audio assertions remain outstanding.


An independent repeat of the same complete focused profile also passed, without
manual UI interaction during the run. Report:
`.desktop-e2e-artifacts/2026-09-06T00-39-59-948Z-darwin/report.json`.
Both runs preserve real native chooser actions and the same page digest checks.
Typecheck, focused ESLint, five adjacent scenario tests, source/full hygiene and
coverage-manifest validation passed. The coverage target remains unchanged.
Logs: `/tmp/rion-cp15-upload-diagnose.log`, `/tmp/rion-cp15-upload-repeat.log`,
`/tmp/rion-cp15-source-tests.log` and `/tmp/rion-cp15-full-hygiene.log`.

Production Electron build and pure-renderer verification passed after both E2E
runs (`/tmp/rion-cp15-production-build.log`); final local build output contains
no E2E instrumentation.


### Visible tab audio parity: CP-11 / CP-15

The Windows host had no mute menu entry despite sharing the Chromium audio
executor. Its strict tab projection now carries `audioMuted`; the visible menu
submits `setTabMuted` with a boolean desired state and its captured projection
revision. The host rejects stale/unknown commands and forwards the existing
native action to Core `browserTabAudioMute`. After the authoritative terminal,
its existing layout observer republishes the executor's exact audio state.
Full and layout-only projections preserve audio state; the renderer does not
optimistically toggle it. The existing Role/Web rollback and readback executor
and retained AppKit menu remain the authorities for their respective work.

Read-only E2E inspection now includes `isAudioMuted` from the exact registered
Role surface. Paired P1 journeys `CHROMIUM-MACOS-APPKIT-RUNTIME-TAB-AUDIO-032`
and `CHROMIUM-WINDOWS-RUNTIME-TAB-AUDIO-032` use visible menus to mute/unmute,
compare Core and native state, preserve owner/surface/document identity during
audio changes, and retain mute through controlled Reload success, injected
Reload failure and recovery. This does not claim native audio failure injection,
Web-only or popup audio coverage; existing focused executor tests cover those
lower-layer mutation/rollback paths.

macOS `chromium-macos-appkit-smoke`, focused phase
`chromium-controlled-role-reload`, passed both AUDIO-032 and RELOAD-031:
`.desktop-e2e-artifacts/2026-09-06T00-52-14-725Z-darwin/report.json`.
Windows `chromium-windows-smoke` remains pending native CI. Live font application
also remains outstanding; CP-11/CP-15 are not closed by this partial profile.

Validation: 65 adjacent tests and the complete 428-file / 3,283-test Vitest suite
passed; typecheck, lint (23 existing warnings), source hygiene and E2E coverage
passed. Coverage targets remain unchanged. Logs: `/tmp/rion-audio-unit.log`,
`/tmp/rion-audio-full-tests.log`, `/tmp/rion-audio-native.log`,
`/tmp/rion-audio-typecheck.log`, `/tmp/rion-audio-lint.log`.

Production Electron build and pure-renderer verification passed after the native
run (`/tmp/rion-audio-production-build.log`, 36 sources / 3,275,470 bytes),
restoring non-instrumented output. Native macOS Rust lint also passed
(`/tmp/rion-audio-rust-lint.log`).
Native macOS Rust tests passed: 1,638 passed, 4 ignored, zero failed
(`/tmp/rion-audio-rust-tests.log`). Windows native Rust/E2E remains pending CI.


### Live font application and Canvas compatibility: CP-11 / CP-15

Paired P1 `CHROMIUM-MACOS-APPKIT-FONT-APPLICATION-033` and
`CHROMIUM-WINDOWS-FONT-APPLICATION-033` extend `chromium-system-settings` with
an actual launched Role. Visible controls select `ui-monospace` for Latin and
numbers, cancel an unsaved draft, apply, and reset. A visible fixture button
produces main-world evidence from its trusted click handler; WebDriver only
reads that bounded DOM result. Assertions check Core selection, applied CSS,
equal Canvas W/i widths, preservation of the original page `font` getter, and
restoration of the original proportional widths and CSS after reset.

This exposed a real Chromium compatibility defect: Canvas accepts the
`ui-monospace` generic but resolves a proportional fallback on this bundled
Chromium/macOS host. An independent uninstrumented Electron probe produced
W/i widths 15.1015625/4.4453125 for ui-monospace, versus
9.6328125/9.6328125 for monospace (`/tmp/rion-canvas-probe.log`). The shared
browser font runtime now inserts `monospace` immediately after a requested
`ui-monospace` in Canvas override stacks. Engines supporting the UI family keep
it; others receive a genuine monospace fallback. DOM CSS and the page-facing
Canvas font getter remain unchanged. This shared source feeds Electron and the
stable Tauri overlays; no platform branch or replacement font authority was
introduced. Two platform-explicit regression cases verify the stack and getter.

The final macOS native run passed FONT-APPLICATION-033,
SYSTEM-SETTINGS-013 and DIAGNOSTICS-EXPORT-029:
`.desktop-e2e-artifacts/2026-09-06T01-07-48-409Z-darwin/report.json`.
Earlier failed attempts remain diagnostic evidence: Courier New was not listed
in the picker, and the pre-fix generic-family journey reproduced proportional
Canvas metrics despite applied CSS and an installed hook. This journey therefore
proves generic-family application, not the separate CP-05/06 named-font inventory
or downloaded-font validation. Windows native execution remains pending CI.

The 18 shared font-runtime tests passed (`/tmp/rion-font-fix-tests.log`), along
with typecheck, lint (23 existing warnings), source hygiene and coverage checks.
The coverage targets remain unchanged. The passing native log is
`/tmp/rion-font-native-fixed.log`.

The complete 428-file / 3,285-test Vitest suite passed after the runtime fix
(`/tmp/rion-font-fixed-full-tests.log`). Production Electron build and pure
renderer verification passed (`/tmp/rion-font-production-build.log`, 36 sources /
3,275,470 bytes), restoring non-instrumented output. macOS Rust lint passed
(`/tmp/rion-font-rust-lint.log`).
Native macOS Rust tests passed: 1,638 passed, 4 ignored, zero failed
(`/tmp/rion-font-rust-tests.log`). Windows native Rust/E2E remains pending CI.


### Named-font loading clarification: CP-05 / CP-11 / CP-15

The earlier picker snapshot was captured while automatic enumeration was still
loading; it was not proof that Core or the bridge omitted named families.
A fresh `/usr/sbin/system_profiler SPFontsDataType -json` run took 10.19 seconds
and produced 2,224,721 bytes on this host, above the retained 2 MiB bound
(`/tmp/rion-fonts-current-time.log`). Core's existing normalization/fallback
therefore remains relevant. No new native enumeration implementation or larger
output limit was introduced.

FONT-APPLICATION-033 now waits for the existing visible loading state to finish,
then checks the Core inventory and selects Courier New through the actual menu.
It cancels the first draft, exercises the generic-family regression, then applies
Courier New to Latin and numeric slots. The fixture's trusted main-world handler
reports loaded FontFace family aliases as well as DOM CSS and Canvas W/i widths.
Assertions require loaded Latin/numeric aliases, the exact Core selection,
monospace measurements, and restoration of the original CSS, faces and metrics
on reset. This closes the macOS named-font application evidence gap; it does not
claim complete native inventory parity or downloaded-font coverage.

macOS `chromium-macos-appkit-smoke`, focused `chromium-system-settings`, passed
FONT-APPLICATION-033, SYSTEM-SETTINGS-013 and DIAGNOSTICS-EXPORT-029:
`.desktop-e2e-artifacts/2026-09-06T01-14-19-202Z-darwin/report.json`.
The preceding inventory/loading clarification run also passed:
`.desktop-e2e-artifacts/2026-09-06T01-12-55-087Z-darwin/report.json`.
The corresponding Windows profile remains pending native CI. CP-05/06's
queryLocalFonts adoption decision still requires the paired Windows probe.

Typecheck, 37 adjacent fixture/font tests, lint (23 existing warnings), source
hygiene and coverage validation passed. Logs: `/tmp/rion-font-named-native.log`,
`/tmp/rion-font-named-unit.log`, `/tmp/rion-font-named-lint.log`.
This increment changes E2E evidence only; the shared runtime fix and the previous
native Rust validation are unchanged.

Final production Electron build and pure renderer verification passed
(`/tmp/rion-font-named-production-build.log`, 36 sources / 3,275,470 bytes),
restoring non-instrumented output. The native Courier New evidence contains both
loaded aliases and equal W/i widths of 9.6015625; the generic fallback measured
9.6328125 for both glyphs, versus original proportional widths
15.171875/3.640625.


### Retired diagnostics runbook audit: CP-02 / CP-13 / CP-18

The active Game Mode runbook still passed the removed `--sample-ms` option to
the experiment launcher. Its commands now use only supported mode/Game Mode
arguments. Both active macOS comparison runbooks explain that the launcher no
longer supplies FPS/process/GPU/thermal samples; external/game-owned evidence
must name its source, and unavailable required metrics cannot pass a gate.
Immutable archive commands were preserved unchanged. Six launcher tests and
source hygiene passed (`/tmp/rion-runbook-tests.log`). This is internal-only
documentation maintenance; product controls remain removed.

A complete macOS `chromium-macos-appkit-smoke` run was started against the current
worktree at HEAD `a7a48418bcb9bffd1c91292719a609198e0cdbb4`. The completed result is recorded below; the run log is `/tmp/rion-full-native.log`.


### Complete macOS Chromium smoke: CP-03 / CP-04 / CP-09–12 / CP-15 / CP-18

The complete `chromium-macos-appkit-smoke` profile passed on the current dirty
worktree: all 49 manifest journeys are PASS, with no NOT_RUN journeys in this
profile. All 56 phases completed: 52 PASS and four EXPECTED_FORCE_TERMINATION
phases, each with an explicit expected-termination receipt and zero runner exit
code, establishing crash-recovery preconditions. It ran from 01:16:22 to
01:29:35 UTC on 2026-09-06. Authoritative report:
`.desktop-e2e-artifacts/2026-09-06T01-16-22-345Z-darwin/report.json`.
Source HEAD is `a7a48418bcb9bffd1c91292719a609198e0cdbb4`; this is a local
unpackaged Electron/AppKit run, not an exact production-candidate receipt.

The report supplies current macOS native evidence for Role/global-Web session
persistence, shared-role/workspace projection and fullscreen, visible tab
reorder/move/restart/recovery, foreground/background trusted Macro input,
keyboard/standby/input-failure recovery, terminal cleanup, shell shortcuts and
quit guard, upload/security policy, Role session isolation/reset, and generic
and named live-font application. Its Role reset journeys verify that particular
maintenance path; they do not establish all Chrome import or v22 migration
acceptance. The full report's journey IDs are the authority for scope.

No Windows native profile, hardware-extended profile, packaged candidate,
production updater transaction, or release-publication gate is proved by this
run. CP-05/07/08 probes and CP-17 remain separately open/gated. The full goal is
therefore still active rather than complete.

Production Electron build and pure-renderer verification passed after the full
profile (`/tmp/rion-full-native-production-build.log`, 36 sources /
3,275,470 bytes), restoring output without E2E instrumentation. Coverage, source
hygiene and whitespace validation passed after updating the evidence ledger.


### Hardware preflight and native integration: CP-05 / CP-12 / CP-15 / CP-18

The pinned Electron `screen.getAllDisplays()` preflight reports one display:
id 2, scale factor 2, bounds 2560x1440 and work area 2560x1410. Evidence:
`/tmp/rion-display-preflight.log`. The hardware-extended spec requires at least
two real displays with different scale factors. This host does not meet that
precondition; no simulated display was substituted and the hardware profile was
not claimed as run. Windows and suitable mixed-scale macOS hardware execution
locations were requested while local validation continued.

The full Electron native-integration command passed both files / six tests on
macOS (`/tmp/rion-native-integration-full.log`), including the startup fixture
and Local Font Access probe. This is current macOS evidence only. The retained
Tauri full desktop profile subsequently completed as recorded below
(`/tmp/rion-tauri-full-native.log`). No parallel renderer builds were run.


### Retained Tauri macOS full profile: CP-02 / CP-13 / CP-15 / CP-18

The complete stable macOS `full` profile passed on the current dirty worktree:
all 39 journeys PASS; 29 phases PASS plus three expected forced-termination
phases, each with an explicit expected-termination receipt and zero runner exit.
It ran from 01:34:37 to 01:41:05 UTC on 2026-09-06, source HEAD
`a7a48418bcb9bffd1c91292719a609198e0cdbb4`. Report:
`.desktop-e2e-artifacts/2026-09-06T01-34-37-128Z-darwin/report.json`.

This verifies the retained WKWebView/AppKit path after settings removal and the
shared Canvas fallback change, including settings, macro/input, Role isolation,
workspace ownership, cross-domain topology, persistence and crash recovery.
It does not substitute for WebView2/Windows execution or the Chromium hardware
profile. Together with the previous 49-journey Chromium macOS report, both local
shell paths now have complete smoke/full-profile evidence; hardware, Windows,
exact-candidate packaging/updater and migration release gates remain open.

Electron production build and pure-renderer verification passed after the Tauri
run (`/tmp/rion-tauri-full-production-restore.log`, 36 sources / 3,275,470 bytes),
restoring the intended non-instrumented Chromium build output. Coverage, source
hygiene and whitespace validation passed after the ledger update.

### Hosted CI audit and native tab lookup follow-up

Existing GitHub Actions Windows runners are available. Run `33996548461` on
commit `1130331d0a1f266bfa4838b47ec7a641d7ca1928` passed native validation and
retained Tauri desktop E2E on both platforms. Both Electron package jobs failed
during unpackaged smoke, before packaging. This older revision does not validate
the current dirty worktree. Windows failed at contained-fullscreen escape; local
HEAD `a7a48418` includes the subsequent targeting fix, pending hosted validation.

The macOS failure occurred while locating Chromium Tabs Gamma through an
unrestricted accessibility `entire contents` traversal. The precise cause of
the subprocess failure was not established. Native tab activation now traverses
at most 512 accessibility elements and skips AXWebArea descendants, preserving
exact tab identity, native window ownership checks, and physical click input.
This avoids inspecting game-page contents when locating native tab chrome.

After correcting a helper integration error found by the first local run,
both visible-tab seed and restart phases passed:
`.desktop-e2e-artifacts/2026-09-06T01-52-39-206Z-darwin/report.json`.
The adjacent source suite passed five tests; lint had zero errors and the same
23 existing warnings; source hygiene and E2E coverage passed. Production Electron
build and pure-renderer verification passed afterward (36 sources / 3,275,470
bytes; `/tmp/rion-native-tab-production-restore.log`). This test-infrastructure
change is lower-layer-covered and does not introduce a product journey.

Current-revision Windows smoke/package validation, mixed-scale physical macOS
hardware, and exact-candidate release/updater gates remain pending. Availability
of the hosted Windows runner resolves the execution-location uncertainty; it
does not resolve those gates without a successful current-candidate run.

### CP-08 isolated native Chromium input probe

Added `scripts/probeChromiumInput.cjs` and its native integration test to the
existing macOS/Windows native-validation matrix. Each platform uploads a JSON
report containing runtime versions, exact submitted input, DOM event order and
trusted/modifier/button/coordinate fields, plus host and document focus and
visibility before and after submission. The bounded observation deadline reports
`indeterminate`; it never means successful delivery. No production adapter,
permission, automation transport, or runtime contract changed.

The current macOS run on bundled Electron 43.4.1 / Chromium 150.0.7871.224
received all ten expected sample sequences: foreground keys, Shift plus repeat,
middle button at 100% and 150% zoom, held key before reload and release in the
new document, fresh post-reload keys, hidden view, visible background host, and
hidden host. Every recorded event was trusted. Background/hidden-host samples
preserved an unfocused target. At 150% zoom, input coordinates (120, 90) produced
DOM coordinates (80, 60); conversion must remain explicit in any candidate
adapter. Report: `/tmp/rion-chromium-input-probe/chromium-input-darwin.json`;
test log: `/tmp/rion-chromium-input-probe-test.log`.

The [pinned Electron documentation](https://github.com/electron/electron/blob/v43.4.1/docs/api/web-contents.md#contentssendinputeventinputevent)
still specifies a focused containing BrowserWindow. The observed background
delivery is empirical evidence for this isolated configuration, not a supported
cross-platform guarantee. These samples use a sandboxed WebContentsView fixture,
not the retained AppKit Role host or a generation/epoch-fenced runtime input
lane. Releasing a key in a new document is not proof of old-document retirement.
Actual Role ownership transfer, stale document exclusion, complete native
receipt equivalence and Windows execution remain open; no replacement decision
is inferred from the test passing. AppKit trusted input remains required.

Validation: the native probe passed one test covering ten samples; eleven
release-workflow tests, focused ESLint, JavaScript syntax, TypeScript build and
repository hygiene passed. E2E omission reason is `lower-layer-covered`: this
adds API research evidence without changing product behavior or journey routes.
The new Windows probe has been wired into CI but has not yet run there.

### Current candidate CI dispatch and migration-boundary correction

The accumulated implementation and local validation were committed as
`a05c0466d776f2760bbe95209bd513af46965e35` on the existing migration branch.
Exact-SHA CI run [34005498824](https://github.com/rion-tw/rion-studio-source/actions/runs/34005498824)
started the paired native/E2E/package jobs. Its checks and macOS package job
failed at `verify:system-only`: the new isolated input probe had not been added
to the migration-only Electron token allowlist. Local execution reproduced the
same error. This is a test-tool registration failure, not native input parity
evidence. No failed or unexecuted downstream phase is counted as passing.

Added only `scripts/probeChromiumInput.cjs` to the existing exact-path allowlist,
alongside the Local Font Access probe. The production source roots, forbidden
tokens, and runtime migration gates remain enforced. The executable migration
gate and its eight focused tests passed locally; the corrective commit requires
a new exact-SHA CI run. Existing local native evidence remains qualified by the
source revision and scope recorded above.

### CP-07 terminal-event source audit while native CI runs

Source inspection at corrective commit `e94c26a90d754d420cbfec825433f54bc9e15594`
identifies a concrete replacement constraint. In
`crates/rion-node/src/windows_runtime_shortcut_owner.rs`,
`classify_f11_transition` consumes the initial plain key-down and subsequent
repeats, then emits once on the captured key-up even when modifiers changed
during the press. The hook first selects the exact registered foreground HWND;
its callback is acknowledged through the current owner revision before dispatch.
The source explains why dispatch waits until the native input transaction exits:
fullscreen entry from key-down can reenter that transaction.

By contrast, the host `before-input-event` listener in
`chromiumRuntimeHostFactory.ts` and the managed surface interceptor in
`chromiumRoleQuickAccessShortcut.ts` dispatch on non-repeat key-down and match
plain modifiers separately for each event. The application menu still disables
F11 accelerator registration. These existing paths therefore are not evidence
that removing the hook preserves its terminal-event semantics.

The CP-07 physical replacement matrix must additionally measure command timing
relative to key-up, repeated downs, modifier changes during a captured press,
focus/owner change before release, and registration retirement. Capture the
authoritative native and page event order for both mechanisms; a fullscreen
toggle alone cannot establish equivalence. This audit does not change input
behavior, assert that a race occurred, or close the native replacement probe.

Exact corrective CI run
[34005620760](https://github.com/rion-tw/rion-studio-source/actions/runs/34005620760)
has passed the prior migration-boundary step and entered macOS Chromium E2E.
Both platform results remain pending until terminal job and artifact evidence
is inspected. The superseded run was explicitly cancelled after its verified
boundary failure; its unfinished jobs are not acceptance evidence.

### CP-08 expanded modifier and hidden-pointer samples

Extended the isolated input probe with Control, Alt and Meta press/chord/release
sequences and middle-button down/up in hidden-view, background-host and
hidden-host states. The expanded macOS run received all 16 expected sequences;
the recorded modifier fields were set for the chord and cleared on release,
and background/hidden hosts remained unfocused before and after pointer input.
This closes gaps in the API experiment's sample inventory, not the actual Role
adapter equivalence gate. Report:
`/tmp/rion-chromium-input-expanded/chromium-input-darwin.json`; native test log:
`/tmp/rion-chromium-input-expanded.log`.

The native probe test, focused ESLint and executable migration-boundary check
passed. This is lower-layer-covered research infrastructure with no product
journey change. These added samples are working-tree changes after `e94c26a9`;
run `34005620760` still validates the earlier ten-sample probe and cannot be
cited for the expansion. Its live jobs are left running to obtain their exact
candidate results.

### Windows cfg and macOS restart-history findings from e94c26a9 CI

Windows native job `101412221427` failed Rust lint after diagnostic removal:
two WebGL imports remained at the shared runtime root, and macOS experiment
types/functions were still compiled without Windows consumers. Moved the two
imports into the macOS adapter, gated experiment types/implementation to macOS
or tests, and gated the environment-reading function to macOS. No dead-code
allowance was added. Local native Rust lint, complete Rust tests, Tauri build,
Electron build and pure-renderer verification passed. Windows verification of
the correction remains pending. Log: `/tmp/rion-e94-windows-native.log`.

The macOS Chromium job `101412129350` reached Web-only restart and failed the
post-run evidence predicate. Its artifact contains hidden `activating` followed
by visible `ready`, with the same exact tab/window/surface/native owner and
generations. The predicate incorrectly required every startup observation to
already be ready. It now accepts initial hidden activation followed by ready,
while fencing the entire history to the terminal identity and rejecting
post-ready regression or generation/owner changes. Seven focused tests passed,
including positive and negative histories for both platforms. The corrected
validator accepts the downloaded CI artifact; this is artifact revalidation,
not a fresh successful full-profile run.

The Windows Chromium job `101412129373` still fails HTML fullscreen Escape.
Unlike the earlier run with no key events, this candidate records trusted
Escape down/up in the expected page but no `contained-fullscreen-exit` receipt.
This narrows the failure beyond input targeting; the cause is not yet proven.
Logs and downloaded artifacts are under `/tmp/rion-e94-windows-package.log`,
`/tmp/rion-e94-win-artifacts` and `/tmp/rion-e94-mac-artifacts`. Other live jobs
remain independent evidence; no full native acceptance or CP-17 gate is closed
by these partial results.

### Escape driver reproduction and correction

An isolated sandboxed WebContentsView on the pinned macOS Electron/ChromeDriver
reproduces the Windows symptom using the same generic W3C key action: a visible
click enters HTML fullscreen, Escape does not exit, and the document remains
fullscreen. Sending `Input.dispatchKeyEvent` through that same ChromeDriver with
explicit Escape code plus Windows/native virtual-key values exits fullscreen.
A separate low-level experiment shows that a missing Windows virtual-key value
can produce the same non-exiting behavior; the exact Windows W3C wire payload
has not been captured, so its missing-field cause remains an inference.

Added the shared E2E-only `sendChromiumEscapeKey` helper. The Windows page action
keeps the existing exact URL and document-focus fence, then sends both key
halves through ChromeDriver with complete codes. It does not invoke
`document.exitFullscreen`, call a product debug action, or change production
fullscreen behavior. AppKit Escape retains its native input path. Journey:
`CHROMIUM-WINDOWS-WORKSPACE-WEB-FULLSCREEN-017`; the existing contained-fullscreen
spec remains the acceptance action.

The new native integration test uses that same helper after a visible fixture
button click, independently observes DOM fullscreen exit, and records the
generic-W3C comparison. Any research-case cleanup runs only after the helper's
exit assertion. macOS passed; report:
`/tmp/rion-fullscreen-native-regression/fullscreen-escape-darwin.json`.
The fixture automatically joins both native CI platforms and their existing
input-report upload. Windows correction acceptance is still pending a new run.

CI `34005620760` is terminal: renderer build, shared checks, Linux sanitizer,
both retained Tauri desktop jobs and macOS native validation passed. Both
Chromium package jobs and Windows native validation failed as recorded above.
These are exact `e94c26a9` results; the subsequent working-tree corrections are
not retroactively validated by that run.

Before corrective submission, all four Electron native integration files / eight
tests passed on macOS (`/tmp/rion-escape-all-native.log`), including the expanded
input and shared Escape helper probes. Twelve focused E2E evidence/source tests,
focused ESLint, TypeScript, repository hygiene and whitespace checks passed.
The previously recorded native Rust checks and dual-shell builds cover the cfg
correction. Windows native lint and the paired Chromium smoke/package jobs must
still run on the corrective commit.

### Downloaded hosted Tauri and font evidence at e94c26a9

Inspected the actual Windows Tauri report from CI `34005620760`, artifact
`desktop-e2e-Windows-34005620760-1`: 39 journeys PASS; 29 phases PASS plus three
expected forced terminations. The clean `e94c26a9` checkout ran the `full`
`tauri-v22` profile from 02:08:45 to 02:20:19 UTC on 2026-09-06. Local copy:
`/tmp/rion-e94-tauri-windows/2026-09-06T02-08-44-938Z-win32/report.json`.
This supplies retained Windows/WebView2 settings-removal and full-journey
evidence. It does not certify Chromium Windows or cure that run's Rust lint
failure. CP-02/13 now distinguish the passed legacy paths from outstanding
Chromium Windows acceptance.

Also inspected `local-fonts-macos-latest-34005620760-1`. The hosted Mac returned
528 Chromium faces / 180 unique families, stable across automatic, shown and
reloaded queries without user activation. Denied permission, subframe, changed
document and different owner queries returned empty inventories. Its Rust
provider returned 3,150 names, including every Chromium family: 2,970 additional
names include 2,244 dot-prefixed names and 235 font-file names (categories may
overlap). Unlike the local Mac's overflow fallback, this host exposes the native
collector's broad name walk directly. This is positive evidence that Chromium
enumerates public families without the collector's file/face-name noise; it
does not prove compatibility for previously persisted private/face selections.
Report: `/tmp/rion-e94-fonts-macos/local-fonts-darwin.json`.

The probe source is unchanged between `e94c26a9` and `453d1f53`; the evidence is
still explicitly attributed to the earlier run. CP-05 remains open for Windows
and the final adoption assessment. Current CI `34006922119` continues against
exact `453d1f5354e6f646854fe89ac1255ec0b8d4d3b3`.

### CommonJS fixture lint classification

Current CI's Windows native job passed the previously failing Rust lint step
and entered the workspace tests. Its shared checks job `101415749279` instead
found that the newly added `.cjs` fixture was outside ESLint's existing
Node/CommonJS file scope. Extended that existing scope from scripts to
`tests/fixtures/**/*.cjs`; the fixture remains fully linted with the same
CommonJS rules, rather than ignored. Full local lint now passes with zero errors
and the same 23 pre-existing renderer warnings
(`/tmp/rion-453-fixture-lint.log`). The current native jobs remain running on
`453d1f53`; this lint-configuration correction has not been submitted to CI yet.

### Windows Escape passed; popup parent-revision assertion corrected

Windows Chromium job `101415749268` passed the previous Escape exit boundary
and continued to the popup creation assertion. It failed at line 693 because
the parent topology revision remained 8 instead of increasing. The popup
coordinator captures the current parent revision when opening a separate popup;
it does not mutate parent topology. A native focus event can incidentally advance
the revision, explaining why the strict increase was not a portable invariant.

Changed that assertion to require a non-regressing parent revision. Exact parent
window/generation/layout/slots and independent popup host/revision checks remain
in place, as do the later authoritative popup lifecycle fences. This changes
test semantics to match the source owner contract, not product behavior or the
required journey outcome. Twelve focused tests, typecheck and E2E coverage
passed. Native Windows acceptance of the remaining popup sequence is pending;
passing Escape alone does not establish the full
`CHROMIUM-WINDOWS-WORKSPACE-WEB-FULLSCREEN-017` journey.

### CP-03 / CP-10 Windows Chrome import physical-path correction

Windows native job `101415823077` passed lint but failed three Core Chrome
import tests with `CHROME_PROFILE_IMPORT_PATH_IDENTITY_MISMATCH`. The failure
occurs before the import effects: `canonical_role_paths` compared a canonical
physical root retaining the Windows verbatim prefix with a Chromium wire path
whose prefix had been removed. `Path::strip_prefix` correctly rejects those
different lexical representations even when they identify the same directory.

The import contract now constructs its physical target through the shared Role
browser-directory helper and validates each component against the physical
canonical root before generating the existing Chromium wire record. It does
not normalize arbitrary paths to bypass containment checks or remove symlink
and intermediate-directory checks. A native filesystem regression covers
canonical-root acceptance and, on Windows, the distinct physical/wire prefixes;
another test confirms that an intermediate ordinary file remains rejected.

The two focused path tests and two existing matching import-contract tests
passed locally. Full macOS Rust tests passed 1,640 tests with four ignored;
Rust formatting and all-target Clippy passed after moving the focused tests to
a feature-specific child module. Windows acceptance remains pending. Evidence:
`/tmp/rion-453-windows-native.log`, `/tmp/rion-import-path-focused.log`,
`/tmp/rion-import-contract-focused.log`, `/tmp/rion-import-path-rust-lint.log`,
`/tmp/rion-import-path-rust-tests.log`. E2E omission is `lower-layer-covered` by
the filesystem and import transaction tests, not a waiver of native Windows CI.

Both shell builds subsequently passed (`/tmp/rion-import-path-build.log` and
`/tmp/rion-import-path-electron-build.log`). The final renderer was restored to
the pure Electron bundle (36 sources, 3,275,470 bytes). Source hygiene, AI context
validation and `git diff --check` passed as well.

### Follow-up native CI: restore visibility and Windows popup close

CI `34007374169` at `e70f47dd` passed shared checks. macOS Chromium job
`101416964234` observed `[ready hidden, ready visible]` on Web-only restart:
readiness and native visibility are separate authoritative events. The evidence
validator now orders activation against the first ready observation, while still
requiring a visible ready terminal and identical tab/window/attempt/native/surface
identities throughout. Paired platform tests reject activation after readiness,
changed identities and histories without visible completion. The downloaded
history validates; a fresh local seed/restart passed in
`.desktop-e2e-artifacts/2026-09-06T03-03-56-589Z-darwin/report.json` (dirty
`fc5affaf`, macOS Chromium profile, both selected phases PASS).

Windows job `101416964239` progressed through main/popup website and Escape
fullscreen exits, then failed selecting a nonexistent popup tab row. A Windows
popup is a standalone Core-admitted window without Game Window tabs. The E2E now
selects its exact published logical window ID before clicking the visible close
control. Source review and the focused regression also identified missing initial
popup chrome publication and incorrect routing of that control to the ordinary
Game Window stop command. The Windows factory now projects the admitted standalone
window with empty tab membership; its close control uses the existing popup
lifecycle observer and waits for the exact native closed event. Core retains
popup terminality. The native window-close event follows the same observer.

The affected automated journey is
`CHROMIUM-WINDOWS-WORKSPACE-WEB-FULLSCREEN-017`; its manifest description and
adjacent visible E2E were updated. macOS AppKit close remains covered by
`CHROMIUM-MACOS-APPKIT-WORKSPACE-WEB-FULLSCREEN-017` with the same logical popup
identity. The host-factory suite passes 37 tests, including visible-control
admission to the popup observer before any closed receipt. Twelve focused E2E
validation tests passed. Windows native acceptance of these new changes is
pending a new exact-SHA CI run; the earlier failure is not relabeled as success.

The completed local validation for this follow-up is 428 Vitest files / 3,287
tests, typecheck, lint (zero errors; 23 existing warnings), source hygiene,
E2E coverage, AI context validation and the Electron build. The final bundle is
pure Electron (36 sources, 3,275,470 bytes). Logs are
`/tmp/rion-popup-close-full-tests.log`, `/tmp/rion-popup-close-typecheck.log`,
`/tmp/rion-popup-close-lint.log`, `/tmp/rion-popup-close-hygiene.log`,
`/tmp/rion-popup-close-coverage.log`, `/tmp/rion-popup-close-build.log` and
`/tmp/rion-e70-web-only-local.log`. The prior physical-path fix was submitted as
`fc5affaf` to CI `34007906617`; its still-running native jobs remain separate
from the popup/visibility changes recorded here.

### Windows native shortcut helper observation boundary

Run `34008237883` at `1893e7e2` reached Windows Chromium native E2E but job
`101419316990` failed the initial `newGameWindow` OS shortcut before the popup
journey. The PowerShell process reached its existing 30-second deadline and was
terminated, with no stdout/stderr. The final Core journal and SQLite artifact
contain no runtime or saved Game Window, so this run supplies no evidence that
the shortcut's intended action completed. It also cannot establish which helper
stage stalled or assess the popup fix.

Added four fixed diagnostic stage markers around native-input compilation,
exact-window selection and SendInput submission. These are test-helper stderr,
not product performance diagnostics. The original deadline, exact PID/foreground
checks and inserted-input-count requirement remain unchanged; no retry or elapsed
success was added. Nine adjacent tooling tests, typecheck, source hygiene and
diff checks passed. E2E omission for the logging-only change is `internal-only`;
Windows execution of the actual user journeys remains pending.

Evidence: `/tmp/rion-189-windows-package.log`,
`/tmp/rion-189-win-artifacts/2026-09-06T03-10-27-155Z-win32/report.json`,
`/tmp/rion-shortcut-stage-tests.log`, `/tmp/rion-shortcut-stage-typecheck.log` and
`/tmp/rion-shortcut-stage-hygiene.log`. Remaining jobs in that run were left
running; no new workflow was dispatched to supersede their native evidence.

### Exact-candidate macOS compatibility receipts (`1893e7e2`)

Native validation in run `34008237883` uploaded macOS font/input evidence before
finishing its final Tauri build. Bundled Electron 43.4.1 / Chromium
150.0.7871.224 reports 528 faces / 180 families for automatic, shown and reloaded
font enumeration; each denied, subframe, navigated and other-owner sample returns
zero faces. The native comparison contains 3,150 names, 2,970 native-only and no
Chromium-only families. The 16 isolated input samples all report `received`.
The separate Escape fixture again records generic W3C retaining fullscreen and
complete key codes exiting fullscreen. Files are
`/tmp/rion-189-fonts-macos/local-fonts-darwin.json`,
`/tmp/rion-189-input-macos/chromium-input-darwin.json` and
`/tmp/rion-189-input-macos/fullscreen-escape-darwin.json`.

The pinned Electron declaration (`node_modules/electron/electron.d.ts`,
`WebContents.sendInputEvent`) expressly requires the containing BrowserWindow to
be focused. Successful isolated hidden/background samples therefore demonstrate
observed behavior on this build, not a supported background delivery contract.
They do not authorize replacing the unfocused Role lane or retained AppKit input.
Windows probe receipts and the explicit CP-05/07/08 decisions remain outstanding.

### Windows API receipts and full retained-shell evidence (`1893e7e2`)

Windows native job `101419407676` passed Rust formatting/Clippy and the Rust test
step, then completed the Electron compatibility suite. It uploaded 260 font
faces / 89 Chromium families against 154 native names: 66 native-only names and
one Chromium-only family (`Franklin Gothic`). Automatic, shown and reloaded lists
match without user activation, and denied/subframe/navigated/other-owner samples
all return zero faces. All 16 isolated Windows input samples report `received`;
the Escape comparison matches macOS (generic W3C remains fullscreen; complete key
codes exit). Artifacts are under `/tmp/rion-189-fonts-windows` and
`/tmp/rion-189-input-windows`. Full native job acceptance remains separate from
these completed steps.

Both retained Tauri `full` profiles also passed at clean `1893e7e2`, each with
39 PASS journeys and 29 PASS phases plus three expected forced terminations:
`/tmp/rion-189-tauri-windows/2026-09-06T03-10-30-748Z-win32/report.json` and
`/tmp/rion-189-tauri-macos/2026-09-06T03-09-53-105Z-darwin/report.json`.

macOS Chromium passed 36 phases before `chromium-system-settings` failed because
System Events denied osascript assistive access (`-25211`) while cancelling a
native save panel. This is a required native-UI gate, not a font assertion
failure. Evidence is `/tmp/rion-189-macos-package.log` and
`/tmp/rion-189-mac-artifacts/2026-09-06T03-09-51-899Z-darwin/report.json` (the
report records a dirty CI worktree). No permission bypass or weaker cancellation
assertion was introduced.

### CP-05 full font-name comparison follow-up

The family-only Windows difference includes style names such as `Arial Black`.
That alone cannot prove that Chromium lacks the corresponding face. The probe now
records each FontData family, full name, PostScript name and style, and separately
lists native names absent from all three Chromium name fields after Core-compatible
whitespace/case normalization. Denied frames must expose no face metadata. This
avoids deciding against the Chromium provider from a narrower field than the API
actually offers. No product font provider or permission policy was changed.

The expanded macOS native probe passed; this local host's native provider used
its 16-name fallback, so it is not substituted for the hosted Mac native inventory.
Typecheck, lint (zero errors, 23 existing warnings), source hygiene and diff checks
passed. Logs: `/tmp/rion-font-alias-native.log`,
`/tmp/rion-font-alias-typecheck.log`, `/tmp/rion-font-alias-lint.log` and
`/tmp/rion-font-alias-hygiene.log`. The expanded Windows alias comparison remains
pending the next run. This probe-only change is `internal-only` for E2E purposes.

Run `34008237883` subsequently completed: Windows native validation also passed,
including Windows renderer tests and the Tauri build. CP-14 now has both native
validation jobs; CP-03 has both native Rust gates, while its Windows Chromium
journey remains pending. Both Chromium package jobs remain failed for the exact
reasons above; neither API-probe success nor Tauri parity overrides those gates.

### CP-02 remaining Core telemetry retirement

A follow-up source audit found an internal performance telemetry path left behind
after the user-visible diagnostics removal. Every Core startup still created
`TelemetryWorker`, including its periodic wake and sample buffer; the internal
`telemetryRecord` / `telemetrySnapshot` commands and startup output-path option
also remained. No active shell was supplying that path or sending samples.

Removed the worker, startup/shutdown plumbing, effect-result telemetry copies,
both commands, their four retired record/metric types and the unused startup
option across Core, Node-API, Electron and retained Tauri constructors. Binding
removal is generated by Rust's explicit retired-output list. A behavior regression
rejects both retired command names at deserialization. The independent, still-used
Core effect metrics query and retained WebGL policy types remain intact; offline
benchmark readers of existing artifacts do not launch a product telemetry worker.

Full macOS validation passed 1,636 Rust tests (four ignored), 428 Vitest files /
3,287 tests, Rust formatting/Clippy, TypeScript checking, lint, source hygiene,
Tauri build and pure Electron build (36 sources, 3,275,470 bytes). The changed
Rust contracts still require a new Windows native gate. Relevant logs start with
`/tmp/rion-telemetry-`; the removal is `internal-only` for E2E purposes because
there was no remaining renderer control or active bridge caller to exercise.

### Windows visible popup close now reaches authoritative terminality

Run `34009301032` at `881997a6` passed the earlier Windows shortcut helper step
and executed the popup's visible close, then failed the remaining parent-revision
`> 8` assertion with revision 8. Source ownership is the same as for popup open:
popup terminality belongs to the popup lifecycle, and closing it need not advance
the parent's Game Window topology. The E2E now requires non-regression of that
parent revision and directly waits for the exact popup/open-operation
`nativeClosed` receipt, with user close reason, native-destroyed completion scope,
closed lifecycle and applied outcome. Geometry and parent focus checks remain.

The paired journey IDs are
`CHROMIUM-MACOS-APPKIT-WORKSPACE-WEB-FULLSCREEN-017` and
`CHROMIUM-WINDOWS-WORKSPACE-WEB-FULLSCREEN-017`. Twelve adjacent E2E evidence tests,
typecheck and E2E coverage passed. Fresh native macOS seed/restart passed;
Windows acceptance remains pending. Evidence:
`/tmp/rion-881-windows-package.log`, `/tmp/rion-881-win-artifacts`,
`/tmp/rion-popup-closed-evidence-tests.log` and `/tmp/rion-popup-closed-coverage.log`.

The fresh focused macOS report is
`.desktop-e2e-artifacts/2026-09-06T03-45-35-905Z-darwin/report.json`: dirty
`881997a6`, four selected entity/fullscreen seed/restart phases PASS and seven
journeys PASS. The two new popup terminal assertions execute through visible
AppKit close, followed by the exact Core receipt. Retired command rejection and
Rust binding regeneration also passed after final source formatting. The final
production Electron bundle was restored and source hygiene rechecked; logs are
`/tmp/rion-popup-closed-local.log`, `/tmp/rion-telemetry-retired-test.log`,
`/tmp/rion-telemetry-final-generate.log`,
`/tmp/rion-telemetry-final-electron-build.log` and
`/tmp/rion-telemetry-final-hygiene.log`.

### Role Session native visibility and launch-test terminality

Run `34009301032` at `881997a6` completed both Tauri desktop jobs and Windows
native validation successfully. Windows Chromium failed at the parent popup
revision assertion documented above. macOS Chromium passed 40 phases before
the Role Session restart assertion inspected the second Role while its native
surface was still hidden after Core had reported Running. The shared E2E helper
now observes both visible surfaces in the same native host before inspecting
session identity, generation and isolation. These existing assertions remain.

Fresh macOS `chromium-macos-appkit-smoke` focused seed/restart passed journey
`CHROMIUM-MACOS-APPKIT-ROLE-SESSION-ISOLATION-003` at dirty `c6efac6b`,
03:57:40–03:58:07 UTC, recorded in
`.desktop-e2e-artifacts/2026-09-06T03-57-40-717Z-darwin/report.json`. The paired
Windows journey `CHROMIUM-WINDOWS-ROLE-SESSION-ISOLATION-003` remains pending.
Three adjacent source tests, typecheck, E2E coverage, source hygiene and restored
production Electron build passed; logs use `/tmp/rion-role-visible-`.

The remaining macOS native job's live log identifies
`chromium_browser_workspace_stop_retires_kernel_and_ownership_topology` as
running beyond 60 seconds. Its launch helper previously stopped consuming
effects when invocation admission returned, although launch completion runs
separately. An effect emitted between the old subscription and the subsequent
stop subscription could remain unanswered. The stop topology test now uses the
existing exact-operation `BrowserLaunchCompleted` helper before issuing stop,
preserving all create/destroy and empty-topology assertions for both explicit
platforms. Production event policies are unchanged. This is `internal-only`
test-harness work. The old job is not passing native evidence.

The old macOS native job was explicitly cancelled after identifying that
unanswered-effect race; its terminal log is
`/tmp/rion-881-macos-native-cancelled.log` (the named test exceeded 60 seconds at
03:43:52 UTC). Cancellation is not a passing gate.

### Windows complete Local Font Access name comparison

The successful Windows native job at `881997a6` recorded 260 Chromium faces,
89 families and 154 native names. Comparing `family`, `fullName` and
`postscriptName` covers 49 of the 66 names missing from the family-only list.
Seventeen native names still have no exact normalized match, including the
legacy `Fixedsys`, `System` and `Terminal` names and several truncated
Bahnschrift / Segoe UI Variable names from GDI's fixed-size face-name field.
This establishes a naming compatibility gap, not proof that Chromium cannot
render those fonts. Evidence is
`/tmp/rion-881-fonts-windows/local-fonts-win32.json`. The hosted macOS complete
alias comparison did not run because its preceding Rust gate was cancelled;
CP-05/06 remain open for that result and the explicit provider decision.

The corrected launch/stop harness passed full macOS workspace validation:
1,636 Rust tests, zero failures, four ignored; Rust formatting and Clippy passed.
Documentation, AI context, desktop isolation, E2E coverage, source hygiene and
changed-spec lint also passed. Logs are `/tmp/rion-stop-terminal-tests.log`,
`/tmp/rion-stop-terminal-lint.log` and adjacent `rion-stop-terminal-*` logs.
The new Windows Rust and both complete Chromium profiles remain pending the
next exact-commit CI run; previous failures are not reclassified as passes.

Fresh CI run [34010684582](https://github.com/rion-tw/rion-studio-source/actions/runs/34010684582)
is validating exact commit `8f474391b51c3e8d3b453754582f6084366dd31a`, including
the telemetry removal and both E2E corrections. Its seven initial jobs started;
none is yet passing evidence. A preceding dispatch (`34010670635`) used a
mistyped checkout ref and was promptly cancelled and replaced; it provides no
validation evidence. The pure Electron production renderer is restored locally.

### CP-08 replacement decision: retain native submission

The pinned Electron 43.4.1 declaration at
`node_modules/electron/electron.d.ts` documents that the containing BrowserWindow
must be focused for `WebContents.sendInputEvent()` to work. Both isolated native
probe reports at `1893e7e2` nevertheless observed all 16 samples, including hidden
views, background hosts, hidden hosts, modifiers, middle clicks at two zoom
factors and held-key/reload sequences. These observations are useful regression
evidence but cannot expand the API's supported focus contract. They also do not
claim exact production Role identity or native-neutrality proof.

Decision: retain Windows native submission and the explicitly required AppKit
trusted-input adapter. Background Role execution must not acquire focus. A
foreground-only `sendInputEvent()` path would leave the complete native lane
necessary for background execution and would introduce a second submission
owner across focus changes and held-key release. There is no demonstrated
maintenance reduction or equivalent cross-owner cleanup protocol to justify
that partial replacement. This is a compatibility decision based on the
pinned API contract, not a claim that the successful hidden probes failed.

The common Core input epoch, Role/document fence, automatic-input preflight,
pending sequence, authenticated DOM decoder, cancellation and retirement remain
shared under CP-09. Native dispatch still requires exact child/parent identity,
binding revision, native submission and the complete trusted DOM sequence;
neither elapsed time nor an Electron void return becomes success. The existing
Windows adapter tests explicitly cover hidden delivery without changing the
foreground owner, obsolete binding/probe revision, lost focus evidence and
untrusted input. Coordinator tests cover held-key document replacement and
exact-generation recovery. Full current-commit native Macro/reload acceptance
is still required in the paired Chromium profiles. CP-08's replacement decision
is now settled; its acceptance is not inferred from this source audit.

CP-08/09's seven focused coordinator, runtime, adapter, pending-lane and preload
suites passed 89 tests on macOS (`/tmp/rion-cp08-retained-input-tests.log`).
This lower-layer evidence validates retained receipt and lifetime invariants;
it is not Windows native input or a replacement Role probe. Documentation, AI
context and source hygiene checks also passed. No product behavior changed.

### CP-07 native F11 comparison harness

Added a Windows-only bundled-Electron probe comparing the retained native hook,
a captured-key-up `before-input-event` candidate, and a registered Menu F11
accelerator. A persistent PowerShell test driver validates the exact HWND/PID
and foreground owner before inserting native scan-code input. Four isolated
surfaces (main, Role-like view, Global-Web-like view and popup) each receive
plain, repeated-down and modifier-during-press sequences in all three modes:
36 observations. Reports record commands before release, native/pre-input event
stages and trusted page events. The native-hook baseline requires one terminal
command and no observed page delivery; API candidates report differences.

This is an isolated compatibility probe, not production Role/window parity.
The 150 ms test observation boundary does not establish indefinite suppression.
Hidden/focus-transfer/registration-retirement coverage and the production
replacement decision remain open. Production input ownership is unchanged.
The native integration runner discovers the new Windows-only test and uploads
its report through the existing Chromium input evidence directory; macOS
explicitly skips it. E2E classification: `internal-only`.

Syntax, TypeScript, lint, migration-boundary validation and eight boundary tests
passed locally (`/tmp/rion-cp07-*`). macOS test selection reported one skip,
not a native F11 pass. Windows execution awaits the next source push after
current CI terminality.

### Current Windows fullscreen E2E navigation-driver boundary

At `8f474391`, Windows Chromium run `34010684582` passed seven phases / nine
journeys before failing the pending-popup parent-close portion of
WORKSPACE-WEB-FULLSCREEN-017. The prior visible popup close and its exact
user/nativeDestroyed receipt passed. With the second popup's navigation
deliberately gated, `windowsRuntimeHostHandle` times out enumerating WebDriver
window handles before it can click the parent tab close control. macOS already
uses pre-read native close evidence for this scenario. Windows needs an exact
visible close action that does not enumerate the pending browser targets;
releasing the network gate before close would invalidate this journey.
Evidence: `/tmp/rion-8f-windows-package.log` and
`/tmp/rion-8f-win-artifacts/2026-09-06T04-08-47-938Z-win32/report.json`.
Other jobs remain live; macOS native Rust has passed and entered API probes.

### Windows pending-popup close now uses captured native accessibility identity

The fullscreen journey now reads the exact tab/window DOM identity and visible
close button name before gating popup navigation, then binds that name to one
unique native UI Automation control under the exact app PID. It captures the
parent HWND and revalidates that HWND, PID, visibility and unique enabled control
before invoking the visible button. No WebDriver target enumeration occurs in
the pending-navigation close action. The fixture additionally requires the
gated request's transport-cancelled event before the exact popup terminal
receipt. The network gate is not released to make the click possible.

Seventeen focused helper and adjacent E2E evidence tests passed, as did
typecheck, changed-file lint, source hygiene, E2E coverage and desktop isolation.
Fresh local macOS `chromium-macos-appkit-smoke` entity/fullscreen seed/restart
passed at dirty `6a9e9163`; evidence is
`.desktop-e2e-artifacts/2026-09-06T04-24-41-863Z-darwin/report.json`. The pure
Electron renderer was restored (36 sources, 3,275,470 bytes). Logs use
`/tmp/rion-win-pending-close-*`. The affected paired journey is
WORKSPACE-WEB-FULLSCREEN-017; Windows native execution remains pending.

### CP-05 complete native font reports and compatibility interpretation

The `8f474391` macOS native job passed and uploaded its complete font report:
528 Chromium faces / 180 families versus 3,150 normalized native names. Comparing
family, fullName and PostScript name leaves 2,485 native names unmatched. All
but six are dot-prefixed internal names or font filenames ending in .ttc, .ttf,
.otf or .dfont. The six remaining names are AquaKana, AquaKana-Bold, HelveLTMM,
HelveticaLTMM, LastResort and TimesLTMM. The report includes public PingFang
HK/MO/SC/TC, Hiragino and Songti families. Windows includes Microsoft JhengHei
and Microsoft YaHei (and their UI families); 17 native names remain unmatched.

Both platforms pass automatic enumeration without transient activation, reload
and shown-window consistency; denied, subframe, navigated and other-owner
queries return no families. Reports are
`/tmp/rion-8f-fonts-macos/local-fonts-darwin.json` and
`/tmp/rion-8f-fonts-windows/local-fonts-win32.json`. A native-name count is not
a count of CSS-selectable families or evidence of missing Chromium rendering.
The renderer's `getBrowserSystemFontOptions` already merges persisted selected
family names with enumeration and generic families, so changing enumeration
does not inherently delete an existing selection. CP-05/06 must assess that
actual settings behavior rather than retaining filename/internal-name pollution
solely to reproduce the old native inventory. No provider has changed yet.

Run `34010684582` now has both complete Tauri desktop profiles and macOS native
validation passing. Windows Rust also passed and its job reached renderer tests.
Windows Chromium remains failed as documented; macOS Chromium and Windows
full native-job terminality are still pending.

### CP-05 adoption decision and saved-selection behavior

Decision: adopt Chromium's canonical local font families for the v23 provider.
Both native reports prove automatic trusted-owner enumeration, installed CJK
families, stable reload/shown results and denial outside the exact trusted
main frame. The old provider's extra filenames, internal names and truncated
GDI aliases are not an inventory of missing Chromium font families. Reproducing
that pollution would retain platform maintenance without proving better CSS
font compatibility. This decision does not assert that every legacy alias is
renderable or that the operating systems have identical installed fonts.

Fresh renderer behavior tests for explicit darwin/AquaKana and win32/Fixedsys
cases passed: with a provider containing only Arial, the persisted legacy
selection remains displayed, checked and selectable, and is not rewritten.
All 17 browser-font settings tests passed (`/tmp/rion-cp05-saved-font-tests.log`).
The existing generic choices and selected-name merge remain mandatory.

CP-06 will keep the typed listSystemFonts Promise, Rust normalization, bounded
cache and fallback; only the v23 enumeration source changes to the authenticated
app frame's queryLocalFonts. Remote Role/global Web sessions must remain denied.
The retained v22 provider stays reachable until CP-17. Production permission
and provider code have not changed yet, so CP-06 and paired FONT-APPLICATION-033
acceptance are still open. This test-only decision work is `internal-only`.

At `8f474391`, both native validation jobs and both Tauri full desktop jobs are
now terminal success. macOS Chromium completed its source desktop E2E step and
is building release artifacts; its package/updater/black-box gate remains live.
The Windows Chromium failure remains unchanged. Newer local changes still need
their own Windows validation.

### CP-06 Chromium family provider implemented

The typed listSystemFonts bridge now obtains the v23 family inventory from
`chromiumSystemFonts.ts` in the authenticated app WebContents/main document.
Only local-fonts permission for that exact owner and application document is
admitted; other permissions remain denied. The provider fences document
replacement, navigation and renderer loss and refuses stale completion. Native
query rejection or malformed results produce an empty inventory for Rust's
existing fallback; a retired document is an error and cannot populate the cache.

Core's systemFontsList accepts an optional shell inventory. Runtime v23 uses
that inventory (or fallback) and never calls platform font enumeration. v22
continues calling its native provider and ignores Chromium-supplied names.
Rust owns normalization, case-insensitive deduplication, sorting and the cached
result, capped at 4,096 input names. Saved selections and generic choices stay
in the renderer's existing merge; no persisted preference is rewritten.

The native font probe now compiles and exercises the actual production provider
and v23 Core. The already-completed CP-05 native baseline reports remain the
comparison evidence; the Node factory's strict v23 requirement is preserved.
New macOS evidence at `/tmp/rion-cp06-fonts-macos/local-fonts-darwin.json` contains
251 canonical production families and verifies reload, exact-owner/subframe
denial, denied-query fallback input and foreign-navigation rejection.

Validation passed: 430 Vitest files / 3,308 tests; 1,639 Rust tests, zero failures,
four ignored; Rust formatting/Clippy; typecheck; lint (zero errors and 23 existing
warnings); source hygiene; E2E coverage and desktop isolation; Tauri build and
restored pure Electron build. Logs use `/tmp/rion-cp06-*`.

Fresh macOS `chromium-macos-appkit-smoke` settings phase passed at dirty
`559a0af3`, 04:43:11–04:43:40 UTC:
`.desktop-e2e-artifacts/2026-09-06T04-43-11-553Z-darwin/report.json`. Journeys
SYSTEM-SETTINGS-013, DIAGNOSTICS-EXPORT-029 and FONT-APPLICATION-033 passed.
FONT-APPLICATION-033 now requires an installed family outside Rust fallback
(Hiragino Sans on macOS, Segoe UI on Windows), excludes font filenames, and
retains visible Courier New/generic apply, cancel and reset assertions against
live Role font loading and Canvas metrics. The manifest describes this coverage.
Windows native validation of the changed contract/provider and its paired
FONT-APPLICATION-033 remain pending; earlier native runs do not close them.

### Exact-commit CI and macOS offline updater toolchain homes

Fresh run [34012430832](https://github.com/rion-tw/rion-studio-source/actions/runs/34012430832)
validates exact commit `2420e72aa4a26400b06dd371fb2a571788e186f8`, including
Chromium font enumeration, Windows pending-popup native close and the F11 probe.
The workflow concurrency key includes the explicit input SHA, so this run did
not cancel the earlier exact-commit run.

Run `34010684582` at `8f474391` is fully terminal. Both native validation jobs,
both Tauri full jobs, shared checks, renderer and Linux validation passed.
macOS Chromium source E2E passed 52 phases / 49 journeys plus four expected
force-termination phases, recorded in
`/tmp/rion-8f-mac-artifacts/2026-09-06T04-08-18-621Z-darwin/report.json`. Its
release artifacts and previous-version fixtures built, then the packaged updater
probe failed before executing a Rust test: isolated HOME redirected Cargo's
default cache and rustup home, and offline resolution could not find package cc.
Evidence: `/tmp/rion-8f-macos-package.log`. This is not a packaged updater pass.

The macOS transaction harness now pins inherited CARGO_HOME/RUSTUP_HOME or
their original-home defaults before switching HOME/CFFIXED_USER_HOME to the
private runtime profile. The existing runtime environment allowlist already
permits those explicit toolchain paths; private updater signing variables remain
stripped. Windows profile handling and the --locked/--offline Cargo command are
unchanged. No signing, sandbox or publication gate is weakened.

Seventeen focused environment/fixture/sandbox tests, typecheck, lint and source
hygiene passed. A real local macOS `cargo test --locked --offline -p rion-updater
--lib --no-run` with isolated HOME and the pinned toolchain homes built the native
probe successfully (`/tmp/rion-updater-cache-offline-build.log`). This verifies
offline compilation, not the full packaged updater transaction. Additional logs
use `/tmp/rion-updater-cache-*`. This tooling change is `internal-only` for E2E;
the native package gate remains pending a run containing the correction.

### Windows pending-popup close: asynchronous Core command routing

Run `34012430832` reached the visible native parent-tab close in the Windows
Chromium fullscreen seed phase. Core's flow journal recorded `embeddedTabStop`
as started, then rejected it with "asynchronous browser intent reached the
synchronous core dispatcher". The UI Automation action arrived; no popup close
receipt followed because the command never reached its asynchronous handler.
Evidence is `/tmp/rion-2420-windows-package.log` and
`/tmp/rion-2420-win-artifacts/2026-09-06T04-51-03-534Z-win32/`.

`CoreCommand::requires_async_dispatch` now includes `EmbeddedTabStop`, matching
the existing async-only handler. A serialized Node-API command regression checks
the classification, and a real native addon integration test closes a retired
tab through the public invoke boundary and observes the idempotent empty
topology. The exact popup cancellation and native-close E2E assertions remain.

Local macOS validation passed: 1,640 Rust tests, zero failures and four ignored;
Rust formatting/Clippy; six real native Core startup integration tests;
typecheck, lint, source hygiene, E2E coverage, and the pure Electron production
build. Logs use `/tmp/rion-tab-stop-*`. The affected paired journey is
WORKSPACE-WEB-FULLSCREEN-017. Windows native and full Chromium confirmation of
this routing correction remain pending a new exact-commit run. The current run
has passed both Tauri full jobs and macOS native validation, but predates this
correction and the isolated updater toolchain-home fix.

Windows native validation subsequently completed its Rust checks and passed
eight native integration tests, including production Chromium font enumeration.
The font report contains 89 canonical families; reload preserves the inventory,
foreign owners/subframes receive no fonts, permission denial returns an empty
inventory, and navigation retires the provider. Evidence:
`/tmp/rion-2420-win-fonts/local-fonts-win32.json`. CP-06's native provider is now
verified on both systems; Windows FONT-APPLICATION-033 remains pending because
the full Chromium profile stopped earlier at tab close.

The new F11 probe failed before collecting its matrix: Windows PowerShell does
not resolve the `[ushort]` alias used by its test driver. The driver now uses
`[System.UInt16]`, matching the C# method argument without changing any input
semantics or assertions. This fixture-only correction is `internal-only`; its
Windows execution and all CP-07 comparison outcomes remain pending. The other
native test successes do not turn the failed native job into a pass.

### Refreshed macOS Chromium evidence and corrective CI

The downloaded macOS report from run `34012430832`, source `2420e72a`, records
52 passing phases, four expected force-termination phases and all 49 journeys
passing under `chromium-macos-appkit-smoke`. It ran from 04:49:40 to 05:09:20
UTC on 2026-09-06. The report's `worktreeDirty` flag is true; this is source E2E
evidence and must not be presented as a clean packaged production candidate.
Local evidence:
`/tmp/rion-2420-mac-artifacts/2026-09-06T04-49-39-946Z-darwin/report.json`.
The full run includes the updated SYSTEM-SETTINGS-013 and FONT-APPLICATION-033
journeys, extending the earlier isolated macOS settings evidence. Packaging
and updater transaction outcomes remain separate gates.

Corrective run
[34013275719](https://github.com/rion-tw/rion-studio-source/actions/runs/34013275719)
validates exact source `b22dd888d4e6afb7ac930446c6041057803a852a`: asynchronous
tab-close dispatch, the PowerShell F11 input-driver type correction and isolated
updater toolchain homes. Its renderer build passed and both native, desktop E2E
and Chromium package jobs are active. No pending Windows or release item is
closed merely because this new run started.

### CP-07 lifecycle comparison coverage

The isolated F11 probe now adds 36 lifecycle observations to the original 36
key-cycle observations: each of the four surfaces and three mechanisms is
exercised with focus transfer before release, hidden original owner before
release, and registration retirement before release. Native ownership is freshly
registered for each case; the Chromium candidate resets captured state on
retirement, and the Menu candidate removes its registration. Every physical
input insertion still validates the exact foreground HWND and process.

For focus transfer and hiding, the report retains the destination page's trusted
events and the original owner's event sequence, then returns focus and submits
an otherwise uncaptured key-up to expose any stale captured-down state. These
are observations, not assertions that existing native behavior is equivalent
or correct under a different owner. The bounded observation window does not
prove indefinite absence. No production shortcut behavior changes.

Node syntax, typecheck, lint (zero errors, 23 existing warnings), source hygiene
and diff checks passed. The Windows-only native test is explicitly skipped on
macOS (`/tmp/rion-f11-lifecycle-native.log`); the extended matrix still requires
Windows execution and is not part of run `34013275719`. This probe-only change
is `internal-only` for E2E and does not close CP-07.

Each native probe registration now receives a distinct monotonic owner revision.
The callback captures that exact revision for acknowledgement, and both the
outcome and command event record it. The native test rejects command events
whose revision differs from their scenario. Reusing a revision after unregister
could otherwise misattribute a late callback to the next observation; the probe
must not hide that ownership distinction. This changes only test instrumentation.

### Windows completed popup actions and parent-revision evidence correction

Run `34013275719` at `b22dd888` completed the Windows fullscreen seed's visible
actions, including parent-tab close and pending-popup cancellation. The post-run
validator then rejected its evidence because it required the parent window's
topology revision to increase when opening and closing an independently owned
popup. All 14 observations retain parent revision 8, exact host, bounds and slot
identities; popup revision 1 is independently recorded. Parent focus returns
after popup closure. The Core journal contains both exact operation sequences:
nativeReady/pageReady/closeRequested/nativeClosed for user close, followed by
nativeReady/closeRequested/nativeClosed with parentRetired/nativeDestroyed for
the gated popup. The asynchronous tab-close dispatch correction is therefore
observed working in this Windows phase; the overall job still failed.

Evidence is `/tmp/rion-b22-windows-package.log` and
`/tmp/rion-b22-win-artifacts/2026-09-06T05-11-10-610Z-win32/phases/chromium-workspace-web-fullscreen-seed/`.
The validator now accepts non-decreasing parent revisions across independent
popup lifecycles. It retains invariant host/layout/focus checks, exact popup
identity and revision, ordered lifecycle receipts and native-destruction
terminality. Seven focused tests cover unchanged and advancing parent revisions,
backward/missing revisions and forged terminality. Replaying the raw Windows
report locally passes the corrected topology and lifecycle checks and reaches
the native upload path check, which correctly differs after downloading Windows
artifacts to a macOS path. This replay is not a Windows E2E pass; a new native
run remains required for WORKSPACE-WEB-FULLSCREEN-017 and POPUP-012.

A second replay copied the downloaded phase to a separate temporary directory
and changed only the upload fixture's recorded path to its relocated local path.
The complete runtime validator then passed: four contained-fullscreen
transitions, exact popup parent retirement, geolocation/download denial and
native file-upload bytes/hash evidence. The original downloaded artifacts were
not modified. `/tmp/rion-b22-popup-validator-replay.json` records both paths,
scope and result. This verifies the full corrected validator against the captured
Windows seed evidence; it does not claim a new Windows run or restart pass.

### First Windows F11 results and stable-shell pointer evidence

Run `34013275719` passed its Windows native Electron probe step. The 36-case
F11 report is `/tmp/rion-b22-win-input/chromium-shortcuts-win32.json`. All 12
native-hook cases emitted once after release and observed no page F11 events.
The captured-key-up before-input candidate emitted no command in the eight
plain/repeat cases across all four surfaces: the bounded sample contains downs
but no key-up callback. Its modifier cases emitted once. Menu emitted before
release, repeated commands in repeat cases, and exposed two or three trusted
page events. These observations do not establish equivalent replacement
semantics. The additional lifecycle matrix is running at source `11369bb7` in
run `34013552237`; CP-07 remains open until those results are assessed.

The same run's stable Windows full E2E failed in
`p1-cross-domain-topology-force`: the minimize control rectangle cache was empty.
The initialization script publishes on DOMContentLoaded, but the native message
handler is registered only after child WebView creation, so that publication
can precede the receiver. Evidence: `/tmp/rion-b22-win-tauri.log` and downloaded
`/tmp/rion-b22-win-tauri-artifacts/2026-09-06T05-11-28-094Z-win32/`.

The test-only minimize locator now uses the existing exact WebView2 element
rectangle callback used by tab pointer targeting. It reads the visible button
on demand, converts through the exact controller/HWND/DPI path, and preserves
the real SendInput action and pointer terminal receipt. The redundant startup
rectangle cache, publication and conversion implementation were removed. No
polling, delay or debug minimize command was added. macOS Rust formatting/Clippy
and all 1,640 tests passed (zero failures, four ignored), as did source hygiene
and diff checks. Logs use `/tmp/rion-win-minimize-*`. This is `internal-only`
E2E instrumentation; the stable Windows cross-domain profile must still rerun.

### AppKit layout projection supersession during role launch

macOS run `34013275719` failed in `chromium-tabs-visible-seed` with an AppKit
projection error. Core flow entries 287–300 show layout event adapter sequence
3 and topology revision 11, then role ownership completion before its projection
effect executes. The terminal receipt reports current revision 13. Evidence:
`/tmp/rion-b22-mac-package.log` and
`/tmp/rion-b22-mac-artifacts/2026-09-06T05-10-26-320Z-darwin/phases/chromium-tabs-visible-seed/electron-core-flow-observations.json`.

Electron now distinguishes a strictly older topology revision on an otherwise
exact live AppKit host from invalid identity/generation/adapter-sequence errors.
Core uses its existing Superseded terminal status only for a non-committing
Layout event when its own snapshot independently proves the projected windows
remain in the same generation, none regressed, and at least one advanced.
Native application stays false. Other errors retain failure/degraded behavior;
no stale projection is applied and no timer or retry is added. Projection
completion moved to `section_16_appkit_projection.rs` to preserve source limits.

Eleven focused TypeScript tests and the Rust same-generation supersession
regression passed. The latter exercises unchanged Core revisions, advancing
same-generation state and replaced generations through the real effect-result
boundary. Full macOS Rust validation passed 1,641 tests, zero failures and four
ignored; formatting/Clippy, typecheck, lint, source hygiene, E2E coverage and
Electron production build passed. Logs use `/tmp/rion-appkit-supersede-*`.
Actual macOS TABS-VISIBLE-ACTIVATION-019 / GAME-WINDOWS-TABS-020 and Windows
validation remain required; passing unit evidence does not close those gates.

### Extended Windows F11 matrix received

Run `34013552237` passed the native probe step and uploaded all 72 observations
at `/tmp/rion-113-win-input/chromium-shortcuts-win32.json`. In all four surfaces,
focus transfer/hiding yields no native command at release on the other host,
but one command after returning and sending an additional otherwise uncaptured
key-up. Registration retirement yields no subsequent native command. The
before-input candidate yields no command in those lifecycle cases; Menu already
emits at key-down before the transition. These results reject direct candidate
equivalence and expose retained native captured-down state across focus changes.
CP-07 remains open for that focus-boundary correction and confirmation; the
probe pass is not a production replacement approval.

### F11 deactivation cancels the exact held capture

The retained Win32 window subclass now clears its owner's captured F11-down
state on `WM_ACTIVATE` / `WA_INACTIVE`. This is the authoritative top-level
window deactivation event ([Microsoft documentation](https://learn.microsoft.com/en-us/windows/win32/inputdev/wm-activate));
focus movement between child Chromium surfaces does not itself retire the owner.
The hook still waits for key-up for an uninterrupted chord and does not send
commands from cancellation. No foreground polling or globalShortcut was added.

The 36 native lifecycle observations now assert zero commands across focus
transfer, hiding and registration retirement, including the extra key-up after
return. The APPLICATION-SHORTCUTS-030 manifest notes this adjacent native-addon
coverage. Its E2E scope exception is `lower-layer-covered`: the physical HWND
driver and real addon directly cover capture lifetime without substituting a
debug fullscreen command. The changed Windows assertions have not run yet;
CP-07 remains pending native confirmation. Local macOS Rust lint/tests,
typecheck, lint, source hygiene and E2E coverage passed; logs use
`/tmp/rion-f11-deactivation-*`. macOS is not Windows event-reachability evidence.

Run `34014080241` at `8c0ba441` progressed past Windows popup verification but
failed later in `chromium-workspace-web-only-seed`; its stable Windows full
profile progressed past the minimize-cache failure but failed in
`p1-macro-multirole`. Evidence is `/tmp/rion-8c0-win-package.log`,
`/tmp/rion-8c0-win-tauri.log` and `/tmp/rion-8c0-win-artifacts/`. These later
failures remain to diagnose and are not successful whole-profile results.

### Single-slot Windows workspace projection and Core boundary validation

The Windows Web-only seed failure at `8c0ba441` is an actual projection rejection,
not a missing fixture acknowledgement: Core flow entries 69–77 show
ELECTRON_CHROMIUM_WINDOWS_WORKSPACE_PROJECTION_INVALID. The Windows validator
required two workspace slots although the authoritative single-layout projection
contains one valid Web slot. It now accepts one or more slots and still rejects
empty/duplicate slot lists, missing owners and inconsistent live surface scope.
The new test applies a single Web-only slot with no Role owners and verifies
empty-list rejection. Eight Windows projection tests passed; the existing
WORKSPACE-WEB-ONLY-024 native seed/restart journey remains the acceptance gate.

Run `34014711183` at `0784927d` stopped affected jobs at the migration-boundary
check: the newly extracted Core projection module and its regression used an
Electron-prefixed error name. That cross-shell discriminator is now
MACOS_APPKIT_CHROMIUM_PROJECTION_SUPERSEDED in the producer, Core consumer and
tests. No boundary allowlist was widened. The exact migration-boundary checker
passes, as do all 19 paired AppKit/Windows projection tests and the focused Rust
supersession test. Logs: `/tmp/rion-078-checks.log`, `/tmp/rion-single-slot-*`,
`/tmp/rion-appkit-neutral-code-*`. Neither correction is validated by the
pre-correction CI run; a fresh native run remains required.

### Local AppKit projection regression and Windows macro investigation

At clean source `edc757d0`, the local macOS `chromium-tabs-visible-seed` phase
passed from 05:54:02 to 05:55:05 UTC on 2026-09-06. Report:
`.desktop-e2e-artifacts/2026-09-06T05-54-02-175Z-darwin/report.json`;
log `/tmp/rion-edc-appkit-tabs-e2e.log`. This exercises the previously failing
AppKit tab sequence with the supersession correction. It is one passing phase;
the four paired tab journeys remain NOT_RUN in this report because restart was
not included. A separate restart-focused invocation, including its seed
dependency, is running with log `/tmp/rion-edc-appkit-tabs-restart-e2e.log`.

Fresh CI [34014912798](https://github.com/rion-tw/rion-studio-source/actions/runs/34014912798)
validates exact `edc757d0c9fb4de80852b5bbf66ae0d61ca2e2fe` and has progressed
past the earlier migration-boundary failure. Native outcomes remain pending.

The stable Windows `p1-macro-multirole` failure is narrowed to creation and first
trigger of the held-key continuity macro: native events 130–137 submit real
Shift+Digit6, the correct target page records that chord, but no Digit2 macro
consumer key-down follows. No managed-shortcut receipt appears in that segment.
The source path is StateChanged -> OverlayRefreshRuntime -> OverlayChanged ->
Tauri refresh_macro_overlays -> page list/applyState. The current artifact lacks
an exact page configuration-application receipt tying the new macro to that
physical press, so a missed refresh remains a hypothesis, not a proven cause.
Evidence: `/tmp/rion-8c0-win-tauri-artifacts/2026-09-06T05-30-37-422Z-win32/user-data/p1-macro-multirole/desktop-e2e/events.ndjson`
and `/tmp/rion-8c0-win-tauri.log`. No delay or bypass was introduced to hide it.

The local paired AppKit run subsequently passed both seed and restart at clean
`edc757d0`, 05:55:47–05:57:05 UTC. Report:
`.desktop-e2e-artifacts/2026-09-06T05-55-47-538Z-darwin/report.json`.
TABS-VISIBLE-ACTIVATION-019, GAME-WINDOWS-TABS-020,
RUNTIME-LAUNCH-DESTINATIONS-008 and RUNTIME-TAB-TOPOLOGY-009 all report PASS
for the macOS Chromium profile. This closes the focused macOS regression
verification of the layout-supersession correction, not the remaining whole
profile, Windows, hardware or packaged-release gates.

### Windows gated Web-only observation and paired local regression

CI 34014912798 at exact `edc757d0` passes the single-slot projection and starts
its Web surface. During the deliberate navigation gate, Core completes both
runtime snapshot queries, but the WebDriver command waits for Puppeteer's
attachment to that gated target. It returns only when the existing load deadline
retires the surface; the fixture records transport cancellation before the test
releases the gate. This is a test observation deadlock, not evidence that the
Core snapshot query stalled. Evidence: `/tmp/rion-edc-win-package.log` and
`/tmp/rion-edc-win-artifacts/2026-09-06T05-50-23-907Z-win32/`.

The Windows test now reads the visible loading indicator beside the exact named
tab close button through native UI Automation, restricted to the previously
observed Electron process. It releases the fixture gate in `finally` before any
WebDriver snapshot, then binds the same native host to the exact Core Workspace
tab and verifies empty Role topology. The primary launch remains visible UI;
no product deadline, synthetic loading state, retry or polling was added.
Affected journeys: CHROMIUM-WINDOWS-WORKSPACE-WEB-ONLY-024 and its paired
CHROMIUM-MACOS-APPKIT-WORKSPACE-WEB-ONLY-024 regression.

Validation on local macOS: 15 adjacent evidence tests and all 3,322 Vitest tests
pass; typecheck, lint (23 existing warnings), source hygiene, coverage and desktop
E2E isolation pass. The macOS seed/restart pair passes at `7b47bfc4` plus this
working diff, 06:07:29–06:07:55 UTC, report
`.desktop-e2e-artifacts/2026-09-06T06-07-29-912Z-darwin/report.json`.
This is a dirty-worktree focused report, not an exact committed full-profile
verdict. Logs: `/tmp/rion-web-loading-*`. Windows UIA execution remains pending
fresh CI. Existing `edc757d0` CI has now passed macOS native validation and the
macOS Tauri full profile; its Windows Tauri full profile reproduces the separate
held-key macro failure. Those older results do not validate this test correction.


### CP-07 retained-adapter decision verified on Windows

The exact `edc757d0` Windows input artifact from CI 34014912798 contains all 72
observations on Electron 43.4.1 / Chromium 150.0.7871.224:
`chromium-input-windows-latest-34014912798-1`, artifact ID 9983820249;
local copy `/tmp/rion-edc-win-input/chromium-shortcuts-win32.json`.
Across main, Role-like view, global-Web-like view and popup, the native hook's
12 plain/repeat/modifier-change cases each emit exactly one owner-revision-bound
command after release and no page F11 events. Its 12 focus-transfer, hidden-owner
and retired-owner cases now emit zero commands, including an uncaptured key-up
after returning to the original host. This confirms the WM_ACTIVATE capture
cancellation correction; the prior stale-capture reproduction is absent in all
four host types.

The replacement candidates remain incompatible: before-input-event emits zero
commands in all eight plain/repeat cases and one in the four modifier-change
cases; Menu emits before release in all 12 cases, repeats in the four repeat
cases and delivers two or three page events. All 12 Menu lifecycle cases have
already emitted before the ownership transition. CP-07 therefore closes its
API-selection work as **retain the narrow native hook**, based on observed
terminality and suppression differences, not a preference for duplicated OS
code. Shared command routing stays centralized. The probe uses isolated real
native hosts; it does not establish complete production Role parity. Windows
product journey APPLICATION-SHORTCUTS-030 and the complete profile remain under
CP-15/18. No globalShortcut fallback is introduced.

The same CI's macOS Chromium report now records 52 passing phases, four expected
forced-termination phases and all 49 journeys PASS, 05:49:59–06:09:03 UTC on 2026-09-06. Artifact:
`chromium-shell-e2e-macOS-34014912798-1`, ID 9983826074; local report
`/tmp/rion-edc-mac-artifacts/2026-09-06T05-49-59-279Z-darwin/report.json`.
It identifies source `edc757d0` and reports `worktreeDirty: true`, so this is the
CI-built profile result, not a claim of a clean production package. Native
release packaging/updater validation is still running.

The gated Web-only UIA correction is committed as `2aed96909126d603c4f3eb62f2cfb3e58d3283e5`.
Fresh paired CI [34015776112](https://github.com/rion-tw/rion-studio-source/actions/runs/34015776112)
is running on that exact source. Its Windows loading-control result remains
pending; older runs do not validate this correction.

### Native Windows updater-tooling portability regression

The `edc757d0` Windows native job finishes with the F11 comparison test passing
and all 10 native integration tests passing, then fails two renderer/tooling
assertions in `electron-updater-toolchain-home.test.ts`. The macOS-only cache
helper used host-default `node:path.join`, producing Windows separators for
macOS fixture homes when tested on Windows. This does not invalidate the
completed F11 evidence; it leaves the whole native job failed.
Log: `/tmp/rion-edc-win-native.log`.

The helper now uses explicit `path.posix.isAbsolute/join` for macOS source homes.
Explicit cache overrides remain unchanged. Focused tests also reject drive and
backslash-rooted Windows source homes. Local macOS validation passes 27 adjacent
release/tooling tests, all 3,324 Vitest tests, lint (23 existing warnings), complete
source/dependency hygiene and the normal build. Pure Electron output is restored
separately after the build. This is `internal-only` E2E work: it fixes the probe
build environment, with no product journey or updater trust-policy change.
Fresh Windows tooling execution remains pending; CI 34015776112 predates this
correction. Logs: `/tmp/rion-updater-posix-*`.

### Windows loading-control native tree scope

CI 34015776112 at `2aed9690` now exits the gated Web-only observation in roughly
14 seconds, before the product load deadline, but UIA does not find the required
unique loading/close pair beneath the assumed immediate raw parent. The previous
WebDriver deadlock no longer determines this result. Log:
`/tmp/rion-2aed-win-package.log`; Windows job 101439155517. The same run passes
both Workspace Web fullscreen/popup seed and restart phases before this failure.

A local pinned-Chromium Accessibility.getFullAXTree experiment includes the
named loading status inside the activation button; it does not prove the
Windows UIA parent shape. The read-only helper now scopes both uniquely named
visible controls to the exact process-owned native window, rather than assuming
an immediate raw parent representation. It still requires exactly one matching
window, one close control and one loading control, and binds the captured handle
to the Core Workspace tab after gate release. Failure now includes per-window
close/loading/total-loading match counts. No renderer behavior or acceptance
outcome was weakened. The exact Windows tree behavior remains pending execution.
Local evidence: `/tmp/rion-loading-ax-probe.log`, `/tmp/rion-loading-scope-*`;
15 focused helper tests, typecheck, lint, source hygiene and coverage pass.
The E2E requirement remains CHROMIUM-WINDOWS-WORKSPACE-WEB-ONLY-024.

### Immediate shortcut configuration and native-accessible loading state

The Windows `8c0ba441` multirole artifact timestamps the held-key macro creation
at 05:38:05.673 UTC and physical Digit6 submission at 05:38:05.753 UTC. The
shared overlay worker coalesced StateChanged together with badge/status changes
for up to 250 ms. Configuration now bypasses that presentation coalescing on its
exact StateChanged event; status-only changes retain the existing rate limit.
The native page refresh is still asynchronous, so the Windows product outcome
must be verified rather than inferred from this scheduling correction.

A real worker test establishes an active 60-second presentation interval, sends
a configuration event and receives the immediate authoritative refresh. Existing
status-burst coalescing tests also pass. Local macOS `lint:rust` and `test:rust`
pass (1,642 passed, 4 existing ignored). The unchanged physical trigger sequence
in MACRO-MULTIROLE-005 passes locally at `d7a0f8f3` plus this working diff,
06:26:34–06:28:11 UTC, report
`.desktop-e2e-artifacts/2026-09-06T06-26-34-634Z-darwin/report.json`.
This focused Tauri result is not Chromium or Windows parity. No test settling
delay, retry or earlier macro creation replaces the first physical press.
Logs: `/tmp/rion-macro-urgent-*`.

CI 34016211814's Windows loading diagnostic finds one visible close button but
zero loading candidates in the entire exact native host. The immediate-parent
hypothesis is therefore insufficient. The Windows observation does not find the named nested status
seen in the local Chromium accessibility experiment; it does not by itself prove
why the platform representations differ. The visible
activation button now includes `, loading` in its accessible name while the
existing spinner is present. UIA reads that unique enabled visible button plus
the close button in the same exact process/host, preserving post-release Core
identity binding. No visible layout or primary action changes. Affected journey:
CHROMIUM-WINDOWS-WORKSPACE-WEB-ONLY-024. The native result remains pending.
Log: `/tmp/rion-d7-win-package.log`.

All 3,324 Vitest tests, typecheck, lint (23 existing warnings), source hygiene and
coverage pass after the combined changes. Logs: `/tmp/rion-macro-loading-*` and
`/tmp/rion-loading-button-*`. The older `2aed9690` Windows Tauri full run passes
multirole but later fails p1-cross-domain-topology-force when the minimize bounds
ExecuteScript completion is not observed; this remains a separate investigation,
not evidence that all Windows macro or topology gates pass.

Pure Electron build and renderer-isolation verification pass after the focused
Tauri run. The older macOS package job 101436911578 passes previous-version
fixture construction and subsequently fails its updater transaction probe with
`kill EPERM`. This moves past the prior missing offline cache failure but does
not complete CP-16. Evidence: `/tmp/rion-edc-mac-package.log`.

### Darwin updater cleanup: independently verify zombie-only groups

The `edc757d0` macOS updater failure is the single cleanup error after the main
helper path, not an earlier Cargo/fixture error. A detached `/usr/bin/true` group
returns ESRCH after exit. A controlled native fixture instead forks a child into
its own session, waits for exit with WNOWAIT and keeps only the unreaped child in
that group: `kill(-pgid, 0)` returns EPERM while `/bin/ps` reports only state Z.
This reproduces the kernel edge locally without changing user processes.
Apple's [XNU killpg1 implementation](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_sig.c)
filters zombie members and can return EPERM when no signalable member remains.
That explains a possible cleanup result; EPERM alone still cannot prove absence.

The shared Darwin group liveness helper now resolves only EPERM through a
bounded native `ps` snapshot of the exact detached group. Empty/reaped or entirely
zombie state establishes the existing `active-zero` outcome. A live member,
wrong group, malformed state or read failure remains a failure. Signals still
target only the captured group, and independent application-tree supervision is
unchanged. The full packaged updater transaction remains pending fresh CI.

Validation: 16 adjacent tests pass, including the real macOS WNOWAIT fixture and
negative live/permission/malformed/read-failure cases. All 3,336 Vitest tests,
typecheck, lint (23 existing warnings), complete hygiene and normal build pass.
Logs: `/tmp/rion-group-liveness-*`. This is `lower-layer-covered` E2E work:
it changes probe cleanup classification, not a visible product action; native
fixture evidence covers the exact kernel edge and the existing packaged updater
CI remains required. No Windows runtime behavior changes; Windows portable test
execution remains pending.

### Windows Web-only lifecycle confirmed after native-accessible state change

CI 34016712833 at `fa5c7737` reports
CHROMIUM-WINDOWS-WORKSPACE-WEB-ONLY-024 PASS. Both seed and restart phases pass,
including empty Role topology, isolated chrome/content sessions, explicit
navigation-failure recovery, identical tab/window identity across restart,
persistent content profile and final flush. Report:
`/tmp/rion-fa5-win-artifacts/2026-09-06T06-33-05-716Z-win32/report.json`;
artifact `chromium-shell-e2e-Windows-34016712833-1`.
This confirms the Windows native-accessible loading correction and the paired
Web-only lifecycle, not the full Windows profile. The next phase fails
CHROMIUM-WINDOWS-WORKSPACE-SHARED-ROLE-025 because Workspace B does not reach
its expected Role-slot ownership. Investigation starts from the saved runtime
snapshots and effect receipts, with log `/tmp/rion-fa5-win-package.log`.

The Darwin zombie-group cleanup correction is committed and pushed as
`0430e3b9`; its complete packaged transaction has not yet run on CI. Local pure
Electron build and renderer isolation also pass after the normal build.

### Shared Role placeholder initialization follows the first Core fence

The Windows shared-Role failure at `fa5c7737` is effect 198's
ELECTRON_ROLE_PLACEHOLDER_WINDOW_FENCE_STALE during embeddedCreateTab. The newly
created second Windows host still has generation/revision zero; its first
embeddedFollowRoleOwnership (sequence 204) carries generation 13/revision 15.
Creating blocked placeholders before that projection incorrectly terminalizes
the launch, so the unique sibling never starts. Evidence:
`/tmp/rion-fa5-win-artifacts/2026-09-06T06-33-05-716Z-win32/phases/chromium-workspace-shared-role/electron-core-flow-observations.json`.

Tab creation now records the native host/tab and leaves placeholder reconciliation
to the authoritative ownership/window projection, before native reveal. The
positive window fence and exact Core owner checks remain unchanged. Both shells
use that sequence. The executor test harness now explicitly supports a Windows
host without AppKit initialization metadata and provides geometry for blocked
slots. New macOS/Windows cases create the unfenced target, require no premature
placeholder, apply the Core projection, and verify exact placeholder generation,
revision and owner. The existing claim-terminal test now supplies the initial
ownership projection instead of depending on early creation side effects.

Validation: all 50 adjacent projection/executor tests and all 3,338 Vitest tests
pass; typecheck, lint, source hygiene, coverage, macOS Rust lint and the complete
Rust suite pass (1,642 passed, 4 existing ignored). The retained AppKit Chromium
shared-Role phase passes locally at `85e0b94b` plus this working diff,
06:51:09–06:51:33 UTC, report
`.desktop-e2e-artifacts/2026-09-06T06-51-09-736Z-darwin/report.json`.
The journey is CHROMIUM-MACOS-APPKIT-WORKSPACE-SHARED-ROLE-025; its Windows
counterpart still needs fresh native CI. Both now explicitly assert positive
placeholder window fences. Pure Electron build/isolation is restored and passes.
Logs: `/tmp/rion-placeholder-init-*`. No ownership checks, retries or timeouts
were weakened, and no platform-specific placeholder initialization path was added.

### Native test window controls release the Tauri IPC thread

Windows Tauri CI 34015776112 reached the cross-domain minimize action but failed
the exact WebView2 ExecuteScriptCompleted bounds readback. The test command was
synchronous: Tauri's blocking command dispatch ran the native wait on its IPC
thread, preventing the callback from completing. The command now dispatches the
existing synchronous native control on spawn_blocking, matching the adjacent
runtime UI action command. Authorization, HWND/geometry fences, physical input,
terminal receipts and deadlines are unchanged.

Validation: 23 desktop E2E isolation tests, source hygiene, macOS Rust lint and
all 1,642 Rust tests pass (4 existing ignored). The desktop-e2e build and local
Tauri full-profile phase p1-cross-domain-topology-force pass, including its
required setup, at 522f7d4a plus this working diff, 06:57:11–06:58:37 UTC. Report:
`.desktop-e2e-artifacts/2026-09-06T06-57-11-002Z-darwin/report.json`. Affected
journeys are RUNTIME-TAB-TOPOLOGY-009 and MACRO-OWNERSHIP-TRANSFER-010; this
focused phase does not establish all restart outcomes. This is internal-only
test-driver scheduling work; product behavior and journey definitions are
unchanged. Windows native execution of this correction remains pending CI.
Logs: `/tmp/rion-window-control-*`.

Both macOS and Windows native validation passed on CI 34016712833 at fa5c7737,
including the POSIX updater toolchain-path correction. Later cleanup and
placeholder changes are not covered by that result. CI 34017674641 at 522f7d4a
failed earlier in Windows Chromium fullscreen seed: the native file chooser
helper was terminated at its external deadline. This run therefore does not
validate the later shared-Role correction; investigation continues from its
artifacts rather than treating earlier phase successes as full profile parity.

### Preserve Windows native file chooser progress before blocking UIA calls

The 522f7d4a file-upload failure produced neither the existing failure snapshot
nor upload-success evidence. A native helper deadline alone does not distinguish
UI Automation discovery, focus, SendKeys or dialog-close waits. The Windows
helper now persists a bounded phase/PID progress record before those calls and
a dialog-closed record only after exact-owner dialog disappearance. The artifact
is windows-native-file-dialog-progress.json; it is diagnostic evidence, not a
new success authority. Existing ownership/cardinality/control checks, physical
input and deadlines remain unchanged. No user data or input path is recorded.

Validation: 11 adjacent fullscreen/PowerShell transport tests, typecheck, scoped
lint, source hygiene, coverage and desktop E2E isolation pass. This is internal-only
E2E diagnostics for CHROMIUM-WINDOWS-WORKSPACE-WEB-FILE-UPLOAD-028; the native
Windows profile remains pending. The macOS helper is unchanged. Logs:
`/tmp/rion-file-chooser-*`. CI 34018078890 validates the preceding IPC correction
at 17306f6e and does not include these new diagnostic records.

Separately, macOS package validation on older CI 34016712833 failed in
chromium-system-settings with System Events assistive-access denial (-25211),
not a completed packaged updater verdict. Evidence:
`/tmp/rion-fa5-mac-package.log`. Native validation success on that run remains
valid at its narrower scope; complete package acceptance stays pending.

### Retain the Windows UI thread for native test controls

CI 34018078890 at 17306f6e failed the earlier p0-macro-middle-button phase:
Windows did not foreground the role pointer target. The newly asynchronous IPC
command also moved synchronous foreground/window controls off their owning UI
thread. The Windows adapter now schedules those controls on that thread and
returns their exact result to the worker. Only ClickVisibleMinimize retains the
worker execution needed for its WebView2 bounds callback. Native foreground
readback, pointer input and existing callback deadline are unchanged.

Validation: 23 isolation tests, source hygiene, macOS Rust lint and the complete
Rust suite pass (1,642 passed, 4 existing ignored). Local Tauri full-profile
p0-macro-middle-button passes at 6e9dea07 plus this working diff,
07:12:28–07:13:53 UTC, report
`.desktop-e2e-artifacts/2026-09-06T07-12-28-322Z-darwin/report.json`. The affected
journey is MACRO-MIDDLE-BUTTON-013; RUNTIME-TAB-TOPOLOGY-009 still requires
Windows minimize acceptance. This is internal-only test-driver dispatch work.
The macOS run verifies the unchanged adapter; Windows compilation/native
execution remains pending CI. Pure Electron build/isolation is restored and
passes. Logs: `/tmp/rion-control-ui-thread-*`.

### Focus the file-name control rather than the Windows dialog container

CI 34018289115 at 6e9dea07 identifies the exact native chooser failure:
$dialog.SetFocus() reports that the target element cannot receive focus. The
helper now activates the matched dialog HWND, focuses its exact editable
file-name control, and requires that same dialog to be foreground before
SendKeys. No container-level UIA focus capability is assumed. Exact application
ownership, single dialog/control cardinality, visible controls and native
close checks remain mandatory. Evidence: `/tmp/rion-6e9-win-package.log`.

Validation: 11 adjacent fullscreen/PowerShell tests, typecheck, scoped lint,
source hygiene, coverage and E2E isolation pass. This is internal-only driver
work for CHROMIUM-WINDOWS-WORKSPACE-WEB-FILE-UPLOAD-028; Windows physical
acceptance remains pending. Logs: `/tmp/rion-file-chooser-focus-*`.

The preceding Windows Chromium run 34018078890 passed the chooser phase but
failed Web-only seed after visible tab close: getEmbeddedRuntimeState timed
out in WebDriver, although the Core journal records embeddedTabStop and its
following appSnapshot as completed. That is not proof of an end-to-end reply.
Artifacts: `/tmp/rion-173-win-package-artifacts`; log:
`/tmp/rion-173-win-package.log`. Further investigation must identify the lost
reply/driver boundary without weakening the close assertion. On macOS,
34017674641 has completed source E2E and advanced to release artifact build;
its complete packaged updater verdict is still pending.

### Wake coherent snapshot readers for final Core-only topology commits

The Windows Web-only timeout at 17306f6e is consistent with a missing Core
commit wakeup, and source inspection identifies that gap. Effect 161 destroys
the last tab; receipt 165 already has empty native windows/tabs and acknowledgement
167 is accepted. Snapshot 168 still contains an empty Core window at runtime
revision 9; snapshot 169 removes it at revision 10. No later native effect is
needed. A reader receiving snapshot 168 fails the exact Core/native equality
check but previously waited only for another native effect admission. The final
Core stateChanged event could not wake it. Detailed evidence is in
`/tmp/rion-173-win-package-artifacts/2026-09-06T07-04-11-294Z-win32/phases/chromium-workspace-web-only-seed/electron-core-flow-observations.json`.

The shared effect coordinator now advances its projection observation sequence
on a strictly newer Core stateChanged revision as well as native effect
admission. Existing pending native/acknowledgement fences still settle before
readers retry. Duplicate/older Core revisions do not wake readers. Exact
Core/native projection equality is unchanged; no polling or timer was added.

Validation: all 3,340 Vitest tests pass, including both platform cases for a
Core-only final commit, an already-delivered commit, stale/duplicate events, and
a Core event that must not bypass an outstanding native acknowledgement.
Typecheck, lint, complete hygiene, macOS Rust lint and all 1,642 Rust tests pass
(4 existing ignored). Local retained-AppKit Web-only seed and restart phases
pass at be7b28b3 plus this working diff, 07:23:40–07:24:24 UTC, report
`.desktop-e2e-artifacts/2026-09-06T07-23-40-900Z-darwin/report.json`. Affected
journeys are CHROMIUM-MACOS-APPKIT-WORKSPACE-WEB-ONLY-024 and its Windows
counterpart. Windows native acceptance remains pending. Logs:
`/tmp/rion-core-projection-wakeup-*`.

### Use visible native pointer actions for the file chooser controls

CI 34018711131 at be7b28b3 progresses past container focus but the exact file-name
Edit also rejects UIA SetFocus. The chooser helper now clicks each verified
control's UIA GetClickablePoint through the existing Win32 physical pointer
mechanism used by desktop resize tests. It clicks the file-name control, checks
the exact dialog foreground HWND before typing, then clicks Open. Owner and
cardinality checks, enabled/visible controls, literal keyboard entry and native
dialog disappearance remain required. Evidence: `/tmp/rion-be7-win-package.log`.

This is internal-only E2E driver work for
CHROMIUM-WINDOWS-WORKSPACE-WEB-FILE-UPLOAD-028. Eleven adjacent tests, typecheck,
scoped lint, source hygiene, coverage and production isolation pass. Actual
Windows pointer/dialog acceptance is pending fresh CI; the macOS helper is
unchanged. Logs: `/tmp/rion-native-file-pointer-*`.

Normal build and restored pure Electron build/isolation also pass for this batch.

### macOS package, updater transaction and native black-box gates passed

CI [34017674641](https://github.com/rion-tw/rion-studio-source/actions/runs/34017674641)
at 522f7d4ad2440aec214bfcc1a8ef98ee51a278f3 completed the macOS Electron Chromium
package validation job successfully. Every applicable step passed: retained
AppKit source E2E, release artifact build, previous-version fixtures, exact
Electron/Chromium/Core/AppKit ABI, package structure, distribution payloads,
packaged Rust-owned updater transaction and packaged Role black-box smoke.
The updater command explicitly verified the real app bundle and signed update
archive; the job log records its success at 07:29:48 UTC. This confirms the
Darwin zombie-only cleanup correction in its complete packaged transaction.
It does not authorize publication or establish Windows installer/update parity.

Source report: 52 PASS phases, 4 EXPECTED_FORCE_TERMINATION phases and all 49
journeys PASS, 06:54:20–07:09:53 UTC. Report commit is exact, with the expected
CI fixture worktreeDirty flag. Artifact chromium-shell-e2e-macOS-34017674641-1
(ID 9984652799), downloaded to `/tmp/rion-522-mac-shell-artifacts`. This also
confirms the shared-Role placeholder initialization correction on macOS.

The packaged report has verdict passed, version 8.5.0, exitCode 0,
runtimeTarget chromium-v23-macos-appkit, nativeHostKind appkit-chromium,
fixtureInteraction visible-os-accessibility-click and remoteDebugging false.
Its retained native-window screenshot was inspected. Artifact
packaged-chromium-role-black-box-macOS-34017674641-1 (ID 9984941317); report:
`/tmp/rion-522-mac-packaged-artifacts/2026-09-06T07-29-50-231Z-faefbbdd-2689-4062-9318-5edfc76f6343-darwin-packaged-black-box/packaged-smoke-report.json`.
The report pins app.asar SHA-256
ee51917936d1e37674fa0f80bf7489fb640b170df691ebfbb062bf2b561f3f3b
and native addon SHA-256
bdaa1d1ededd40d6f77500a145d57a16ad3a0bfdf35b54bc1534537d8b856b3b.
Job log: `/tmp/rion-522-mac-package.log`.

Both macOS and Windows native validation and the macOS Tauri full E2E job also
passed at that SHA. Windows Tauri/Chromium E2E failed as recorded above. Later
IPC, Windows pointer and Core projection-wakeup changes retain their own fresh
CI requirement; the package success must not be attributed to current HEAD.
CP-16 therefore has verified macOS package/update evidence while its Windows
and owner-locked release gates remain pending. Physical extended-profile
requirements and CP-17 cutover remain unchanged.

### Windows stable-shell full acceptance confirms native control dispatch

CI [34018711131](https://github.com/rion-tw/rion-studio-source/actions/runs/34018711131)
at be7b28b3e130f1e6f3cc69a7ed1087ff19a6e9f3 passes the complete Windows Tauri
full profile: 29 PASS phases, 3 EXPECTED_FORCE_TERMINATION phases and all 39
journeys PASS. The report identifies runtimeTarget tauri-v22 and a clean tested
worktree, 07:18:26–07:31:18 UTC. This confirms the async IPC/UI-thread split
through MACRO-MIDDLE-BUTTON-013 and RUNTIME-TAB-TOPOLOGY-009, including the
Windows visible-minimize bounds/readback assertions. MACRO-MULTIROLE-005 also
passes with the urgent Core shortcut-configuration publication correction.

Artifact desktop-e2e-Windows-34018711131-1; report:
`/tmp/rion-be7-win-tauri-artifacts/2026-09-06T07-18-26-081Z-win32/report.json`.
The earlier macOS Tauri full run at 522f7d4a and local focused macOS middle-button
run remain their recorded evidence. The complete latest-head macOS profile is
still independently required. This stable-shell verdict does not establish
Chromium Windows parity; CI 34019181794 at c0e09041 is still running the
Chromium/native package gates and includes the later Core commit wakeup and
file-dialog pointer corrections.

### Windows Web-only, upload and shared Role journeys now pass together

CI 34019181794 at c0e09041 passes CHROMIUM-WINDOWS-WORKSPACE-WEB-FILE-UPLOAD-028,
CHROMIUM-WINDOWS-WORKSPACE-WEB-ONLY-024 (seed/restart) and
CHROMIUM-WINDOWS-WORKSPACE-SHARED-ROLE-025. This confirms the physical file
chooser control actions, Core-only projection wakeup and positive-fence
placeholder initialization in the same native Windows run. The report records
12 PASS phases and 15 PASS journeys before WORKSPACES-RECOVERY-026 fails;
34 journeys remain NOT_RUN. Report:
`/tmp/rion-c0-win-package-artifacts/2026-09-06T07-28-50-469Z-win32/report.json`.

Recovery passes failure isolation and visible stop/relaunch, then fails gated
loading cancellation. Its test reads the runtime projection before clicking
Stop, while loading is deliberately blocked. That read can wait for the very
load being cancelled; effect 4caf085f reaches its Core deadline before the
later stop command. The Windows test now observes the exact native loading row
and invokes its visible close control without attaching ChromeDriver or
requesting a settled projection. It uses the same exact PID/HWND/control-name
validation as the existing native close helper. Both gated Role transports
must report cancellation before either fixture is released; final Core tabs
and Role statuses must still be absent. The macOS visible action is retained
and now has the same explicit transport-cancellation assertions.

Validation: 17 native-control evidence tests, typecheck, scoped lint, hygiene,
coverage and E2E isolation pass. Local macOS AppKit
CHROMIUM-MACOS-APPKIT-WORKSPACES-RECOVERY-026 passes at 31929ef5 plus this working
diff, report `.desktop-e2e-artifacts/2026-09-06T07-40-59-564Z-darwin/report.json`.
Windows native execution remains pending fresh CI. This is internal-only test
sequencing work; product cancellation and its deadlines are unchanged. The
Windows journey manifest names the exact native gated-cancel action and both
transport receipts. Logs: `/tmp/rion-workspace-loading-cancel-*`.

The latest Tauri Windows full run at c0e09041 fails later in p1-guard-cleanup
with mainWindowFocusSuperseded; log `/tmp/rion-c0-win-tauri.log`. The earlier
be7b28b3 full PASS remains valid at that SHA, but this new focus supersession
requires investigation and prevents a current-head full acceptance claim.

### Wait for restored-tab essential setup before cleanup takes foreground

The c0e09041 Windows p1-guard-cleanup transcript shows the main-focus request
accepted at 07:37:59.171, a restored Game Window native focus event at .174,
and the correct superseded terminal at .195. That restored tab did not reach
essentialReady until .393. Cleanup had waited for context/visibility and
final-focus-started, which do not establish completed WebView attachment.
Evidence: `/tmp/rion-c0-win-tauri-artifacts/2026-09-06T07-28-55-095Z-win32/user-data/app-entity-lifecycle/desktop-e2e/events.ndjson`.

The cleanup fixture now waits for each exact restored tab's existing
tab-launch-phase:<id>:essentialReady event after its Show action before
requesting main-window focus and visibly deleting entities. This is an
internal-only cleanup precondition for APP-FULL-CRUD-001, APP-CRUD-REORDER-002
and APP-QUIT-GUARD-002. Native focus supersession and product presentation
behavior remain unchanged; no retry or presentation delay was added.

Validation: typecheck, scoped lint, source hygiene and E2E production isolation
pass. The local macOS full-profile p1-guard-cleanup and required setup phases
pass at 028cc461 plus this working diff; report:
`.desktop-e2e-artifacts/2026-09-06T07-46-48-479Z-darwin/report.json`. Windows
execution of this precondition remains pending CI; the earlier Windows
be7b28b3 full PASS is not reused as its verification. Logs:
`/tmp/rion-cleanup-restore-ready-*`. Separately, macOS Tauri full E2E on
CI 34019181794 at c0e09041 has completed successfully.

### Admit exact Windows tab cancellation while presentation is catching up

CI 34019883290 at 028cc461 and 34020264959 at 32ff548f reach native gated
Workspace close but fail final tab absence. The former's native log reports
ELECTRON_CHROMIUM_RUNTIME_ACTION_WINDOW_STALE; no corresponding gated-tab
embeddedTabStop command reaches Core before the load deadline. Native topology
observation 11 has window generation 41/revision 43 with the exact tab, while
Core's pending presentation has revision 44 in that same generation. Requiring
revision equality for stop rejects a valid cancellation while presentation
is catching up. The resulting transport cancellation came from load expiry,
so it did not establish a successful user stop. Evidence:
`/tmp/rion-028-win-package-artifacts/2026-09-06T07-44-13-885Z-win32`; the
authoritative downloaded report and phase paths are under that artifact root.
Logs: `/tmp/rion-028-win-package.log`, `/tmp/rion-32ff-win-package.log`.

Windows stop now permits a positive native revision no newer than Core's,
while retaining identical window generation, complete ordered tab membership
and presentation. It submits the exact tab ID and current Core source-window
generation to the existing Rust stop transaction. Uninitialized, ahead,
different-generation and different-membership states still fail. Other
actions retain revision equality; AppKit retains its exact projection/event
protocol. No native handles or domain ownership are inferred from elapsed time.

The recovery E2E also waits for actual Core tab retirement after the native
click and two transport-cancelled events. The final absence/Role-status
assertions remain mandatory; an early native input return is not terminality.
Affected journeys are CHROMIUM-WINDOWS-WORKSPACES-RECOVERY-026 and its retained
AppKit counterpart.

Validation: 20 action-backend tests, all 3,347 Vitest tests, typecheck, lint,
complete hygiene, normal build, macOS Rust lint and all 1,642 Rust tests pass
(4 existing ignored). The seven adjacent Workspace source checks also pass
after the terminal-wait update. Final local macOS recovery E2E passes at
32ff548f plus this working diff; report:
`.desktop-e2e-artifacts/2026-09-06T08-01-03-549Z-darwin/report.json`. Windows
native verification of the corrected admission remains pending fresh CI.
Logs: `/tmp/rion-stop-pending-revision-*`.


### Follow-up CI admission and Windows stable-shell recovery verification

The pending-presentation stop fix is committed as
4bd48816f628b508f25890fe07bddd6310894db7. Immutable-ref CI
[34020983154](https://github.com/rion-tw/rion-studio-source/actions/runs/34020983154)
has been dispatched; its Windows Chromium cancellation, remaining journeys,
package and updater results are pending. Final coverage validation and pure
Electron renderer bundle verification passed before commit.

The preceding CI 34020264959 at 32ff548fd932739530bc10576c18200838b0cfc9
completed Windows x64 desktop E2E successfully (job 101451414368). This verifies
the restored-tab essentialReady precondition used by the stable-shell cleanup
focus journey. It does not verify the later Chromium stop-admission change.
The separate Windows Chromium package job at that revision failed the gated
Workspace final-tab absence check documented above. Log:
`/tmp/rion-32ff-win-tauri.log`.


### Preserve packaged native traversal across retired AX references

macOS package CI 34018711131 at be7b28b3 completed source E2E, package verification
and the packaged updater transaction, then failed the final native black-box
launcher traversal with System Events Invalid index (-1719). The AppleScript
queue dereferenced a retired Chromium accessibility element before entering its
existing guarded property read. Log: `/tmp/rion-be7-mac-package.log`.

The shared packaged macOS traversal now guards queue and child-reference
dereferencing, plus the launcher consumers, as well as property reads. Missing
elements cannot match. The traversal bounds, exact process and retained AppKit
identity, real native actions and domain receipts remain unchanged. This is an
internal-only E2E driver correction; it changes no product UI or native runtime
contract and does not add a reconciliation loop.

An actual macOS osascript regression supplies a retired AX group reference.
The previous handlers reproduce the same 277:285 Invalid index (-1719); the new
handlers return no descendants and no button match. All 11 adjacent tests and
all 3,348 Vitest tests pass, as do full hygiene and lint (23 existing warnings).
The local packaged black-box also passes with exit code 0, a visible OS
accessibility click and retained appkit-chromium host; its screenshot was
inspected. Report:
`.desktop-e2e-artifacts/2026-09-06T08-11-51-673Z-a77e0205-069d-4379-9f2a-308e5ce71d8a-darwin-packaged-black-box/packaged-smoke-report.json`.
This run uses the existing local 8.5.0 package (app.asar SHA-256
4fd238e22fe97f03bc67b27580129c98dfc337cbd49b79fe60aa66bd49a2302b), so it
verifies the updated external native driver, not a rebuilt current-candidate
package. Exact-candidate macOS package and Windows CI remain pending.
Logs: `/tmp/rion-packaged-ax-*`.


### macOS complete package validation advanced to c0e09041

CI [34019181794](https://github.com/rion-tw/rion-studio-source/actions/runs/34019181794)
macOS Chromium package job 101448473362 completed successfully at
c0e09041173a923abfc291d6ec91452d9bcaf6e6. Its source smoke report records
52 PASS phases, four expected force-termination phases and all 49 journeys PASS
(07:32:48.424–07:53:30.056 UTC). The report records the existing CI fixture
worktree changes; it is bound to the stated commit, not current HEAD. Evidence:
`/tmp/rion-c0-mac-shell-artifacts/2026-09-06T07-32-48-182Z-darwin/report.json`.

The same job passed package construction, exact ABI/runtime and distribution
verification and the Rust-owned packaged updater transaction (08:13:38 UTC).
The final packaged native black-box reports passed, exit code 0, visible OS
accessibility click and appkit-chromium host for version 8.5.0. Artifact
9985570974 contains:
`/tmp/rion-c0-mac-packaged-artifacts/2026-09-06T08-13-40-956Z-5fe61725-ebfb-4389-baa5-a05775d5370d-darwin-packaged-black-box/packaged-smoke-report.json`.
Log: `/tmp/rion-c0-mac-package.log`. Both native validation jobs at c0e09041
also passed. This advances CP-16's latest complete macOS evidence, but does not
verify later changes or close Windows, physical hardware or release gates.

The retired-AX-reference driver correction is committed as c9f94a5b and is
under immutable-ref CI
[34021272996](https://github.com/rion-tw/rion-studio-source/actions/runs/34021272996).
The preceding Windows Chromium stop-admission run 34020983154 remains live in
its shell E2E step at this observation; it is not a passing result yet.


### Windows loading cancellation passes; recovery evidence follows event order

CI 34020983154 at 4bd48816 now passes the complete Windows recovery UI spec at
08:15:53 UTC (one passing test, including visible gated cancellation, both
transport cancellations and final Core tab/Role-status absence). The runner then
fails its post-run recovery-history verifier, so the aggregate journey remains
unverified. Evidence is under
`/tmp/rion-4bd-win-package-artifacts/2026-09-06T08-09-01-957Z-win32/phases/chromium-workspaces-recovery`;
log: `/tmp/rion-4bd-win-package.log`.

The exact observations show Core runtime-crashed in sample 2 while native phase
is still ready/revision 10; sample 3 projects degraded/revision 11 with the same
Role, Core owner and native generation. The verifier incorrectly required the
first Core failure sample itself to contain the later native degraded phase.
It now requires the ordered degraded observation for that same failed Role,
with identical Core owner and native generation, while retaining the first Core
failure, healthy-sibling preservation and explicit relaunch generation checks.
Missing degradation, replacement ownership/native generation and missing
relaunch still fail. No product runtime or E2E user action changes.

Ten platform-explicit behavioral cases cover this ordering and the rejection
boundaries. Replaying both the actual Windows failure artifact and the prior
c0e09041 macOS recovery artifact through the corrected verifier succeeds.
This is internal-only evidence validation; the affected existing journeys are
CHROMIUM-WINDOWS-WORKSPACES-RECOVERY-026 and
CHROMIUM-MACOS-APPKIT-WORKSPACES-RECOVERY-026. Fresh aggregate CI remains pending;
replay does not retroactively change the failed CI verdict.

Validation: all 3,358 Vitest tests, typecheck, lint and complete hygiene pass.
Logs: `/tmp/rion-recovery-phase-*`. No native imports, shared runtime contracts
or product code changed; native Rust checks are not repeated for this verifier.

### Concentrate final CI on the corrected recovery verifier

The ordered recovery verifier is committed as
27deee12689323a5bc45151f874b56939c2eff10 and runs in immutable-ref CI
[34021561250](https://github.com/rion-tw/rion-studio-source/actions/runs/34021561250).
Checks, renderer build and Linux sanitizer/concurrency validation have passed;
Windows Chromium E2E and both platforms' native/desktop/package work remain
in progress. macOS jobs started after freeing occupied runners.

Superseded runs 34019883290, 34020264959, 34020983154 and 34021272996 were
explicitly cancelled after their Windows Chromium failures had been inspected
and their corrections included in the current candidate. All four runs are now
terminal cancelled; this does not change individual completed job results or
turn failed aggregate journeys into passes. Existing artifacts and recorded
commit-specific evidence remain valid only for their stated scope. No current
candidate job was cancelled or restarted.


### Windows recovery aggregate passes; fix scoped toolbar-settings selector

CI 34021561250 at 27deee12 now records WORKSPACES-RECOVERY-026 PASS in the
aggregate report, confirming the ordered verifier as well as actual visible
cancellation and final Core retirement. The Windows source profile advances to
13 passing phases and 16 passing journeys before the next failure; 33 journeys
remain not run. Report:
`/tmp/rion-27d-win-package-artifacts/2026-09-06T08-21-52-165Z-win32/report.json`.

The fullscreen-toolbar seed fails before its preference action because
`.settings-mode-sidebar button=Preferences` is sent as an invalid CSS selector.
The driver now scopes to the sidebar first, then uses WebdriverIO's exact
button-text selector, matching the existing system-settings driver pattern.
The failure screenshot confirms the visible Preferences section and toolbar
switch. The persisted preference assertions and native fullscreen actions are
unchanged. This is an internal-only E2E locator correction affecting
CHROMIUM-WINDOWS-FULLSCREEN-TOOLBAR-012; Windows execution remains pending CI.
Typecheck, scoped lint, source hygiene, production E2E isolation and coverage
validation pass. Logs: `/tmp/rion-toolbar-selector-*`,
`/tmp/rion-27d-win-package.log`.

### Remove retired display-performance wording from Preferences

The Windows fullscreen failure screenshot exposed a remaining Preferences
subtitle advertising display performance after CP-02/CP-13 removed those
controls. English, Japanese, Simplified Chinese and Traditional Chinese now
name only theme, interface language and Game Window behavior. The existing
translation key and layout are unchanged; no setting or persistence behavior
changes.

Validation: all 3,358 Vitest tests, typecheck, lint, source hygiene and pure
Electron renderer build pass. All four locale JSON values were checked for
valid syntax and removal of the retired wording. E2E omission reason is
lower-layer-covered: static localized copy only, verified through locale
readback and the production renderer build. Affected existing journeys are
CHROMIUM-MACOS-APPKIT-SYSTEM-SETTINGS-013 and
CHROMIUM-WINDOWS-SYSTEM-SETTINGS-013. Their latest exact-candidate native
verification remains pending; this copy-only follow-up does not restart the
live functional CI 34022067330 at 26c4fd4b. Logs:
`/tmp/rion-retired-preference-copy-*`.

### Windows placement respects unsaved runtime-window ownership

The Windows fullscreen seed screenshot at 27deee12 also contains a product
error toast. Native logs identify WINDOWS_RUNTIME_PLACEMENT_SAVED_WINDOW_MISSING;
Core flow shows placement command 62 during launch of a live Role window that
has no saved Game Window definition. The Windows placement writer incorrectly
required every live window to already be saved. Existing Core runtime UI
persistence deliberately skips unsaved definitions, so a new Role window is
not a persistence failure. Evidence: `/tmp/rion-27d-win-package-artifacts/2026-09-06T08-21-52-165Z-win32/phases/chromium-fullscreen-toolbar-seed`.

Core now validates the exact logical generation/revision and commits placement
and native projection for both saved and unsaved windows. Saved definitions
still require the exact durable receipt. Unsaved definitions return the explicit
persistenceStatus notRequired, create no saved Game Window, and can report
applied only after Core projection succeeds. The generated contract comes from
Rust. Both Electron receipt consumers retain their identity, revision, native
and display checks and accept that explicit Core-owned outcome; no shell-side
inference, retry or timer is introduced. Stable Tauri and retained AppKit paths
are unchanged; this follows their existing shared Core saved-definition policy.

Four focused Core tests cover saved persistence, unsaved placement without a
saved definition, stale fences and failed projection. The Electron test now
executes the actual placement-target consumer for both applied and notRequired
receipts, including exact native/display readback. macOS Rust lint and all
1,643 native Rust tests pass (four existing ignored). Affected journeys include
CHROMIUM-WINDOWS-FULLSCREEN-TOOLBAR-012 and Windows window/display recovery.
E2E omission reason is lower-layer-covered: the new saved/unsaved receipt branch
is exercised through real Core command/effect dispatch and the real Electron
target consumer. Windows native/fullscreen execution of this exact revision
remains pending CI; the previous screenshot is failure evidence, not a pass.
Logs: `/tmp/rion-unsaved-placement-*`.
Final verification also passes all 3,359 Vitest tests, typecheck, lint, complete
hygiene and pure Electron build after updating both receipt consumers.

### Fullscreen E2E sends F11 through the retained Windows native hook

CI 34022067330 at 26c4fd4b passes the corrected Settings locator but fails
waiting for fullscreen auto-hide. Its toolbar history contains only the normal
presentation and Core flow contains no fullscreen UI action after the key
submission. The driver used WebDriver key injection for F11 even though CP-07
retains the native Win32 foreground hook as the authoritative Windows routing
boundary. This does not exercise that physical shortcut path. Evidence:
`/tmp/rion-26c-win-package-artifacts/2026-09-06T08-32-52-294Z-win32/phases/chromium-fullscreen-toolbar-seed`;
log: `/tmp/rion-26c-win-package.log`.

The shared Role F11 helper now obtains the exact process identity before
focusing the Role page and invokes the existing Windows scan-code shortcut
helper in focused-runtime mode. The native helper checks foreground PID and
visibility and requires SendInput's exact inserted count. The existing caller
still requires fullscreen projection, actual toolbar/content geometry and no
F11 page delivery; input submission alone cannot pass. Both callers use this
helper only in their Windows branch. AppKit controls remain unchanged.

This internal-only desktop driver correction affects
CHROMIUM-WINDOWS-FULLSCREEN-TOOLBAR-012 and
CHROMIUM-WINDOWS-NATIVE-DISPLAY-001. The manifest now states native scan-code
input explicitly. The adjacent source boundary check no longer requires the
incorrect WebDriver F11 path. Typecheck, scoped lint, source hygiene, E2E
production isolation, coverage validation and 11 adjacent native-action and
toolbar checks pass. Actual Windows/fullscreen and hardware profile results
remain pending; no macOS execution is claimed for a Windows-only driver change.
Logs: `/tmp/rion-native-f11-*`.

### Native file-name entry uses the visible UI Automation value contract

CI 34022632667 at 75562cc1 fails earlier in Workspace Web upload. The native
helper is killed at its existing deadline; its last checkpoint is
entering-file-name, immediately before SendKeys.SendWait control-A and escaped
path input. This run does not reach fullscreen-toolbar acceptance and therefore
does not verify or contradict the subsequent native F11 correction. Evidence:
`/tmp/rion-755-win-package-artifacts/2026-09-06T08-44-31-184Z-win32/phases/chromium-workspace-web-fullscreen-seed/windows-native-file-dialog-progress.json`;
log: `/tmp/rion-755-win-package.log`.

The Windows chooser driver now obtains ValuePattern from the exact visible,
enabled, uniquely owned file-name Edit control, rejects read-only controls,
sets the literal fixture path, and requires exact case-sensitive native readback
before physically clicking Open. It retains the exact dialog foreground/PID
checks, physical file-input/chooser actions, dialog-close acknowledgement and
page File/byte evidence. It removes SendKeys and its escaping helper, not the
native chooser. No larger deadline, retry or product runtime bypass was added.
The checkpoint alone does not establish which SendKeys call consumed the
remaining deadline; fresh native execution remains required.

This internal-only E2E correction affects
CHROMIUM-WINDOWS-WORKSPACE-WEB-FILE-UPLOAD-028. The manifest and adjacent source
boundary check now require native value acknowledgement. Eleven adjacent
checks, typecheck, scoped lint, E2E production isolation, source hygiene and
coverage validation pass. Windows execution is pending CI; AppKit file-panel
behavior and its prior evidence are unchanged.
Logs: `/tmp/rion-file-dialog-value-*`.

### Separate independent update-lineage rejection cases

Windows native-validation job 101455086471 in CI 34021561250 fails in Vitest,
not a reported Rust assertion: one readiness test creates and verifies three
independent complete production-evidence fixtures under a single 10-second test
budget. The failure is the grouped test deadline. The artifact digest, running
executable digest and provisional manifest digest checks now have separate test
cases, each retaining the original fixture, mutation, rejection assertion and
unchanged timeout. No production verifier or release gate changes.

All 33 focused readiness tests, scoped lint and source hygiene pass locally.
This is internal-only validation work; no desktop journey changes. Windows
execution of the split cases remains pending CI. Evidence:
`/tmp/rion-27d-win-native.log`; checks: `/tmp/rion-readiness-case-*`.

The same audit identifies separate incomplete macOS evidence: package job
101454984110 at 27deee12 was denied OS assistive access while opening the native
file panel (System Events -25211). Stable Tauri jobs 101454984161 at 27deee12
and 101456344886 at 26c4fd4b time out in native window-control calls, respectively
the fullscreen View-menu action and deminiaturization. These are neither
Chromium parity passes nor evidence to remove AppKit. No permission bypass or
longer timeout is introduced; further native evidence is required. Logs:
`/tmp/rion-27d-mac-package.log`, `/tmp/rion-27d-mac-tauri.log`,
`/tmp/rion-26c-mac-tauri.log`. The latter's artifact root is
`/tmp/rion-26c-mac-tauri-artifacts`.


### Exact Windows foreground identity and native edit acknowledgement

CI 34022924914 at 2dafe73b still records only normal presentation after F11.
The native helper previously checked foreground process identity, which cannot
separate the launcher from a Role host in the same Electron process. The
read-only E2E toolbar inspection now exposes the exact Windows native handle
from the Core-fenced BrowserWindow mapping. The driver activates that visible,
PID-owned HWND and checks it again immediately before native scan-code F11.
The existing fullscreen projection, page suppression and live geometry receipts
remain the success conditions. AppKit does not expose or consume this field.
Affected internal-only journeys: CHROMIUM-WINDOWS-FULLSCREEN-TOOLBAR-012 and
CHROMIUM-WINDOWS-NATIVE-DISPLAY-001. Twelve focused parser/foreground tests cover
valid Windows identity, absent optional evidence, malformed identities and
native rejection. Full Vitest at this stage passes 3,373 tests; typecheck and
lint pass. Exact Windows native execution is still pending.

CI 34023120346 at 6ae8b6e7 fails before fullscreen in the native file chooser:
the exact visible Edit control reports Unsupported Pattern for ValuePattern.
The driver now uses that control's native handle and Win32 WM_SETTEXT followed
by exact ordinal WM_GETTEXT readback. Both acknowledgements are bounded with
SendMessageTimeoutW; missing acknowledgement is failure. Exact dialog-child and
foreground identity are checked before and after. The visible file-input,
physical Open click, dialog closure and page file bytes remain required.
No retry, larger helper deadline or product chooser bypass is introduced.
This internal-only correction affects
CHROMIUM-WINDOWS-WORKSPACE-WEB-FILE-UPLOAD-028. Windows execution remains pending.
Evidence: `/tmp/rion-6ae-win-package.log`.
API contracts: [WM_SETTEXT](https://learn.microsoft.com/en-us/windows/win32/winmsg/wm-settext),
[WM_GETTEXT](https://learn.microsoft.com/en-us/windows/win32/winmsg/wm-gettext),
[SendMessageTimeoutW](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendmessagetimeoutw).

The focused macOS AppKit toolbar seed and restart profile passes on this working
tree: `.desktop-e2e-artifacts/2026-09-06T09-15-16-318Z-darwin/report.json`.
Affected macOS journey: CHROMIUM-MACOS-APPKIT-FULLSCREEN-TOOLBAR-012.
After the native edit correction, all 22 adjacent checks, typecheck, scoped lint,
source hygiene and coverage validation pass. E2E build passes. Production
isolation must be checked against the restored production build; its initial
invocation correctly rejected the still-installed E2E renderer build.

Final working-tree validation passes all 3,373 Vitest tests, macOS Rust lint
and 1,643 native Rust tests (four existing ignored), complete hygiene, typecheck,
coverage validation, pure Electron production build and production E2E isolation.
The latter now passes after restoring the production renderer. Windows remains
pending a fresh immutable-candidate CI run; no release/cutover gate is waived.
Logs: `/tmp/rion-foreground-*`.


### Complete macOS package evidence advances to 26c4fd4b

CI 34022067330 package job 101456344940 is terminal success at exact commit
26c4fd4b8edcd8ace88a4f77b2f8665079696ec1. Downloaded source report
`/tmp/rion-26c-mac-shell-artifacts/2026-09-06T08-32-17-682Z-darwin/report.json`
confirms all 49 journeys, 52 passing phases and four expected forced exits.
The job verifies the packaged Rust-owned updater transaction for 8.5.0 at
09:06:43 UTC. The final packaged black-box report is passed with exit 0,
visible OS accessibility interaction, retained appkit-chromium hosting and
remoteDebugging=false. Its app.asar SHA-256 is
`dc565c836b34e63e40c467de2f6ed92e6e8208eadfc059adf3c488d2ee400d81`.
Packaged artifact: 9986360142;
report root: `/tmp/rion-26c-mac-packaged-artifacts/2026-09-06T09-06-45-184Z-6f9eeac5-fdb8-4b90-95e4-04835e1778a5-darwin-packaged-black-box`.
Job log: `/tmp/rion-26c-mac-package.log`.

This advances CP-16 macOS evidence; it does not make the aggregate CI run pass:
that candidate's Windows Chromium and stable macOS desktop jobs failed.
The later 75562cc1 stable macOS job 101457881273 repeats the native
setPresentation/deminiaturization timeout at cross-domain-runtime.e2e.ts:1184;
its subsequent screenshot also times out. Exact native thread evidence is still
missing, so no speculative AppKit removal or timeout relaxation is applied.
Log: `/tmp/rion-755-mac-tauri.log`.

Fresh immutable candidate b76e249b93801c11774a0b575320a9a55da7af95 is running in
CI 34024329384. Its Windows Chromium job 101462497385 has reached the shell E2E
step. Latest candidate macOS jobs are queued; these are live/pending evidence,
not passed gates. The worktree is not promoted to the sole production engine.


### Keep optional native handle present in strict PowerShell payloads

CI 34024329384 Windows Chromium job 101462497385 fails at shell-smoke before
file upload or Role fullscreen. Strict PowerShell rejects the absent
nativeWindowHandle property for ordinary launcher shortcuts: JSON serialization
omits undefined object fields. The driver now always sends the optional property
as an empty string when absent. Launcher PID/window selection is unchanged;
provided Role HWNDs still require exact foreground equality before F11. No
strict-mode downgrade or native ownership bypass is introduced.

This internal-only transport correction affects
CHROMIUM-WINDOWS-APPLICATION-SHORTCUTS-030 and callers of the common native
shortcut driver. It does not establish whether the previous candidate's native
Edit or exact Role focus corrections pass: this run never reaches those phases.
Evidence: `/tmp/rion-b76-win-package.log`. Windows execution remains pending
on the corrected candidate.

All 29 adjacent native-action/transport/foreground/shortcut checks pass locally,
along with typecheck, scoped lint, source hygiene, production E2E isolation and
coverage validation. No native runtime, AppKit behavior, shared contract or
coverage threshold changes. Logs: `/tmp/rion-shortcut-optional-*`.


### Compare toolbar geometry inside one fullscreen extent

CI 34024645026 at c55f05a7 passes the first 13 Windows Chromium phases, including
Workspace Web native file upload and restart. It reaches fullscreen-toolbar-seed
and records exact native F11 entry with the same HWND 1835114. This verifies the
optional shortcut field and native Edit acknowledgement corrections along this
actual Windows path. The toolbar assertion then expects 38px expansion but
receives 166px. The artifact proves normal Role bounds 960x600 at y=40 versus
fullscreen 1024x766 at y=2: the test incorrectly included the 128px increase in
host height when comparing different presentations. This is not evidence of
incorrect toolbar inset.

The visible E2E now compares hidden and revealed Role heights within fullscreen,
requiring the exact 38px delta, equal width and identical bottom edge. The normal
baseline still requires y=40 and fullscreen hidden content requires y=2. The
aggregate verifier additionally requires matching visible Role identities and
exact fullscreen geometry throughout hidden/revealed/hidden/pinned/hidden.
It validates optional Windows HWND evidence without accepting malformed handles
or permitting that field on AppKit records. No product geometry, timing or native
input behavior changes; the full ordered journey remains mandatory.

Sixteen adjacent checks pass, including changed host dimensions, malformed HWNDs,
wrong height in each fullscreen state and changed fullscreen width. Replaying
both actual 26c4fd4b macOS toolbar histories passes. Replaying this incomplete
Windows history parses its HWND but still rejects missing journey ordering.
Affected journey: CHROMIUM-WINDOWS-FULLSCREEN-TOOLBAR-012; internal-only E2E
correction. Windows completion remains pending. Evidence root:
`/tmp/rion-c55-win-package-artifacts/2026-09-06T09-28-18-950Z-win32`;
log: `/tmp/rion-c55-win-package.log`; checks: `/tmp/rion-toolbar-extent-*`.

Final validation passes all 3,386 Vitest tests, typecheck, scoped lint, complete
hygiene, coverage and production E2E isolation. The new verifier declaration
matches the repository's adjacent script declarations. macOS evidence above is
a replay of actual native histories; this Windows-only E2E assertion correction
does not claim a fresh local macOS desktop run or fresh Windows completion.


### Put the visible pointer inside the two-pixel reveal edge

CI 34025263334 at 0d2d437c passes the first 13 Windows phases and enters native
fullscreen, but never observes revealed controls. Its toolbar history contains
normal and fullscreen-hidden only. The E2E pointer used element origin with
x=1, y=1. The production reveal edge is exactly 2 CSS pixels high at y=0;
WebDriver element-origin offsets are relative to its in-view center, so y=1
moves to viewport y=2, outside the reveal edge. The driver now uses zero offsets
to target the center. Product pointerenter behavior, the 2px edge, authoritative
projection and complete revealed/pinned/restart requirements are unchanged.

This internal-only E2E correction affects
CHROMIUM-WINDOWS-FULLSCREEN-TOOLBAR-012. It keeps real WebDriver pointer input;
no synthetic DOM event or runtime command replaces the user action. Native
Windows acceptance remains pending. Evidence:
`/tmp/rion-0d2-win-package-artifacts/2026-09-06T09-40-57-761Z-win32/phases/chromium-fullscreen-toolbar-seed`;
log: `/tmp/rion-0d2-win-package.log`.
The offset contract is specified by [WebDriver](https://www.w3.org/TR/webdriver/#dfn-get-coordinates-relative-to-an-origin).

Sixteen adjacent toolbar checks, typecheck, scoped lint, source hygiene,
production E2E isolation and coverage validation pass. This Windows-only driver
correction introduces no shared/native product change; macOS's native pointer
adapter is unchanged. Checks: `/tmp/rion-toolbar-pointer-*`.


### Cross the host/Role boundary with acknowledged OS pointer input

CI 34025834042 at e380920e now reaches revealed toolbar state and passes the
same-fullscreen 38px geometry assertions. Its native history is normal, hidden,
revealed; the later Role WebContents click does not yield hidden state. Moving
WebDriver's target-local pointer in another WebContents is insufficient evidence
of the OS cursor leaving the host toolbar. This observation does not by itself
prove a product pointerleave defect.

The Windows toolbar E2E now uses the existing exact-PID/HWND foreground adapter
for both reveal and content movement. GetClientRect and ClientToScreen bind the
point to the actual native client extent; SetCursorPos performs the system move,
and GetCursorPos plus foreground equality must acknowledge the exact result.
Reveal targets the first client pixel, content targets the client center.
Coordinates are derived by native APIs in one process; no fixed desktop size or
renderer CSS-to-screen assumption is added. Both moves are separated by the
existing authoritative revealed-state wait, so the OS actually crosses the host
and Role boundary. The previous WebDriver host-target search is removed from
this helper. Native submission alone remains insufficient: hidden, revealed,
pinned, reversed and restart projections are still required.

The shared helper always includes its optional pointerTarget payload, preserving
strict PowerShell behavior for ordinary F11 focus calls. This internal-only E2E
correction affects CHROMIUM-WINDOWS-FULLSCREEN-TOOLBAR-012. Required AppKit input
is unchanged; no DOM dispatch, direct reveal/hide command, timer or retry replaces
the visible action. Windows execution remains pending.
Evidence: `/tmp/rion-e38-win-package-artifacts/2026-09-06T09-53-44-130Z-win32`;
log: `/tmp/rion-e38-win-package.log`.
Native coordinate contract: [ClientToScreen](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-clienttoscreen),
[cursor movement](https://learn.microsoft.com/en-us/windows/win32/menurc/using-cursors).

Final validation passes 30 adjacent checks and all 3,388 Vitest tests, typecheck,
scoped lint, complete hygiene, coverage and production E2E isolation.
No fresh macOS desktop execution is claimed for this Windows-only driver change;
its native Windows run is still required. Logs: `/tmp/rion-toolbar-native-pointer-*`.


### Macro UI setup awaits the native Role observation

macOS package job 101462497267 in CI 34024329384 at b76e249b fails
chromium-macro-ui-seed after logical Role running is visible but before the
E2E native Role observation arrives. The immediate assertion receives null.
The uploaded native topology history later contains the same visible AppKit
window at revision 5 without its Role surface, then the Role at revision 7;
the final session/runtime artifact contains its exact visible appkit-chromium
identity. This proves an observation-order race in the test prerequisite,
not an unavailable final native host.

After the existing visible launch and logical running checks, Macro UI setup now
awaits the exact Role's visible runtime observation and expected platform host,
then performs its existing Role and AppKit identity assertions. Its native
observation is event-fed; no product polling, launch retry or inferred success
is introduced. The E2E wait uses the same 45-second readiness budget as the
adjacent logical-running wait. A host that never arrives still fails.

This internal-only desktop driver correction affects both
CHROMIUM-MACOS-APPKIT-MACROS-UI-017 and CHROMIUM-WINDOWS-MACROS-UI-017.
Evidence: `/tmp/rion-b76-mac-shell-artifacts/2026-09-06T09-23-42-759Z-darwin/phases/chromium-macro-ui-seed`;
log: `/tmp/rion-b76-mac-package.log`.

The focused macOS Chromium AppKit Macro UI seed/restart profile passes on the
working tree, including both entity-persistence prerequisites (four passing
phases). Report: `.desktop-e2e-artifacts/2026-09-06T10-11-50-318Z-darwin/report.json`.
The MACROS-UI-017 aggregate journey passes. Three adjacent source checks,
typecheck through the E2E build, scoped lint, source hygiene and coverage pass.
Windows execution of this common preparation correction remains pending.
Logs: `/tmp/rion-macro-native-ready-*`.

The pure Electron production build and production E2E isolation check also pass
after restoring production assets; documentation validation passes.


### Reuse the visible Settings mode for repeated toolbar updates

Windows job 101468262984 in CI 34026488170 at 9e54640b passes native reveal,
the 38px same-fullscreen geometry checks, and native pointer leave. Its history
contains normal/hidden/revealed/hidden. It then fails looking for app-main-sidebar
while changing the preference to pinned. The failure screenshot shows the main
renderer correctly on Preferences with settings-mode-sidebar. This contradicts
an initial suspicion of an incorrect WebDriver target: the driver simply tries
to navigate through the ordinary app sidebar again after already entering the
separate Settings mode.

The preference helper now opens Settings through the visible app sidebar only
when Settings mode is not mounted. It still selects Preferences visibly when
needed, clicks the same switch, and requires both UI and Core preference
acknowledgement. Repeated pin/unpin operations therefore stay on the actual
Settings screen. Native pointer/foreground helpers and product UI are unchanged.
This internal-only E2E correction affects
CHROMIUM-WINDOWS-FULLSCREEN-TOOLBAR-012. Full pin/unpin/restart acceptance remains
pending on the next candidate.
Evidence: `/tmp/rion-9e5-win-package-artifacts/2026-09-06T10-07-55-728Z-win32/phases/chromium-fullscreen-toolbar-seed`;
log: `/tmp/rion-9e5-win-package.log`.

Sixteen adjacent toolbar checks, typecheck, scoped lint, source hygiene,
production E2E isolation and coverage pass. The next immutable candidate also
includes 08f05dc1's locally verified Macro UI native-readiness correction.
Checks: `/tmp/rion-toolbar-settings-mode-*`.


### Windows toolbar parity passes; route Role Quick Access through native focus

CI 34027029016 at ec0c4fb8 passes 17 Windows phases and 18 aggregate journeys.
Both fullscreen-toolbar seed/restart and Game Window UI seed/restart pass.
The complete toolbar evidence includes hidden/revealed/hidden/pinned/hidden,
exact 2px/40px insets and 38px same-fullscreen height deltas, persisted reverse
preference and normal exit. This closes the prior toolbar E2E blockers without
waiving later Windows, hardware or release gates.
Report: `/tmp/rion-ec0-win-package-artifacts/2026-09-06T10-19-35-713Z-win32/report.json`.

The next phase, quick-access-seed, fails to open the palette from the Role.
Native observations show its visible HWND lost foreground while the test only
requires document.hasFocus before WebDriver Ctrl+K. The existing macOS path
already focuses the exact AppKit host and submits a physical application chord.
The Windows path now shares the exact HWND/PID foreground and native scan-code
submission helper with F11; the private helper retains visible Role target
selection and restores the tracked main renderer afterwards. Ctrl+K uses the
existing physical modifier/key-up mechanism, adding only the K command mapping.
The requested window ID comes from the exact native Role inspection.

The page must still receive no K, the palette must actually open, Escape must
restore the exact source tab, and navigation/persistence checks remain mandatory.
No production shortcut routing, globalShortcut registration or synthetic DOM
open event is added. This internal-only E2E correction affects
CHROMIUM-WINDOWS-QUICK-ACCESS-015 and reuses the F11 preparation path covered by
CHROMIUM-WINDOWS-FULLSCREEN-TOOLBAR-012. AppKit retains its native adapter.
Windows execution remains pending. Log: `/tmp/rion-ec0-win-package.log`.

The focused macOS Chromium AppKit Quick Access seed/restart profile passes on
the working tree, including both entity persistence prerequisites (four passing
phases). QUICK-ACCESS-015 aggregate evidence passes with the retained native
AppKit focus and keyboard path. Report:
`.desktop-e2e-artifacts/2026-09-06T10-31-11-049Z-darwin/report.json`.
Twenty-eight adjacent input/toolbar/Quick Access checks, typecheck, scoped lint,
complete hygiene and coverage pass. Checks: `/tmp/rion-quick-access-native-*`.
This is macOS evidence only; native Windows Ctrl+K still requires the next CI.

Pure Electron production build and production E2E isolation pass after restoring
the production renderer; documentation validation also passes.


### Await transferred native ownership before the target Role click

macOS job 101466512710 in CI 34025834042 at e380920e fails
chromium-macro-cutover-topology-seed waiting for the post-Claim trusted click.
The fixture history instead records visibility, a new session and blur after
the transfer cursor. The test clicks immediately after the visible Claim button,
then checks the new native binding and automation readiness only after expecting
the click. The final artifact shows the transferred Role with native generation
2 and owner generation 3, so the target arrives after the unsafe click window.

The test now awaits the exact new tab/window binding, verifies increased owner
generation, and awaits automation-ready before clicking once. The shared native
binding wait requires the requested tab and window rather than accepting any
non-null prior binding. Existing platform identity assertions remain. Claim,
target click, macro start/stop and tab-close actions stay visible UI; no action
retry or mandatory reload is introduced. Core/Chromium product behavior is
unchanged. Both MACRO-MULTIROLE-005 and MACRO-OWNERSHIP-TRANSFER-010 Chromium
platform journeys are affected. Windows execution remains pending.
Evidence root: `/tmp/rion-e38-mac-shell-artifacts`;
log: `/tmp/rion-e38-mac-package.log`; checks: `/tmp/rion-macro-transfer-ready-*`.

A separate macOS package failure at 0d2d437c (job 101464991913) times out waiting
for the updater install journal acknowledgement in the packaged helper probe.
Its exact cause is not established by the timeout, and no larger timeout or
success-on-unknown rule is applied. It remains failure evidence pending further
native diagnosis; log: `/tmp/rion-0d2-mac-package.log`.

The focused macOS AppKit topology seed/restart profile passes on the working
tree. Report: `.desktop-e2e-artifacts/2026-09-06T10-38-17-594Z-darwin/report.json`.
This verifies the visible ownership-transfer and multirole journey with the
new ordering on macOS; Windows remains independently pending CI.

Pure Electron production build, production E2E isolation, documentation, source
hygiene, coverage and scoped lint pass after the local native run. Five adjacent
source checks pass; the E2E build includes typecheck. No Windows completion is
inferred from this macOS result.


### Windows Quick Access still fails; capture exact keyboard focus

CI 34027741452 at cb453a1a repeats the Windows Quick Access palette failure
(job 101471625005) after the same 17 passing phases and 18 passing journeys.
The fixture records a trusted qa-target click and no subsequent keyboard event;
exact foreground HWND/PID and native SendInput insertion checks pass. These
observations do not establish that the Role owns OS keyboard focus, nor do they
establish a production shortcut-routing defect.

The E2E helper now records the Role document focus immediately after native
foreground activation, plus the exact GUI thread's active/focused/root HWND and
GUI flags immediately before the physical chord. The bounded output contains
only focus identifiers and status; it does not log page contents or credentials.
GetGUIThreadInfo failure stays explicit diagnostic evidence, not successful focus.
No input retry, synthetic palette event or changed production routing is added.
This internal-only evidence improvement covers QUICK-ACCESS-015 and the shared
Windows FULLSCREEN-TOOLBAR-012 helper; native execution remains pending.
API contracts: [GetGUIThreadInfo](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getguithreadinfo),
[GUITHREADINFO](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-guithreadinfo),
and [GetAncestor](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getancestor).
Evidence: `/tmp/rion-cb4-win-package-artifacts/2026-09-06T10-34-35-113Z-win32`;
log: `/tmp/rion-cb4-win-package.log`.

Separately, macOS package job 101463341760 in CI 34024645026 at c55f05a7 is
confirmed successful. This newer successful package cohort does not explain or
waive the subsequent 0d2d437c updater acknowledgement failure.

Twenty-five adjacent checks, typecheck, scoped lint, source hygiene, documentation,
coverage and production E2E isolation pass. Checks: `/tmp/rion-quick-access-focus-*`.
The next candidate includes the verified 4c6d396a ownership-transfer ordering fix.


### Share updater journal acknowledgement and eliminate the subscribe/read gap

Source diagnosis of CP-16 finds two duplicate journal-removal waiters: the Darwin
helper probe and the Windows packaged transaction probe both check presence
before subscribing. Removal between that read and subscription can be missed.
The Windows copy additionally catches every access failure as successful removal,
including permission and I/O failures. This is a concrete source defect; the
0d2d437c CI timeout alone does not prove which race or native failure occurred.

Both probes now use electronUpdaterJournalAcknowledgement.mjs. Its synchronous
filesystem watcher is installed before initial readback. Exact-name or unnamed
filesystem events trigger readback; only ENOENT acknowledges removal. Stream
failure/closure, access failures and the existing external deadline reject.
The observer closes on every terminal outcome. There is no polling, retry,
extended timeout or elapsed-time success, and native updater process isolation,
journal authority, signature verification and marker/version checks remain.

Nine focused tests cover initial absence, deletion while the first presence read
is pending, unrelated events, unnamed events, EACCES/EIO, stream error/closure,
deadline failure and real temporary-filesystem deletion. Together with the
Darwin helper and CI fixture suites, 24 adjacent tests pass. This internal-only
probe correction changes no user journey and is not physical Windows evidence.
Checks: `/tmp/rion-updater-journal-*`. Both packaged native transactions remain
subject to their exact-candidate CI gates.

MacOS package job 101468263048 in CI 34026488170 at 9e54640b is now terminal
success, including source Chromium E2E, previous-version fixtures, package
structure, the Rust-owned updater transaction and packaged AppKit Role black-box.
CP-16 records this newer complete package cohort. It predates the current
journal observer correction; it is not verification of that correction.

All 3,397 JavaScript tests pass. Typecheck, complete lint (zero errors, existing
warnings retained), hygiene, the Tauri build, restored pure Electron production
build and production E2E isolation pass. Native packaged acceptance of the new
observer remains pending; no desktop E2E profile ran locally for this tooling-only
change.


### Native Role click before Windows Quick Access; Settings native readiness

CI 34028481131 at 03d80de1 fails Windows Quick Access (job 101473612915).
The new evidence reports document.hasFocus=true with the game canvas active,
but GUI thread keyboard focus equals the top-level host HWND (2097618), with
no child focus. The palette stays closed. WebDriver's trusted DOM click does
not establish the same native keyboard target as an OS pointer click in this
child-host arrangement. F11 can still pass through its retained HWND-level hook.

The Quick Access helper now moves the OS pointer to the exact visible host's
content center, verifies that the hit window's root is the expected HWND, and
submits one native left-button down/up pair. The fixture's exact role and trusted
qa-target click receipt must arrive before physical Ctrl+K. The helper does not
reactivate the parent after the child click. Existing page suppression, palette,
Escape/source restoration and persistence verdicts remain. This internal-only
E2E correction affects CHROMIUM-WINDOWS-QUICK-ACCESS-015; Windows execution is
still required. Native input insertion remains distinct from the fixture receipt.
Log: `/tmp/rion-03d-win-package.log`.

The same cohort's macOS Settings restart phase (job 101473612891) asserts a null
native runtime immediately after logical running status. Settings now waits for
the exact Role inspection's visible native owner with the expected platform host,
matching the Macro UI readiness boundary. Visible Open, macro Start/Stop and
preference persistence actions remain. Both platform SETTINGS-PERSIST-006 journeys
are affected; this is an internal-only E2E ordering correction.
Log: `/tmp/rion-03d-mac-package.log`; checks: `/tmp/rion-role-native-click-*`.


Further source inspection identifies a product routing gap: Windows Role child
hosts deliberately use focusable=false and WS_EX_NOACTIVATE for the native input
lane, while the focused top-level host's before-input-event handles only F11.
The host now recognizes Ctrl+K with the same shared classifier as Role pages,
suppresses both halves, ignores repeat, and dispatches once to its exact active
Core-projected tab through the existing Quick Access ingress. Current native
owner/lifecycle fences are checked before dispatch; closing/retired hosts cannot
issue requests, and Core errors reach the existing error owner. AppKit, the
Role-page interceptor and the required F11 hook retain their existing paths.
This product correction affects CHROMIUM-WINDOWS-QUICK-ACCESS-015; it is not
claimed complete until its native E2E passes.

The host behavior suite plus Quick Access source-boundary suite pass 41 checks,
including key lifecycle, modifiers, target identity, ingress rejection and
retired-host suppression. Checks: `/tmp/rion-host-quick-access-*`.
The focused local macOS Settings seed/restart profile passes with all entity
prerequisites: `.desktop-e2e-artifacts/2026-09-06T11-02-57-645Z-darwin/report.json`.


The local Quick Access rerun does not reach its target phases: entity seed fails
waiting for the Workspace Role's fixture session. Core evidence ends with the
Role launching and shutdown pending. The runner records failure; a live-process
sample shows the main thread idle in the AppKit run loop rather than establishing
a synchronous main-thread deadlock. After the runner terminalized, its exact
remaining Electron process was killed; this cleanup is not successful E2E evidence.
Failure root: `.desktop-e2e-artifacts/2026-09-06T11-08-40-401Z-darwin`;
sample: `/tmp/rion-host-quick-access-macos-hang.sample.txt`.
MacOS Quick Access acceptance on this candidate therefore remains pending.

The first full suite catches a test-only destroyed-window getter in the new
retirement case; retaining the original WebContents before closing corrects the
test and all 41 adjacent cases pass. A later full suite hits the real filesystem
journal test's 1s deadline during concurrent package I/O. Thirty independent
native filesystem iterations pass (maximum 14.5ms). That real-I/O test now uses
5s within the existing 10s test budget; the deterministic deadline-failure test
keeps its exact 1s fake clock and production acknowledgement remains 120s.
Native Rust lint and all 1,643 Rust tests pass (four intentional ignored probes).

The final full JavaScript suite passes all 3,399 tests. Typecheck, scoped lint,
complete hygiene, restored pure Electron production build and production E2E
isolation pass. Settings macOS E2E passed before the Windows-only host routing
change; the later macOS Quick Access profile failed in its entity prerequisite as
recorded above. Windows Ctrl+K, the new native click and the shared updater
acknowledgement still require the next immutable CI candidate.


### Clarify the local launch trace while the combined candidate runs

The local 11:08:40 entity failure trace does not establish premature shutdown.
cleanExitDiagnosticsObserver also labels normal placeholder reconcile calls as
cleanExitRolePlaceholders. embeddedFollowRoleOwnership can return an EventBound
continuation, so the executor wrapper's completed observation does not mean the
native transition terminalized or its acknowledgement was lost. The shared
AppKit focus ABI already activates NSApp and makes the exact window key. No
speculative AppKit focus change is justified by this trace. The unresolved local
failure remains recorded; native acceptance of 79ea9b13 is CI 34029657056.

The earlier 03d80de1 cohort now has terminal success for both native validation
jobs and Windows Tauri desktop E2E. Its Chromium package failures and macOS Tauri
failure remain independent failures; those native passes do not close CP-15/18.


### Windows native click acknowledged; remove the incompatible child-focus precondition

CI 34029657056 at 79ea9b13 (Windows job 101476744058) reaches Quick Access after
its prior 17 passing phases. The exact native content click and trusted qa-target
fixture receipt pass; the next wait fails because document.hasFocus remains
false. Ctrl+K has not yet been submitted, so this does not test the new host
routing. This matches the explicitly non-focusable/no-activate child host.

Quick Access now proceeds from the trusted native click to the existing exact
foreground HWND/PID chord submission, without requiring the child document to
own OS keyboard focus. The fullscreen helper keeps its existing document-focus
check. Native focus diagnostics, the real palette-open assertion, K suppression,
Escape source restoration and persistence outcomes remain. This internal-only
E2E precondition correction affects CHROMIUM-WINDOWS-QUICK-ACCESS-015; it does
not waive the product's host input or Quick Access outcomes. Native Windows
acceptance remains pending. Log: `/tmp/rion-79e-win-package.log`.

Twenty-one adjacent checks, typecheck, scoped lint, source hygiene, coverage,
documentation and production E2E isolation pass. No local desktop profile was
rerun for this Windows-only E2E precondition change.
Checks: `/tmp/rion-quick-access-host-focus-*`.


### Capture macOS failed-test stacks before a potentially unresponsive screenshot

Repeated macOS native failures can also time out during screenshot capture,
leaving no native thread evidence. The Tauri and unpackaged Electron WDIO hooks
now cache the authenticated probe's PID plus its ps parent/start-time/executable
identity at startup. On a failed test, the hook rechecks that identity and takes
one two-second macOS sample before requesting the screenshot. Changed/missing
identity and sampling failure are explicitly unavailable evidence; they do not
sample a replacement process or replace the original test failure. Windows skips
this OS-specific diagnostic. Packaged black-box admission is unchanged.

This is internal-only desktop test evidence, not product performance diagnostics.
No product UI, IPC, sampler, setting or recurring monitor is restored. No retries
or correctness polling is added. The .sample.txt artifact is included in the
existing failure artifact directory. Seven focused tests pass, including identity
change, unavailable/ambiguous identity, sample failure and non-macOS behavior.
A real read-only sample of an agent-owned local child process succeeds and the
child is then terminated. Evidence: `/tmp/rion-native-failure-sample-live.txt`;
checks: `/tmp/rion-native-failure-sample-*`.


### Current candidate progress and failure evidence (cbbf3c9a)

CI 34030205568 Windows Chromium job 101478202246 passes 23 phases and
21 of 50 journeys. Quick Access seed/restart and settings persistence seed/restart
now pass. The next physical trusted-input phase fails, causing ten dependent
journeys to report FAIL and leaving nineteen NOT_RUN; these are not ten
independent root failures. System settings/font application, full Macro and
recovery acceptance, and Windows packaging remain pending.

The physical input probe validates native key-down/key-up submission identities,
ordering and restored keyboard state, then fails the exact trusted DOM sequence.
The previous error omitted whether input was missing, partial or mismatched.
Its failure now includes the pre-dispatch DOM focus state, exact native receipts
and at most eight authenticated receipts for that probe sequence. No deadline,
trust assertion or focus-preservation requirement is relaxed. This is
internal-only evidence for CHROMIUM-WINDOWS-TRUSTED-INPUT-PHYSICAL-009 and its
existing dependent journeys; Windows execution of the new evidence is pending.

The local macOS Quick Access prerequisite still fails entity launch. At
`.desktop-e2e-artifacts/2026-09-06T11-38-34-243Z-darwin`, the failure hook now
successfully captures the admitted Electron process before screenshot cleanup.
The initial config-local sampler was unavailable across hook module instances;
a worker-global symbol registry now carries the admitted sampler, with a
separate-module handoff test. The captured main thread waits in the AppKit event
loop; this does not establish a synchronous main-thread deadlock or resolve the
missing launch receipt. The local profile remains failed, not waived. Product
performance diagnostics and high-refresh settings remain removed.

Validation for the failure-evidence changes: ten focused tests, typecheck,
full lint (23 existing warnings, zero errors), full hygiene, documentation,
coverage manifest, pure Electron build and production E2E isolation pass.
The first full suite reports 3406 passes and one diagnostics-export cleanup
observation timeout; that unchanged file passes all nine tests in isolation,
and the subsequent full suite passes all 3407 tests. This does not erase the
initial timing failure. No production Rust/native implementation changed in
this candidate. The local macOS Chromium Quick Access profile fails its entity
prerequisite as recorded above; Windows and Tauri hook acceptance require CI.
Evidence logs: `/tmp/rion-resume-*`.


### Release the E2E runtime lock before native geometry readback

Downloaded cbbf3c9a Tauri event artifacts narrow the native-control stalls:
Windows records `native-control-submitted` sequence 899 for the real minimize
click and the subsequent visible pointer/control receipts. macOS records the
restore submission (`action: normal`) at sequence 372 after the minimized
observation. Both control helpers then synchronously request a window snapshot;
the native action itself is not simply missing from the event stream.

Source inspection finds the snapshot holds the runtime-state mutex while calling
WebView position/size accessors for divider surfaces on both platforms and Role /
Workspace chrome surfaces on macOS. Those native accessors may wait for the UI
thread while presentation callbacks need the same mutex, contrary to the Tauri
scope's no-lock-across-native-calls invariant. The snapshot now clones the exact
handles and metadata under the lock, ends that statement, then reads native
geometry. The Windows Role/Workspace snapshot already follows this pattern.
This removes a concrete deadlock risk; native E2E must still establish whether
it resolves the observed stalls. No timeout, event fence or assertion is waived.

This internal-only change affects RUNTIME-TAB-TOPOLOGY-009 and
MACRO-OWNERSHIP-TRANSFER-010 through their existing full-profile phase. It adds no
product behavior or E2E omission. Chromium snapshot owners remain separate and
unchanged. Native macOS validation is running; Windows validation is pending CI.
Evidence: `/tmp/rion-cbb-tauri-{mac,win}-artifacts` and
`/tmp/rion-snapshot-lock-*`.

Native validation after the lock correction: macOS Rust lint passes; all 1643
Rust tests pass with four existing ignored tests; the desktop-e2e feature build
passes. The local `full --phase=p1-cross-domain-topology-force` profile records seed PASS and topology EXPECTED_FORCE_TERMINATION after the
spec passes, including the previously failing minimize/restore and Macro
ownership-transfer path. All three selected journeys report PASS. Report:
`.desktop-e2e-artifacts/2026-09-06T11-51-13-828Z-darwin/report.json`.
This is focused native evidence, not a full-profile pass or Windows validation.
Source hygiene, documentation and the unchanged coverage manifest also pass.


### Bound Windows file-dialog control discovery to native child HWNDs

At e9c528f8, CI 34031176626 Windows Chromium job 101480843434 fails earlier
than the trusted-input phase: the visible Workspace Web upload's helper is
terminated at its existing 15-second external deadline. The uploaded
`windows-native-file-dialog-progress.json` records `reading-dialog-controls`.
This run supplies no new keyboard-probe evidence and does not supersede the
previous exact trusted-input failure.

The helper previously searched the entire UIA descendant tree to discover only
the standard filename Edit (1148) and Open Button (1). Discovery now enumerates
real child HWNDs of the already owner-admitted #32770 dialog, with a finite 2048
child bound and exact class/control-ID matching. Only matching handles are
converted into UIA controls. Owner-admitted fallback windows must also be the
common-dialog class before any child lookup. Unique control cardinality, visible
clicks, enabled/offscreen checks, foreground ownership, exact native filename
write/readback, dialog closure and the page's File receipt remain required.
Neither the external deadline nor any product assertion changes. The native
helper still needs Windows CI execution; portable tests cannot prove Win32
control reachability. No product runtime code changes.

This internal-only correction affects CHROMIUM-WINDOWS-WORKSPACE-WEB-FILE-UPLOAD-028
through its existing fullscreen seed/restart profile. Eleven adjacent checks,
typecheck, scoped lint and source hygiene pass. Logs:
`/tmp/rion-native-dialog-controls-*`; native failure artifacts:
`/tmp/rion-e9-win-shell-artifacts`.

The same e9c528f8 CI's macOS Tauri job 101480843494 now reports full success,
without the later snapshot-lock correction. This confirms intermittency; it does
not invalidate the source-local lock violation or establish a single root cause.
The corrected snapshot's local focused pass remains separately recorded above.


### macOS package acceptance now includes the shared updater journal observer

CI 34029657056 at 79ea9b13, macOS Chromium job 101476744017, is terminal
SUCCESS. Its source AppKit Chromium E2E, prior-version updater fixtures, package
structure verification, packaged Rust-owned updater transaction and packaged
AppKit Chromium Role black-box E2E all pass. This candidate includes the
5bfe4c9e shared race-free journal-removal observer, so CP-16 no longer relies only
on the earlier 9e54640b package acceptance that predates that correction.

The job uses the existing ephemeral updater trust fixture; it is native package
and transaction evidence, not production-key acceptance or publication. Windows
package acceptance, the later exact-candidate cohort and CP-17/18 release gates
remain open. Authoritative step results:
`/tmp/rion-run-34029657056.json`.


### Exact Windows native key failure: submitted messages, zero DOM input

CI 34031575054 at 69ee94df, Windows Chromium job 101481944833, reaches the
physical input gate and fails. The new diagnostic records a visible no-activate
child, exact parent ownership and foreground parent; the input element is active
but document.hasFocus is false. Both Win32 key receipts are submitted within
deadline with ordered dispatch sequences and restored keyboard state. The only
preload receipt is the arm acknowledgement: no keydown or keyup is received.
This is missing DOM delivery, not a modifier/order mismatch. Log:
`/tmp/rion-69-win-package.log`.

The failure path now runs a bounded public sendInputEvent comparison on the same
WebContentsView and native child attachment, first visible and then hidden. Each
sample has its own authenticated sequence and records before/after native
projection observations and bounded DOM receipts. This is an experiment only;
the original native-key failure still throws and exits unsuccessfully even if
both public samples work. It does not establish full Role or held-key/ownership
parity, expand Electron's documented focus contract, or change the product
submission owner. CP-08's implementation decision requires reassessment against
actual product-path evidence, and CP-09 native acceptance remains open.

The independent physical input phase now runs immediately after shell smoke in
chromium-windows-smoke, before unrelated CRUD/setup phases. Its spec creates its
own native probe fixture and does not depend on entity-persistence state. No
journey, dependency, assertion or coverage target is removed. This internal-only
probe change affects CHROMIUM-WINDOWS-TRUSTED-INPUT-PHYSICAL-009 and its existing
Macro-dependent journeys; their failure remains a failed profile. Eight adjacent
checks, scoped lint and coverage validation pass; Windows execution of the
comparison remains pending.


### Pinned Electron input source audit and native file-dialog acceptance

The pinned [WebContents implementation](https://github.com/electron/electron/blob/v43.4.1/shell/browser/api/electron_api_web_contents.cc#L3498)
looks up the exact RenderWidgetHostView, converts the supplied event and forwards
keyboard/mouse input to its RenderWidgetHost. That wrapper has no window-focus
check; downstream delivery conditions still require evidence. The pinned
[Windows focusability implementation](https://github.com/electron/electron/blob/v43.4.1/shell/browser/native_window_views.cc#L1332)
sets the no-activate style and removes focus when focusability is disabled.
These sources explain why native HWND-message routing and direct Chromium input
may differ; they do not override the public API's documented focus condition or
establish successful product delivery. The first same-attachment comparison attempt is recorded below.

CI 34031929737 at efd818cf, Windows Chromium job 101482931161, reaches the
physical-input phase after the native-dialog-control correction. Its preceding
visible file-upload phases pass; the new lookup therefore has native Windows
execution evidence, beyond portable source tests. The job still fails native
key input with zero DOM events, independently reproducing the 69ee94df result.
Log: `/tmp/rion-efd-win-package.log`. The parent/child ownership, restored keyboard
state and arm receipt remain valid; none can substitute for the missing DOM
acknowledgement.


### Cancel the failed probe sequence before independent public-input samples

CI 34032327982 at 9e74a2f4, Windows job 101484013474, reproduces missing native
DOM input. Both public comparisons fail preload arm admission: the original
unfulfilled sequence remains pending. No public input was submitted, so this
run is not evidence that sendInputEvent succeeds or fails on that attachment.
Structured report: `/tmp/rion-9e-public-comparison.json`.

The private probe protocol now cancels only the exact requested pending sequence
and returns an authenticated cancellation acknowledgement before another sample
can be armed. Wrong-sequence cancellation is rejected without changing pending
state. Each comparison also cancels its sequence on completion/failure. Native
input uses KeyA, visible public input KeyB, and hidden public input KeyC; delayed
events from an earlier sample cannot satisfy a later sample. The product gate
still fails its original native receipt requirement. No product IPC, input
adapter or deadline changes.

Executable preload-protocol tests cover exact cancellation, rejected overlapping
arms and a delayed native key failing the comparison. Ten focused/adjacent tests,
typecheck, scoped lint, source hygiene and coverage checks pass. This remains
internal-only work for CHROMIUM-WINDOWS-TRUSTED-INPUT-PHYSICAL-009; native comparison
acceptance awaits the corrected candidate. Windows file upload acceptance is
independently confirmed by the efd818cf report: both fullscreen seed/restart
phases and CHROMIUM-WINDOWS-WORKSPACE-WEB-FILE-UPLOAD-028 pass.

Full-suite validation for the cancellation correction: the first run passes 3407
and fails two tests (real journal removal and escaped-helper pipe cleanup) at
existing native I/O deadlines. Both unchanged files pass all 14 tests in an
isolated recheck; the subsequent complete suite passes all 3409 tests. No timeout
or production behavior was modified to obtain that result. The initial failures
remain recorded as intermittent validation limitations. Documentation and
production E2E isolation pass. Logs: `/tmp/rion-input-cancel-*`.


### Same-attachment public input succeeds; replace the failed Win32 submission owner

CI 34032865591 at dffdfb6d, Windows Chromium job 101485549957, reproduces the
native key failure and successfully performs both independent public comparisons.
Visible KeyB and hidden KeyC each produce exact keydown/keyup sequences with
isTrusted true, matching modifiers and matching private frame/sequence identity.
The parent remains foreground and visible; the target remains non-foreground and
without thread focus. The hidden target remains natively invisible. Native
before/after handle tokens and geometry match. Structured evidence:
`/tmp/rion-dffd-public-comparison.json`; full log:
`/tmp/rion-dffd-win-package.log`.

CP-08's earlier decision to retain Win32 submission must therefore be revised:
it selected an implementation that does not deliver DOM events, while the pinned
public API delivers on the same attachment. The replacement will use a single
Chromium submission owner for Windows foreground/hidden input, retain the
required AppKit adapter and preserve Core identity/epoch/document fences plus
trusted DOM acknowledgement. The documentation's focus caveat remains a pinned
compatibility obligation, not a blanket future-version guarantee. Complete
product Role, pointer, held-key, retirement and Macro parity is still required.
The extra Windows child-host arrangement must be audited after submission parity;
its presence is not justified merely by the old HWND-message implementation.

The new `chromiumWebContentsInput.ts` leaf implements common event translation:
exact supported key codes and modifiers; view-local DIP conversion from CSS and
zoom without native parent offsets/display-DPI scaling; bounds rejection before
mouse-down; and propagation of partial submission failures. It returns explicit
webContents.sendInputEvent submission evidence and does not claim OS keyboard
state restoration or domain completion. Nine behavior tests, typecheck and
scoped lint pass. This is an implementation building block, not yet wired to the
product adapter. Next required work is owner/receipt integration, removal of
Win32 key/mouse submission, and the complete native product-path gate. No task
is marked complete from this leaf's tests.

A supplemental macOS native Chromium API sample at zoom 1.25 sends DIP (101,121)
and observes trusted middle-button down/up at integral DOM CSS (80,96), not
(80.8,96.8). The new leaf therefore floors its expected positive CSS readback after
zoom conversion; exact DOM acknowledgement remains required. Evidence:
`/tmp/rion-chromium-fractional-report.json`. This isolated API experiment is not
Windows or product Role acceptance. Pure Electron build and production E2E
isolation also pass for the new leaf's source graph.

- CP-08/09 working-tree continuation after `fad92f6b`: the Windows product
  attachment owner now calls the shared Chromium key/click primitives. Removed
  the 1,044-line Rust Win32 key/mouse submission module and its addon exports.
  ABI v6 adds an opaque read-only foreground/active/focus identity; submission
  compares exact native observations and viewport before every event and after
  delivery. Receipts explicitly name `webContents.sendInputEvent` and no longer
  claim Win32 scan codes or keyboard-state restoration. Trusted DOM completion,
  Core input epochs, cancellation and AppKit remain separate existing gates.
  The Windows physical probe loads these exact product modules through a closed
  E2E-only loader; it no longer maintains an independent native submission path
  or a failure-only public-API comparison. Journey
  CHROMIUM-WINDOWS-TRUSTED-INPUT-PHYSICAL-009 reflects the ABI/API change.
  Focused seven-file validation passed 50 tests, including stale identity,
  deadline, focus/viewport changes, hidden delivery and partial mouse submission.
  Native Windows product and full Macro acceptance remain pending. The extra
  per-Role native child attachment still requires a subsequent necessity audit.
- Latest historical CI `34032865591` at `dffdfb6d` completed with failures: both
  native validation jobs, checks, renderer, sanitizer and macOS Tauri desktop
  E2E passed; Windows Tauri desktop E2E and both Chromium package validation
  jobs failed. Earlier successful package/profile evidence is historical and
  does not certify this working-tree input replacement or final cutover.

- CP-08/18 continuation validation: all 441 Vitest files / 3,428 tests passed
  after moving the E2E loader into the existing `scripts/electron*` transition
  scope; the first full run correctly rejected its unscoped filename. Typecheck,
  macOS Rust lint, source hygiene and unchanged E2E coverage targets passed.
  The paired SYSTEM-SETTINGS-013 legal-document action now waits for the actual
  Open button to exist and become clickable after route navigation, instead of
  asserting a transient empty element collection. This addresses the observed
  macOS `dffdfb6d` failure location; native rerun remains required and is not
  inferred from the selector change.

- CP-08/18 final local continuation checks: macOS workspace Rust tests, stable
  `build`, production `build:electron`, and `check:desktop-e2e-isolation` passed.
  Full ESLint passed with the same 23 existing renderer warnings and no errors.
  Final pointer receipt checks compare view-local DIP with the requested zoom
  and integral DOM CSS coordinates rather than mixing native physical pixels;
  the two affected suites passed 23 tests and typecheck passed afterward.
  No macOS or Windows desktop E2E profile ran locally for this batch; paired CI
  and mixed-scale hardware gates remain pending.

- CP-08 child-host necessity audit, working tree after `6b672182`: extended the
  existing native Chromium API experiment with two WebContentsViews attached
  directly to one standard BrowserWindow. A visible sibling retains focus while
  the target stays hidden and unfocused at a nonzero view origin and 125% zoom.
  The experiment executes the same product key/click primitives through the
  closed E2E loader, records their submission receipts, and requires trusted
  Ctrl+Shift+KeyB down/up and middle-button down/up at DOM (80,96) from DIP
  (100,120). Local macOS Electron 43.4.1 / Chromium 150.0.7871.224 passed both
  samples and all 18 recorded scenarios; the native integration test passed.
  Report: `/tmp/rion-direct-host-probe/chromium-input-darwin.json`; log:
  `/tmp/rion-direct-host-native.log`. This is a standard-host experiment, not
  retained AppKit product acceptance or Windows evidence. Windows native probe
  execution and exact Role ownership/retirement parity must precede removal of
  the per-Role Windows child host. Product code and capability claims are unchanged.

- CP-08 exact candidate `6b672182`, CI `34034650727`, Windows Chromium job
  `101490402619`: foreground key and mouse submission passed their exact public
  API/native-fence/trusted-DOM assertions, advancing beyond the old Win32 input
  failure. The physical phase then failed before hidden submission because the
  sibling Role lacked document focus. Inspection found the probe attached its
  sibling native HWND only after checking focus. The continuation moves exact
  native attachment/projection before focus admission, matching product ordering,
  and adds failure-only native/Chromium visibility/focus evidence. It retains the
  strict focus assertions; hidden product parity is still unproven. Log:
  `/tmp/rion-6b-win-package.log`. The other jobs remain independently live.

### CP-08 remaining child-host replacement boundary

The Windows child-host owner is not only an input sender. The source audit at
`f603f190` identifies the following responsibilities that a direct Chromium
View owner must preserve. This is an implementation boundary for the existing
CP-08/09 task, not an additional product mode or permission gate.

| Current responsibility | Direct-View replacement and retained evidence |
| --- | --- |
| `#stageChild`, native attach/project, child HWND/DPI bounds | Attach the exact WebContentsView directly through the existing surface registry callbacks and public `contentView` ownership. Remove per-Role BaseWindow creation and Win32 child style/reparent/project code after native equivalence passes. Keep one exact runtime-parent native identity and read-only OS focus observation. |
| `reparent`, staged child rollback, binding/native generations | Preserve Core-issued logical ownership, exact View membership, binding revisions, cancellation before commit and source restoration on partial failure. Do not treat a parent-window handle as a unique Role identity; multiple Role Views share that handle. |
| `#focusForeground`, `#currentInputDeliveryMode` | Preserve the distinction between visible input admission and hidden input in an already-foreground runtime parent. Hidden submission must neither activate the target nor change the selected sibling. Native/Chromium focus observations and private trusted DOM receipts remain separate. |
| `syncPresentation`, `subscribePresentation`, held-key continuity | Forward committed View visibility changes through the existing presentation event path. `WindowsChromiumHeldKeyContinuityCoordinator` currently consumes child-hide events; it must receive the corresponding exact View-hidden event after child removal. No polling or inferred visibility. |
| `retire`, `dispose`, unexpected child close, quarantine | Detach and retire the exact Role View, revoke pending input and subscriptions, and retain parent-close/WebContents-destruction failure evidence. Quarantine must hide only the affected View; never hide or close the shared runtime parent and sibling Roles. |
| Input ABI and receipt validation | Remove child-style/child-HWND/single-child receipt claims together with their producers and consumers. Keep generation/epoch/frame/request identity, exact parent observation, monotonic submission receipts, view-local DIP conversion and complete trusted DOM event matching. |

The ordinary-host experiment at `f603f190` is evidence for API feasibility on
macOS, not a Windows product acceptance result. The Windows native experiment must establish direct-host feasibility. The
replacement must then satisfy the physical foreground/hidden gate with its actual
owner and receipt path; a failure caused by the old child topology is not a
prerequisite to retain that topology. Required regression scope includes paired Macro
hold/release, hidden continuity, reload, ownership transfer, exact retirement,
topology/recovery and native shortcut journeys. Retained AppKit presentation and
trusted input are outside this Windows child-host removal.

- CP-08 candidate `f603f190`, CI `34035021096`, Windows Chromium job
  `101491393586`: corrected sibling attachment order still failed the exact
  focus precondition. The failure now proves parent foreground/visibility,
  same-process/UI-thread ownership, exact child style and visible sibling HWND,
  while both sibling `webContents.isFocused()` and `document.hasFocus()` are
  false. Hidden target submission was not attempted. Log:
  `/tmp/rion-f603-win-package.log`. This removes attachment ordering as a
  sufficient explanation and motivates the direct-View replacement; it does not
  justify weakening focus assertions. The direct-host Windows native experiment
  remains in the live native-validation job.
- CP-08 direct-parent preparation: the existing read-only runtime-parent API now
  returns the same process/UI-thread-bound focus identity used by child input
  observations. One canonical helper binds foreground, active and focus slots
  without exposing HWND addresses. Parent readback rejects a foreign calling
  thread, and the TypeScript state stream rejects a malformed focus identity.
  No new native activation, window mutation, input API or polling was added.
  The retained child path still uses the helper until its replacement is
  accepted. Focused macOS Rust tests passed 9 cases; paired-platform host mocks
  and submission-owner tests passed before the additional malformed-focus case.

- CP-08/18 parent-focus preparation validation: native macOS `lint:rust`,
  workspace `test:rust` (1,640 passed, 4 ignored), stable build and production
  Electron build/isolation passed. The full 441-file suite passed 3,429 tests
  with two workers after the builds finished. Earlier default-worker runs
  separately hit the existing real filesystem journal-observation deadline and
  macOS escaped-helper cleanup indeterminate boundary. Both failures remain
  recorded; neither deadline nor success condition changed. The journal test
  now includes failure-only watch/access/unlink timestamps for future diagnosis.
- CP-15/16 CI `34035021096` at `f603f190`: Windows native validation stopped at
  `terminal_receipt_create_new_commit_has_exactly_one_concurrent_winner` with
  `UnsafePath`; the Chromium API experiment had not run. CI now schedules that
  addon-independent experiment immediately after dependency installation in
  both native jobs, before unrelated Rust validation. Rust failure remains a
  failing gate. Investigating the updater concurrency failure is still required.
- CP-15 exact macOS Chromium artifact from `f603f190` stored the settings Macro
  delay as 160,000 ms, although its test attempted 60,000 ms. Replaced three
  duplicate clear/set sequences with one visible select-all/type helper using
  WebdriverIO's cross-platform `Key.Ctrl`, and assert the numeric field and
  committed Macro value before proceeding. Affected paired journeys are
  SETTINGS-PERSIST-006, MACROS-UI-017 and MACRO-NATIVE-EFFECT-018. The local
  settings-seed rerun stopped in its entity-restart prerequisite because the
  Open workspace button did not display; it did not validate the numeric fix.
  Report: `.desktop-e2e-artifacts/2026-09-06T13-26-27-224Z-darwin/report.json`;
  log: `/tmp/rion-number-edit-e2e.log`. This remains a failed prerequisite, not
  a passing settings journey.
- CP-08/15/16/18 continuation handoff: final local typecheck, six focused files
  (60 tests), full ESLint (0 errors; 23 existing renderer warnings), hygiene,
  documentation/coverage checks and production Electron build/isolation passed.
  The final full suite passed 441 files / 3,430 tests with two workers. The
  updater concurrency test passed locally on macOS; test-only error output now
  preserves the original ACL rejection reason for the next Windows failure
  without retrying a security mutation or changing the production error type.
  No successful desktop E2E profile is claimed for this working tree. Exact
  Windows direct-host feasibility, current native focus readback, updater
  concurrency and paired settings/Macro journeys remain pending CI.


### Direct-host viewport evidence and independent native gates

- CP-08, candidate `0bb4c9e6`, CI `34037646504`, Windows native job
  `101498649410`: all 18 samples received trusted events. The ordinary parent
  with a hidden Role View preserved the visible sibling focus, and the hidden
  Ctrl+Shift key pair matched exactly. The middle-click assertion failed:
  the hidden renderer still reported 300 by 200 CSS pixels rather than the
  expected 240 by 160 at 125% zoom, and received (100,120), not (80,96).
  This does not establish a platform-specific coordinate conversion rule.
- The revised experiment gives target and sibling separate ephemeral Sessions
  and subscribes to the target renderer resize event before changing zoom while
  visible. It requires the exact 240 by 160 viewport acknowledgement before
  hiding and submitting. The acknowledgement deadline can only report an
  indeterminate failure. macOS passed the revised native test; Windows remains
  pending the next candidate. Production hidden-viewport acknowledgement and
  removal of the per-Role Windows child host are not yet implemented.
- CP-15/18: CI uploads the early API report immediately and continues independent
  Rust validation even when that experiment fails. A final explicit failure
  guard preserves the API gate. Fourteen workflow/probe tests passed locally.
- CP-14/16: the concurrent terminal-receipt publication test now runs 32 fresh
  synchronized two-writer rounds, retaining exactly one winner and exact stored
  bytes. macOS passed all rounds and Rust lint. Windows must still reproduce or
  clear the prior UnsafePath failure with its original diagnostic cause; no
  production ACL handling or security requirement has been weakened.
- CP-15, candidate `0bb4c9e6`, macOS Chromium job `101498541979`: the
  `chromium-fullscreen-toolbar-restart` phase failed because the AppKit terminal
  event did not reach final flush. Previous full-profile success does not close
  this candidate's gate. This failure requires separate investigation; it does
  not provide settings numeric-edit acceptance evidence.
- Follow-up artifact inspection confirms normal presentation in both Core and
  the native host at topology revision 10. Clean-exit observations complete
  AppKit events, navigation, popup and Core-effect drains, then stop with
  `cleanExitRoleSurface` started. The unresolved boundary is Role surface
  cleanup, not missing proof of the fullscreen transition itself.
- Local continuation validation passed source hygiene, documentation and E2E
  coverage checks, plus all 441 test files / 3,430 tests with two workers.
  No new successful desktop E2E profile or Windows native result is claimed.

- CP-15 cleanup diagnosis continuation: added E2E-only observations around popup
  owner retirement, AppKit input-surface retirement and native WebContents close
  invocation/return/error. These distinguish a pending owner lane, a synchronous
  native call and a missing destruction event. Four executable tests cover
  macOS/Windows role paths, original receiver/arguments, unchanged exceptions
  and the distinction between close return and the exact destroyed event.
  Five adjacent source-boundary tests, typecheck, focused ESLint, source hygiene
  and the E2E application build passed. Production code is unchanged; the E2E
  omission classification for the added observer is `internal-only`.
- Candidate `b7e843e5`, CI `34038576176`, remains live. The Windows job reports
  its early direct-input step successful, but its raw report was not available
  from the artifact listing at observation time. Do not close the direct-host
  evidence gate until that report or complete native test log is inspected.

- The early probe step uses `continue-on-error`, so its API-reported successful
  conclusion alone cannot establish its original outcome. The probe now saves
  partial samples and the exact thrown error before cleanup on failure, in
  addition to its existing complete success report. This avoids losing viewport
  acknowledgement failures before the final write. The final CI failure guard
  still checks the original step outcome.
- Candidate `b7e843e5`, Windows Chromium job `101501064854`, failed the existing
  child-host physical probe: parent foreground and visible sibling HWND were
  observed, but the sibling WebContents/document did not own focus. No hidden
  product input was submitted. Direct-View replacement remains required work;
  no focus precondition has been relaxed.


### View-owned input boundary preparation

- CP-08: added `ChromiumViewInputSubmission` for the direct-View replacement.
  Its identity binds Role/surface/native generations, binding revision, exact
  WebContents ID and native parent identity. Admission requires current View
  membership, parent foreground/visibility, matching focused contents and View
  visibility, exact zoom/bounds and an unexpired request. Every individual
  Chromium event and final receipt rechecks the observation. Reentrant delivery
  cannot interleave events. The receipt claims View ownership and API submission,
  never a per-Role HWND, child style or trusted DOM acknowledgement.
- This boundary is prepared source with focused tests, not yet wired into the
  production attachment coordinator. CP-08 stays in progress: replacement of
  child creation/reparent/retirement, receipt consumers and the physical product
  probe is still required. The AppKit product input path is unchanged.
- The focused new/existing input-owner suite passed 46 tests. Paired platform
  cases exercise invalid admission, a different View sharing the same parent,
  focus/binding/bounds/deadline changes after mouseDown, mutable observations and
  reentrant calls. Typecheck, focused ESLint and source hygiene passed.
- Candidate `b8711b59`, CI `34038920943`, Windows raw probe artifact now confirms
  failure before the direct hidden samples: the zoom acknowledgement timed out
  with an actual 300 by 200 viewport. All preceding 12 samples received events.
  Separate Sessions alone did not fix the precondition while the sibling covered
  the target. The next experiment acknowledges zoom while the target is focused
  and uncovered, before adding/focusing the sibling, then tests hidden delivery.
  macOS passed this revised native experiment. Windows remains pending.
- CP-11 retains the separate requirement to handle zoom changes on already hidden
  or occluded product Views. Preconfiguring the experiment while visible does not
  satisfy that product behavior or justify guessing a platform-specific scale.


### Windows direct-View feasibility established

- CP-08, candidate `78690558`, CI `34039248720`, artifact
  `chromium-input-windows-latest-34039248720-1`: all 18 API samples received
  events. The direct hidden target retained its exact 240 by 160 viewport at
  125% zoom; Ctrl+Shift+KeyB down/up and trusted middle down/up at CSS (80,96)
  matched. Both Views remained attached, the target remained hidden and
  unfocused, and the sibling retained focus before and after submission.
  This establishes the Windows API feasibility gate for removing the dedicated
  child host, alongside the prior macOS native experiment. It does not close
  product Role/Macro lifecycle parity or hidden-zoom update handling.
- The native validation suite now exercises `ChromiumViewInputSubmission` against
  the real Windows parent-readback addon in the same direct-View topology.
  The early addon-independent experiment stays separate. The new later test
  requires exact native parent/focus identities, complete trusted DOM events,
  monotonically increasing submission receipts and no child-HWND identity claim.
  CI uploads this later owner report separately, including failed partial samples.
- Local validation: the API experiment passed on macOS; the Windows-specific
  native parent-owner case was explicitly skipped on macOS and remains pending
  Windows CI. Fifty focused owner/workflow tests, typecheck, focused ESLint and
  source hygiene passed. The additional native test is internal verification,
  not a new product journey; E2E omission classification is `internal-only`.
- CI `34038576176` was cancelled after its Windows product probe had conclusively
  failed and newer `34038920943` was confirmed running the identical Windows
  Rust workspace checks plus the added cleanup diagnostics. Cancellation was
  for superseded failed source, not an elapsed observation deadline. Runs
  `34038920943` and `34039248720` remain distinct evidence candidates.

- The View submission owner additionally checks the actual WebContents ID and
  destroyed state independently of the observation adapter, before admission
  and every event. The focused View-owner suite now passes 38 cases.
- The Windows shell E2E job also runs the native View-owner test using its built
  addon after the existing smoke attempt, including when the old child-host
  physical test fails. The existing failure remains a failed job; this only
  prevents that known failure from suppressing independent replacement evidence.

- Windows native job `101502104765` at `b8711b59` reports successful Rust
  formatting/lints and workspace tests, then entered Electron native validation.
  The source includes the 32-round terminal-receipt concurrency regression.
  This run did not reproduce the earlier UnsafePath error; its historical
  failure remains recorded and no unproven ACL root cause or production fix is
  claimed. The new View-owner native test is not part of that older candidate.

- Final local continuation validation passed 443 test files / 3,472 tests with
  two workers, plus typecheck, focused lint, documentation, source hygiene,
  coverage and production E2E isolation checks. No local Windows native result
  or new successful desktop E2E profile is claimed for these changes.


### Direct View attachment and retirement implementation

- Added `ChromiumViewAttachmentCoordinator`, implementing the existing attachment
  port without creating a window, calling SetParent, or assuming one View per
  parent. It rejects aliased WebContents owners, keeps an immutable parent
  binding fence, and supplies the exact `ChromiumViewInputSubmission` owner.
  A move suspends source admission/subscriptions before native mutation, then
  commits the target or restores the exact source and visibility. Failed
  rollback quarantines only the affected View. Exact parent-close and contents
  destruction events revoke admission. Committed visibility changes publish the
  presentation events required by held-key continuity. Disposal revokes this
  adapter's bindings; the registry retains View and shared-parent lifetimes.
- The Windows native owner probe now uses this attachment coordinator before
  submitting hidden input, then checks exact ownership retirement. Product
  bootstrap and the current Windows trusted-input receipt consumer still need
  conversion before the old child-host coordinator can be deleted. This is an
  explicit remaining CP-08 implementation task, not a completed product cutover.
- Candidate `097552bc`, CI `34039832262`, Windows package job `101504456483`:
  the real native View-input-owner test passed in 1.12 seconds after the known
  old child-host product probe failed. This validates native parent/focus
  identities, trusted hidden key/middle events, exact zoom coordinates and
  monotonic View receipts. It predates the new attachment coordinator above;
  that coordinator's native result remains pending the next candidate.
- The earlier `b8711b59` cohort reports successful macOS and Windows Tauri desktop
  E2E jobs (`101501993987` and `101501993926`). These do not establish Chromium
  product parity or exact-current-candidate completion.

- Local attachment continuation validation passed 78 focused owner/lifecycle and
  workflow tests, typecheck, focused ESLint, source hygiene, documentation and
  production E2E isolation. The macOS API experiment passed with the expanded
  closed loader. No new desktop E2E profile or native Windows attachment result
  is claimed. The staged manager has no product route yet; the E2E omission
  classification for this preparation is `internal-only`.


### View receipts accepted by the existing trusted-input consumer

- The Windows trusted-input contract now distinguishes legacy child-HWND and
  direct-View identities/probes/submissions. The existing adapter accepts View
  receipts through its existing pending lane, exact private-frame DOM matching,
  cancellation and terminality path. View validation checks actual parent and
  WebContents identity, focus, membership, visibility, bounds and zoom; it does
  not invent child-HWND fields. The legacy branch remains explicitly typed until
  bootstrap replacement and deletion, not as a user-selectable alternative.
- Shared View identity/observation validation is used by both the producer and
  consumer. The consumer freezes its admission snapshot and compares canonical
  facts before native submission, even if a producer reuses its probe revision.
  Changed admission terminalizes as superseded before events. Mismatched identity
  or focus after submission remains indeterminate. Native submission alone does
  not complete an action without the matching trusted DOM events.
- Added `ChromiumViewTrustedInputHost` to bridge the attachment manager to that
  consumer, preserving stable native-port identity, exact observation revisions
  and revocation of previously resolved bindings. The real Windows probe now uses
  the bridge for key/mouse submission. Visible Core focus admission and product
  bootstrap conversion are still required before deleting the child coordinator.
- Candidate `2de6e0d6`, CI `34040672231`, Windows job `101506723396`: the native
  View attachment/input/retirement probe passed in 1.54 seconds. The old physical
  child-host product test still failed. This result predates the new consumer
  bridge above, whose native validation remains pending the next candidate.
- The same candidate's macOS package job `101506723417` failed in
  `chromium-macro-standby-recovery`: a fixture keydown had arrived, but the test's
  immediate read did not yet find the normal KeyS hold terminal receipt. The
  observer records receipts only after `coordinator.execute` completes, so DOM
  delivery is not a terminality barrier. The test now waits for the exact matching
  terminal record, then asserts its status once; non-applied outcomes are not
  retried toward success. Paired journeys are
  CHROMIUM-MACOS-APPKIT-MACRO-STANDBY-RECOVERY-023 and
  CHROMIUM-WINDOWS-MACRO-STANDBY-RECOVERY-023. Their new desktop runs remain pending.
- Local validation passed 111 focused ownership/adapter tests, then all 445 files
  / 3,512 unit tests with two workers. The subsequent standby E2E correction passed
  its 4 adjacent source checks and typecheck. Native macOS Rust lint and workspace
  tests passed (1,640 passed, 4 ignored), and coverage/source hygiene passed.
  The raw macOS API experiment passed with the expanded loader; no new Windows
  native result or successful local desktop E2E profile is claimed for this tree.

- Follow-up contract audit confirmed Core starts input epochs at zero. The View
  producer now accepts canonical `0` while continuing to reject `00`; 69 focused
  producer/host/consumer tests and final typecheck passed after this correction.
  The production Electron build and E2E isolation check also passed.


### Windows product bootstrap now uses direct View ownership

- Replaced the production `WindowsChromiumInputSurfaceAttachmentCoordinator`
  construction with `ChromiumViewAttachmentCoordinator`,
  `ChromiumViewTrustedInputHost` and exact View focus admission. The main-process
  configuration no longer supplies a per-Role BaseWindow factory. Standard
  Electron View membership and WebContents focus are paired with the existing
  read-only Windows parent-foreground proof; no HWND attachment/projection call
  is made by the new product composition. AppKit composition is unchanged.
- Visible focus admission subscribes before activation and waits for the exact
  View/parent observation. Hidden admission requires an already-foreground parent
  and never activates a parent or View. Core's deadline can fail admission, never
  establish success. Ownership movement, retirement, quarantine, presentation
  hiding and disposal supersede pending focus and release its subscriptions.
  Synchronous native callbacks cannot authorize input on a retired attachment.
- The existing trusted DOM consumer still owns key/mouse terminality. This change
  is `lower-layer-covered` behavior-preserving composition work, with focused
  attachment, focus, parent binding, host and consumer tests. Affected existing
  journeys include CHROMIUM-WINDOWS-TRUSTED-INPUT-PHYSICAL-009,
  CHROMIUM-WINDOWS-MACRO-BACKGROUND-TAB-004 and the paired
  MACRO-STANDBY-RECOVERY-023 journeys. No desktop E2E profile has passed for this
  new composition yet; Windows and both hardware-extended profiles remain pending.
- Previous candidate `71cb9fea`, CI `34042033350`, Windows package job
  `101510430478` again failed the legacy child-HWND physical probe because its
  visible sibling WebContents did not own focus. Its subsequent direct-View
  owner probe passed. The old physical probe must be converted to the new product
  mechanism while preserving foreground/background trusted DOM, modifiers,
  mouse coordinates and focus-preservation assertions. That probe and the unused
  child coordinator/native attachment implementation have not yet been deleted.
- Local full Vitest completed 446 files / 3,528 tests with two workers. After the
  subsequent presentation-invalidation addition, the final focused four files
  passed 47 tests. Typecheck, lint (zero errors, existing warnings), hygiene and
  native macOS Rust lint passed. Native Rust tests and production Electron build
  results are recorded after their completion below. No Windows native product
  acceptance or physical hardware evidence is inferred from these portable tests.

- Final local completion: macOS Rust workspace tests passed (1,640 passed,
  4 ignored), the stable build passed, and the production Electron build and
  desktop E2E isolation check passed after restoring Electron renderer output.
  The added product-composition case passed with its three adjacent tests;
  final typecheck and source hygiene passed. No local desktop E2E profile ran
  in this batch. Previous candidate `71cb9fea` also completed both stable desktop
  E2E CI jobs and macOS native validation successfully; its Chromium macOS
  package and Windows native jobs were still running at this checkpoint.

### Direct-View physical gate and empty-main-bundle correction

- The Windows physical probe now loads the same View attachment, parent binding,
  focus admission and input host classes as product composition. It creates one
  runtime parent with two independent Session/WebContentsView owners, removes
  all child-HWND attach/project/probe calls from this gate, and retains the
  private isolated-preload frame/sequence/trusted-DOM checks. The evidence records
  actual View membership, exact parent/WebContents identities, foreground and
  hidden admission, and unchanged foreground sibling ownership.
- The probe waits for a visible renderer resize acknowledgement at 125% zoom
  before checking left-click CSS coordinates. Hidden input now checks Ctrl+Shift+B
  modifier flags and middle-button down/up/auxclick coordinates. Wrong modifiers
  and coordinates are rejected by the private preload. No hidden focus repair or
  hidden viewport acknowledgement is inferred. Journey
  CHROMIUM-WINDOWS-TRUSTED-INPUT-PHYSICAL-009 and its manifest description were
  updated without lowering priority, outcomes or coverage targets. Its native
  Windows result remains pending; the old child coordinator/native implementation
  remains outside product composition until that verification permits deletion.
- Candidate `fb349add`, CI `34042924322`, macOS package job `101512797588`
  exposed an empty `out/main/index.js` before any desktop journey could start.
  The previous local build commands exited zero, but their 0-byte main output
  contradicts executable-build acceptance; the preceding checkpoint must not be
  read as successful runtime validation. The E2E verifier correctly rejected it.
- Local isolation identified the pinned electron-vite CommonJS-shim heuristic:
  the new private method spelling `#require(...)` triggered its textual detector.
  Its static-import scanner inserted the shim into a later string literal and
  the build silently emitted an empty main entry. Omitting only that plugin
  produced 1.43 MB; renaming the private method to `#requireRecord` produced a
  1.43 MB entry with the original complete plugin set. No bundler safety or E2E
  check was disabled. An explicit main-entry output guard now rejects empty or
  missing entries, and tests build both actual production and E2E entry points
  with the pinned Electron plugins and verify their startup code.
- Initial physical-gate/source checks passed 11 tests, the expanded private
  preload passed 4 behavior tests, and the actual bundle/attachment tests passed
  29 tests. A native macOS Chromium API experiment passed with the expanded closed
  loader. These are not Windows physical-input or AppKit desktop parity claims.
  Final local checks and the focused macOS shell phase are recorded below once
  their live processes complete.
- Final unit regression passed 448 files / 3,540 tests with two workers; the last
  focused bundle/probe/preload check passed 10 tests. Typecheck, lint (zero
  errors), hygiene and coverage passed. The local
  `chromium-macos-appkit-smoke --phase=chromium-shell-smoke` run passed its shell
  test with real Chromium and Rust startup (artifact directory
  `.desktop-e2e-artifacts/2026-09-06T15-50-01-589Z-darwin`). This is a focused phase,
  not a new full AppKit profile result. Relevant shell journeys are
  CHROMIUM-MACOS-APPKIT-SHELL-001 and its Windows pair; Windows remains pending.
  Native macOS Rust lint passed; its workspace tests and the subsequent stable /
  restored production Electron builds were still running at commit preparation.
- Completion of those local handles: native macOS Rust workspace tests passed
  (1,640 passed, 4 ignored). Both stable and restored production Electron builds
  passed. The restored executable main entry contains 1,431,638 bytes, and
  production desktop E2E isolation passed. Code candidate `242ab2f9` is being
  validated by CI `34043767144`; no new Windows physical verdict is claimed yet.
  The migration contract and Macro runbook now describe the direct-View ownership
  boundary instead of the superseded WS_CHILD/ABI-v5 gate; eight adjacent
  contract/source checks passed after that documentation update.

### Windows physical View gate passed; production dependency cleanup

- Candidate `242ab2f9`, CI `34043767144`, Windows package job `101515054943`
  passed `chromium-windows-trusted-input-physical` in 1.2 seconds. The raw
  `chromium-shell-e2e-Windows-34043767144-1` artifact confirms two exact sibling
  Views in separate Sessions, a 480x320 renderer acknowledgement for the 600x400
  DIP View at 125% zoom, trusted foreground KeyA/left-click events, hidden
  Ctrl+Shift+B down/up, and hidden middle down/up/auxclick at CSS (80,96).
  Hidden presentation and the foreground sibling were preserved. This proves
  the new physical gate, not every Core Macro/reload/topology journey.
- The same Windows smoke subsequently failed in
  `chromium-fullscreen-toolbar-seed`: the visible Role document did not gain
  focus. Its helper clicked through WebDriver before native foreground admission.
  Both Role-origin shortcut branches now bring the exact native parent forward
  and issue a physical content click, require the exact Role's trusted fixture
  click, then confirm document focus before sending native F11/Ctrl+K. The focus
  requirement is retained. The updated FULLSCREEN-TOOLBAR-012 manifest describes
  this primary-action provenance; native Windows verification remains pending.
- Public parent/presentation ports moved out of the legacy child coordinator.
  Product bootstrap no longer requires the old attachment addon interface.
  E2E attachment observation now wraps the actual View manager, and its loader
  no longer loads the unused legacy submission owner. Actual production and E2E
  bundle tests reject legacy HWND attachment/ABI entry points, while legacy
  implementation tests remain until full replacement parity permits deletion.
- The interrupted local validation had no remaining process handles or live
  compiler/test processes. Its incomplete full-test log included a macOS DMG
  resource error, so it was not accepted. A fresh single-worker full regression
  passed 448 files / 3,540 tests; no timeout or failed assertion was converted to
  success. After the shortcut helper update, five focused files passed 31 tests.
  The native macOS Chromium API experiment also passed with the reduced loader.
  Rust and final build completion are recorded after their active handles finish.

- Final local completion: native macOS Rust lint and workspace tests passed
  (1,640 passed, 4 ignored); typecheck, lint, hygiene, coverage, stable build,
  production Electron build and E2E isolation passed. No new local desktop E2E
  profile ran for the Windows-only native shortcut sequence. Windows smoke and
  both hardware-extended profiles remain pending their exact native execution.

### Retained Windows foreground observation separated from legacy attachment

- Moved `readWindowsRuntimeForeground`, its exact owner/focus/presentation
  classifier and tests to `windows_runtime_foreground.rs`. Shared native handle
  parsing, opaque focus identity and error construction now live in
  `windows_native_handle.rs`; the retained shortcut owner imports those helpers
  directly instead of depending on the legacy child-HWND probe module.
- The seven moved implementation bodies were compared against the prior source
  and preserved. Export names, hash domains, identity fields, statuses and error
  messages are unchanged. The old attachment/probe still uses the same helpers
  while awaiting final deletion; no native input capability or platform fallback
  was added. The stable Tauri path is unaffected by this Node-addon module split.
- Fourteen focused native Rust tests passed, including new pure handle parsing
  cases for exact nonzero addresses and null/wrong-width rejection. Twenty-two
  focused adapter/bundle tests passed. The rebuilt macOS Node addon exports the
  same `readWindowsRuntimeForeground` function and rejects its call off Windows
  with the existing error. This verifies registration and the non-Windows stub,
  not native Windows foreground observation after the split.
- The capability audit now reflects direct View input and the retained read-only
  native boundary. The earlier wording that Windows still retains native input
  submission was obsolete. Current Windows fullscreen/Macro parity remains
  pending CI `34044533718`; this module split requires its own Windows native
  compilation/physical gate after submission.
- Final local validation passed: 448 Vitest files / 3,541 tests with one worker;
  native macOS Rust lint and workspace tests (1,642 passed, 4 ignored); typecheck,
  lint, hygiene, coverage, stable build, production Electron build and desktop
  E2E isolation. No local desktop profile ran for this internal-only module move.
  Windows native compilation and both hardware profiles remain pending.

### Windows direct-View fullscreen pointer boundary follow-up (2026-09-07)

- Candidate `56bbc188`, CI `34044961585`, Windows package job
  `101518279527` reproduced the fullscreen toolbar auto-hide failure. The
  preceding `ad491b29` evidence shows normal content inset 40, fullscreen hidden
  inset 2, and successful native edge reveal back to 40; it does not prove hide.
- The Windows host now consumes Electron's public `before-mouse-event`
  `mouseLeave` event in addition to the existing toolbar DOM pointerleave.
  Native embedded View boundaries need not deliver the latter to the toolbar
  element. The same serialized chrome owner applies auto-hide, retaining pinned
  preferences and exact native-owner/window-generation/topology checks. Closed
  hosts remove the native listener; input is not suppressed or replayed.
- `CHROMIUM-WINDOWS-FULLSCREEN-TOOLBAR-012` now waits for hide directly after
  native pointer motion, before any Role-page click can supply another trigger.
  The retained macOS AppKit path is unchanged. Focused controller, factory and
  journey-source checks passed: 3 files, 62 tests. Windows physical verification
  of this correction remains pending; CP-08/11/12/15/18 are not closed by mocks.
- Local validation for the pointer correction passed: full Vitest 448 files /
  3,543 tests with one worker; macOS Rust lint and workspace tests (1,642 passed,
  4 ignored); TypeScript, ESLint (existing warnings), source hygiene, E2E coverage,
  stable build, production Electron build and production E2E isolation. No local
  desktop E2E profile was run for this Windows-only native event change; both
  exact-candidate desktop profiles, Windows native checks and hardware gates
  remain pending CI/physical execution. Production renderer outputs are restored.


### Exact candidate 3154a542 native acceptance and parent focus ordering

- Local `chromium-macos-appkit-smoke` completed successfully at `3154a542`:
  all 56 configured phases passed. Evidence is in
  `.desktop-e2e-artifacts/2026-09-06T16-30-43-149Z-darwin` and
  `/tmp/rion-3154-macos-smoke.log`. This covers AppKit fullscreen/tab chrome,
  foreground/background Macro input, standby/reload/topology/terminal cleanup,
  system settings/font application, Session isolation/reset/restart and recovery.
  It is not mixed-DPI/hardware or Windows evidence.
- CI `34045623644`, Windows Chromium package job `101520039873` passed 24
  phases, including direct-View physical input, both fullscreen toolbar phases,
  Quick Access, ordinary settings persistence and Macro UI. The native pointer
  event correction is verified. The later `chromium-macro-native-effect` failed:
  fixture focus sequence 327 was followed by blur 328 within 3 ms; Core accepted
  focus `browser-action-2`, then rejected actions 3 and 4 with
  `SYSTEM_TRUSTED_INPUT_DELIVERY_MODE_UNAVAILABLE`. No KeyA receipt arrived.
- Pinned Electron 43.4.1 restores/focuses a BrowserWindow's own WebContents in
  [BrowserWindow::OnWindowFocus](https://github.com/electron/electron/blob/v43.4.1/shell/browser/api/electron_api_browser_window.cc),
  before [BaseWindow's deferred focus event](https://github.com/electron/electron/blob/v43.4.1/shell/browser/api/electron_api_base_window.cc).
  View focus admission now distinguishes that exact parent event from generic
  geometry/state changes. When the parent was not foreground, it waits for that
  event before focusing the Role View; transient View focus cannot complete the
  request first. Already-foreground parents avoid redundant show/focus calls.
  Existing Core deadline, cancellation, hidden-View and ownership checks remain.
- The same CI candidate's stable Windows E2E job `101520039954` failed the
  Game Window move event after sequence 25, while stable macOS E2E job
  `101520039990` returned an indeterminate AppKit tracking-loop fullscreen
  mutation. These remain unresolved gates; earlier green candidates do not
  overwrite these results. System-settings absence/font assertions occur after
  the Windows Macro phase, so CP-02/06/13 remain pending Windows acceptance.
- The physical Windows probe now uses one sandboxed `BrowserWindow` with its own
  isolated host Session and two Role Views, matching the product parent class.
  It no longer uses a root-WebContents-free BaseWindow that cannot exercise this
  focus-restoration boundary. All foreground/hidden trusted-event, modifier,
  coordinate, exact membership and sibling-focus assertions remain required.
- Focus-order correction validation: 4 focused files / 29 tests, then the full
  single-worker Vitest suite (448 files / 3,547 tests); native macOS Rust lint
  and workspace tests (1,642 passed / 4 ignored); TypeScript, ESLint, source
  hygiene, coverage manifest, stable build, production Electron build and E2E
  production isolation all passed. The full macOS desktop run above predates
  this Windows-only focus correction; its Windows physical/product result is
  pending the next candidate. Production outputs are restored.


### Native acceptance at 280027d7 and E2E event-order corrections

- CI `34046674835`: Windows native job `101522937996`, macOS native job
  `101522938005`, Windows Tauri E2E job `101522843120` and macOS Tauri E2E job
  `101522843158` all completed successfully. These are exact-candidate results;
  the earlier Tauri failures remain historical evidence rather than current
  failures. CP-14's native validation gate is satisfied at this source state.
- Windows Chromium job `101522843156` passed the BrowserWindow-backed physical
  input gate and reached Macro native effects. All Core browser actions 2–7
  completed. Fixture evidence records KeyA, all three mouse down/up pairs and
  semantic events; right-down 336 has buttons 2, right-up 337 has buttons 0,
  right auxclick 338 and contextmenu 339 both have buttons 0 and are trusted.
  This verifies the parent-activation focus correction, but the complete Macro
  journey still failed its macOS-only contextmenu buttons expectation.
- The paired Macro E2E now expects Windows contextmenu after right-up with
  buttons 0, and macOS contextmenu before right-up with buttons 2. It retains the
  exact eight trusted key/mouse transitions, semantic target, focus and visible
  Start/Stop assertions. Chromium's
  [mouse-up context-menu branch](https://chromium.googlesource.com/chromium/src/+/d6c4a0cff4b083e7143eb4026351ea8c7450450a/third_party/blink/renderer/core/frame/web_frame_widget_impl.cc)
  documents the platform distinction; the pinned runtime's raw fixture evidence
  above is the Windows acceptance source.
- Separately, the stable native-control E2E helper now returns the cursor captured
  before applying the control. Placement/DPI waiters use that cursor because
  native callbacks may commit before `native-control-submitted` is recorded.
  The `3154a542` Windows artifact already persisted the requested x35/y45,
  width820/height580 bounds despite the waiter timing out after sequence 25.
  Both event orders are covered for both platforms; exact generation, native
  handle, geometry and persistence assertions remain.
- The local stable `full --phase=seed` run at
  `.desktop-e2e-artifacts/2026-09-06T16-53-01-101Z-darwin` passed the initial
  move and repeated close/reopen section, then failed script execution during
  the rapid native maximize transition at line 507. It is not a passing E2E
  result. No product runtime mutation or longer timeout was introduced for it.
- Local checks for these E2E-only corrections passed: focused native-control and
  Macro journey checks (3 files / 8 tests), full single-worker Vitest (449 files /
  3,551 tests), TypeScript, ESLint, source hygiene, coverage manifest, production
  Electron build and E2E production isolation. Rust/product code is unchanged
  from the paired native-green `280027d7`. Revised Windows journey acceptance
  and the local rapid-transition failure remain for the next native run.


### CP-10 actual production helper lifetime and persistence

- A new native integration test bundles the pinned production Electron main
  entry in a private scratch directory and invokes its existing framed helper
  mode. Each apply, verify, rollback and rollback-verify operation runs in a
  separate Electron process; the preceding child must exit cleanly first.
  Verification binds the actual framed response and child exit digest. No
  renderer build output or test-only product bridge is used.
- This exposed a real migration LocalStorage lifetime failure: the codec retained
  WebContents but dropped its owning WebContentsView during asynchronous
  navigation. The actual helper returned LocalStorage readback failure with
  ERR_FAILED for its controlled in-memory origin. The codec now retains the View
  until WebContents closure completes. Session security, data scope and
  authoritative completion boundaries are unchanged.
- macOS native integration passed both plain text and UTF-16 text containing a
  NUL, with one secure HttpOnly cookie and one LocalStorage entry verified across
  fresh processes, then zero entries after rollback. Adjacent migration/helper
  tests passed (3 files / 44 tests). The native test glob already reaches both
  macOS and Windows native CI jobs; Windows execution remains pending.
- E2E omission for this lifecycle correction: `lower-layer-covered`, using the
  actual production helper integration above. This does not establish the
  consented Chrome Profile import UI or Rust journal transaction acceptance,
  and does not replace existing Role Session reset/isolation journeys.

### Windows Chromium acceptance at cbdd80fe

- CI `34048350410`, Windows Chromium job `101527359533`, passed Macro native
  effects after the platform-correct contextmenu assertion. The next background
  tab scenario failed during its initial foreground shortcut, before testing
  hidden hold continuity. Core received `managedShortcutPhase:351`; browser
  action 1 failed with `SYSTEM_TRUSTED_INPUT_DELIVERY_MODE_UNAVAILABLE`. Thus
  the missing Digit2 event is not proof of a hidden-input delivery failure.
- The exact readiness observation at rejection was not included in the artifact.
  Determine which native focus/visibility/ownership predicate failed before
  changing admission or test actions. Keep the current fail-closed input checks
  and full Windows Macro acceptance open.
- Local correction validation passed: full single-worker Vitest (449 files /
  3,551 tests), the two native helper cases, 44 adjacent tests, TypeScript, ESLint
  (existing warnings only), complete hygiene/coverage checks, native macOS Rust
  lint and tests (1,642 passed / 4 ignored), stable and Electron production
  builds, and desktop E2E production isolation. No desktop E2E profile was rerun
  locally for this lower-layer correction. Windows native helper acceptance is
  pending the new candidate.
- At `cbdd80fe`, both stable Tauri desktop CI jobs and macOS native validation
  completed successfully. The Windows native and macOS Chromium package jobs
  were still running when this update was recorded.


### CP-08 exact admission evidence for the pending Windows failure

- The E2E entry now wraps the View attachment resolver's observation function.
  It records the same native sample consumed by admission, including exact View
  identity, parent foreground/visibility, WebContents focus, bounds and zoom.
  It neither rereads native state nor changes the returned sample, input owner,
  exception, delivery mode or product admission rules.
- The bounded artifact `electron-view-input-observations.json` retains the last
  256 samples and is written in a microtask after the synchronous input stack.
  The observer exists only under the E2E entry. Windows acceptance remains open
  until a native candidate supplies the missing rejection-time evidence.
- This is `internal-only` instrumentation for existing
  `CHROMIUM-WINDOWS-MACRO-BACKGROUND-TAB-004` and its retained AppKit counterpart;
  no journey behavior, required assertion or coverage target changes. Focused
  observer/host and actual main-bundle tests passed (3 files / 15 tests), along
  with TypeScript, ESLint, source hygiene and coverage-manifest checks. Product
  runtime, native imports and shared contracts are unchanged from `07ee2675`.
- Local macOS `chromium-macos-appkit-smoke --phase=chromium-macro-background-tab`
  passed (one scenario, 22.9 seconds), with artifacts under
  `.desktop-e2e-artifacts/2026-09-06T17-40-51-986Z-darwin`. This is one targeted
  phase, not a rerun of the full 56-phase profile.
- Production Electron rebuild, E2E production isolation and full hygiene checks
  passed after the targeted native run. Windows observation execution awaits
  the next exact candidate; no native Rust sources changed in this update.


### CP-15/16 completed macOS package acceptance at 280027d7

- CI `34046674835`, macOS Chromium package job `101522843140`, completed
  successfully. Its downloaded report binds commit
  `280027d7248a3af269cfd6dac3b4a310fc00476f` to all 56
  `chromium-macos-appkit-smoke` phases with PASS, exit code 0 and final-flush
  evidence. The report records a dirty worktree because this job applies its
  isolated updater fixture version; this is CI fixture acceptance, not a clean
  production-release receipt.
- The same job passed exact Electron/Chromium/Core/AppKit ABI verification,
  package structure, distribution payload checks, prior-version fixture builds
  and the packaged Rust updater transaction for fixture target version 8.5.0.
  Production trust, published-v22 cutover, Windows installation and physical
  hardware gates remain independent and open.
- Downloaded artifact `packaged-chromium-role-black-box-macOS-34046674835-1`
  (ID `9993943541`) contains a passed black-box receipt: actual host
  `appkit-chromium`, visible OS Accessibility click, remoteDebugging false,
  exitCode 0 and a package manifest covering 601 entries. It binds app.asar
  SHA-256 `4a004846532d32c72e6a00ad9f2958a9b40affc7537ab18850976794da0f9ae8`
  and native addon SHA-256
  `981b274d2ddefd0ce243702819a637f835b6d19aad1ace555144406f8e8bc43f`.
- The downloaded Windows `cbdd80fe` report separately establishes 25 passing
  phases, including `chromium-macro-native-effect`; the following background-tab
  phase failed. CP-15's register now reflects this verified count rather than
  the earlier 24-phase candidate. Neither result closes the full Windows gate.
- This update changes evidence documentation only. It does not restart or replace
  the already-running `b70fd73e` CI (`34049447661`) that will supply the exact
  Windows admission samples.


### CP-11 hidden View experiment: distinguish native and DOM visibility

- A local isolated bundled-Electron macOS experiment changed zoom only after
  `WebContentsView.getVisible()` was false. With backgroundThrottling false,
  document.visibilityState remained visible even after a classified 3-second
  visibility-event boundary. Pinned Electron declarations explicitly state that
  backgroundThrottling affects the Page Visibility API. Therefore a DOM hidden
  event is not an appropriate substitute for native View visibility in this
  probe. The missing DOM event was recorded as indeterminate, never success.
- The same native-hidden View received a resize-event acknowledgement changing
  its renderer viewport from 600x400 to 480x320 at factor 1.25 before reveal.
  Reveal retained the acknowledged size. The native sample and renderer
  acknowledgement were both read; getZoomFactor alone was not the evidence.
- This isolated single-View macOS API experiment is not retained-AppKit product
  acceptance, Windows acceptance, sibling occlusion or a production zoom
  completion fix. CP-11 remains open for those exact cases. The immediate next
  zoom experiment must retain native visibility evidence and use a renderer
  resize receipt, without demanding a DOM visibility transition contradicted
  by the configured Electron behavior.


### CP-08 Windows foreground precondition identified at b70fd73e

- CI `34049447661`, Windows job `101530282243`, produced the missing exact
  admission sample in `electron-view-input-observations.json`. The initial
  background-tab shortcut had parentForeground true, parentVisible true,
  parentMinimized false, viewAttached true and viewVisible true, but
  contentsFocused false and focusedWebContentsId null. Bounds were 904x560 at
  (0,40), zoom 1, and the exact role/generation/View identity was intact.
  Product input admission correctly rejected this non-focused View.
- The shared E2E keyboard helper now receives the exact scenario window ID and
  performs the existing PID/HWND-fenced native content click before a new
  Windows keyboard sequence. ChromeDriver's ability to deliver DOM keys alone
  is not native focus evidence. `focusCanvas: false` continuation sequences
  preserve their existing no-extra-click behavior. The product focus rules,
  background delivery rules, Core deadlines and event assertions are unchanged.
- This targets `CHROMIUM-WINDOWS-MACRO-BACKGROUND-TAB-004` and the shared
  keyboard cutover scenario. Actual Windows acceptance remains pending the
  next candidate; a physical focus precondition must not be used to select a
  hidden target or repair background delivery.
- Separately, CI `34049199222`, macOS native job `101529742726`, passed at
  `07ee2675`. Its raw log explicitly records both new production Session helper
  integration tests passing (10,372 ms), establishing hosted macOS coverage
  beyond the earlier local test. Windows Session helper acceptance remains open.


### CP-10 Windows helper launch parity correction

- Windows native job `101529742770` at `07ee2675` executed both new Session
  integration cases and failed their exact magic check: stdout started with
  CRLF before RCHRES01. No data inventory verification was reached.
- The test's Node child launch omitted the console suppression already used by
  production Rust `rion_platform::background_command` (CREATE_NO_WINDOW). The
  test now sets windowsHide true with all three standard streams piped. Pinned
  [Node 24.18.0 libuv source](https://github.com/nodejs/node/blob/v24.18.0/deps/uv/src/win/process.c#L970-L985)
  applies CREATE_NO_WINDOW for this combination. This aligns the launch
  environment; it does not strip stdout, relax framing, change exit evidence,
  or claim that the Windows rerun has passed.
- Local validation of these test-only corrections passed: 5 focused files / 30
  tests, 2 real Session helper cases, TypeScript, ESLint, full hygiene and
  coverage checks, production Electron build and E2E production isolation.
  Product Rust/native imports and shared runtime contracts are unchanged.
- The first local background run caught an E2E bridge read after switching to a
  Role page; that attempt failed and is not acceptance. PID/HWND lookup was
  moved to the main-page boundary before entering the Role target. Subsequent
  macOS `chromium-macos-appkit-smoke` targeted phases passed:
  `chromium-macro-background-tab` (21.4 seconds, artifact
  `.desktop-e2e-artifacts/2026-09-06T18-00-13-455Z-darwin`) and
  `chromium-macro-cutover-keyboard` (28 seconds, artifact
  `.desktop-e2e-artifacts/2026-09-06T18-00-43-415Z-darwin`). These are two targeted
  phases, not another full-profile run.
- Affected paired journey suffixes are MACRO-BACKGROUND-TAB-004,
  MACRO-SHORTCUT-REENTRY-007, MACRO-MODIFIER-CONTINUITY-008 and ROLE-KEY-BLUR-004.
  The keyboard phase also retains its existing MACRO-MIDDLE-BUTTON-013
  assertions. Manifest behavior/coverage targets are unchanged; Windows native
  confirmation of the corrected test actions and helper launch remains pending.


### CP-11 reproducible hidden/occluded viewport probe

- Added an isolated bundled-Electron probe plus a native integration entry,
  automatically included by both native CI jobs. A single BrowserWindow hosts
  two sandboxed Views with separate Sessions. The target is either explicitly
  hidden or covered by the focused sibling before changing its zoom.
- The probe first measures the actual visible viewport at the requested factor,
  resets to an acknowledged 600x400 viewport, then changes zoom while covered.
  It requires unchanged native focus/visibility/attachment facts, records the
  renderer resize acknowledgement and verifies the revealed viewport against
  that same visible calibration. No platform scale or pixel rounding is guessed.
- The first local experiment exposed an incorrect Math.round expectation at
  factor 1.5 (expected height 267, actual 266), including after reveal. That
  failed attempt is not acceptance. Visible calibration replaces the arithmetic
  assumption without adding tolerances or changing the requested zoom factors.
- Local macOS Electron 43.4.1 / Chromium 150.0.7871.224 evidence: native-hidden
  zoom 1.25 acknowledged 480x320; sibling-occluded zoom 1.5 acknowledged 400x266.
  Both retained the focused sibling throughout the covered operation and matched
  their visible calibration before reveal. DOM visibility remained visible with
  backgroundThrottling false; native target visibility was recorded separately.
- Complete JSON is written directly to the native test log, including passing
  runs. A covered response may be explicitly indeterminate in this diagnostic
  probe; green test execution does not certify covered zoom parity. Acceptance
  requires inspecting each actual `whileCovered.status` and exact dimensions.
  Revealed mismatch, invalid native ownership/focus or failed visible calibration
  still fails the probe. No deadline expiry can become an applied response.
- This is `internal-only` evidence preparation for CP-11, not a product zoom
  completion change or retained-AppKit/hardware acceptance. Windows evidence
  remains pending. Local native probe, TypeScript, ESLint and complete hygiene
  checks passed; no product runtime, native Rust or shared contracts changed.


### CP-11 product-default throttling and immediate readback comparison

- Source audit distinguishes ordinary Role Views (Electron's default
  backgroundThrottling true) from Session-maintenance Views (explicit false).
  The viewport probe now runs both configurations; the earlier false-only
  experiment cannot establish ordinary product behavior. Host and both sibling
  Views use the same explicit configuration within each isolated run.
- Each covered zoom now records a single ordered renderer response immediately
  after setZoomFactor, before waiting for the resize event or its deadline.
  There is no polling or retry. The later resize-event result is still recorded
  independently and cannot rewrite an indeterminate result as success.
- macOS at both settings returned matching immediate dimensions for native-hidden
  1.25 (480x320) and sibling-occluded 1.5 (400x266). With throttling true, the
  native-hidden case did not deliver the resize notification within its external
  boundary despite the immediate readback already matching. All other resize
  cases acknowledged. Focus stayed on the visible sibling throughout.
- Therefore the prior resize-only acceptance criterion is insufficient to
  distinguish stale layout from suppressed notification. Future product receipt
  design must bind the exact renderer response and operation/frame identity;
  browser getZoomFactor or a timeout alone remains insufficient. The probe
  runner can pass with an indeterminate resize event, and its JSON must still
  be inspected for exact immediate dimensions, native state and visible
  calibration. These API observations do not close product or Windows parity.


### CP-08 ordinary background selection and current candidate failures

- Windows run 34050457198 at 33dde3dd passed the initial foreground Macro
  shortcut after the physical focus correction. Its next failure was held
  Digit2 continuity after selecting sibling tab B. Both tab identities remained
  in the strip and the selected tab was B; this was not an explicit hide-tab
  operation. Core incorrectly required membership in hidden_tab_ids, which
  describes hidden tab chrome rather than an unselected Chromium View.
- Remove that extra condition while preserving the exact owner, generation,
  capability, membership and selected-sibling checks. A focused regression
  failed before the correction (superseded instead of noHeldKeys) and passed
  afterward. The selected-tab negative case and existing explicit-hide/stale
  owner test also pass. CHROMIUM-WINDOWS-MACRO-BACKGROUND-TAB-004 now checks
  both tab identities survive selection. Windows native acceptance is pending.
- Local macOS lint:rust and test:rust passed after the continuity correction:
  1,643 tests passed and four ignored across the workspace. TypeScript, lint
  (existing warnings only), hygiene/coverage, both builds and production E2E
  isolation passed. No new full desktop profile ran on this worktree.
- The full Vitest run recorded 448 passing files and two failures (3,553 passing
  tests, two failing). The new viewport probe lacked its exact product-gate
  allowlist entry; that entry is now added and all eight focused gate tests
  pass. The real updater-journal deletion test missed its filesystem event
  after initial presence readback. That failure remains open; no deadline
  extension, polling or successful rerun is accepted as a repair.
- Newer CI invalidates any current-candidate all-green claim: 33dde3dd macOS
  Chromium failed saved mixed Workspace restore during restart, and Windows
  Session helper tests still received CRLF before the exact response magic.
  The earlier 280027d7 56-phase success remains historical evidence only.

### CP-10 isolate the helper protocol from Electron console routing

- CREATE_NO_WINDOW/windowsHide did not repair the Windows native helper
  response in run 34050457198. Electron 43.4.1 calls RouteStdioToConsole before
  application entry unless ELECTRON_NO_ATTACH_CONSOLE is set (or RunAsNode is
  active): [pinned Electron startup source](https://github.com/electron/electron/blob/v43.4.1/shell/app/electron_main_win.cc#L153-L163).
- Set ELECTRON_NO_ATTACH_CONSOLE=1 on the dedicated Rust helper command and
  matching fresh-process native test. Do not strip leading bytes or weaken
  exact magic, length, process-exit or response-digest validation. The setting
  is scoped to the helper, not ordinary application launches. Windows native
  proof remains required; this source-based correction is not acceptance.
- The subsequent local validation attempt hit ENOSPC while compiling Rust and
  before native tests loaded. Those attempts are infrastructure failures, not
  passing tests. Rebuildable compiler cache cleanup and revalidation follow.

- Removed only rebuildable target/debug/incremental cache after active compilation
  ended, recovering approximately 39 GiB free space. Source and E2E evidence
  were preserved. The corrected native command then passed both Session cases
  and both viewport configurations (four tests). The default-throttling hidden
  resize event remained indeterminate despite matching immediate dimensions;
  this does not close CP-11. Typecheck, lint, hygiene/coverage, builds and
  production E2E isolation passed after the helper launch change.
- A separate bounded 20-attempt journal-watch reproduction observed every
  deletion. It neither identifies the original failure nor closes it. The full
  suite's earlier filesystem observation failure remains pending diagnosis.
- After cache recovery, required macOS lint:rust and test:rust also completed
  successfully (1,643 passed, four ignored). Windows native execution and both
  current-candidate full Chromium desktop profiles remain CI gates. No physical
  mixed-DPI or Windows hardware profile ran locally.


### CP-04/CP-11 Workspace chrome navigation rejection terminality

- Investigated run 34050457198 macOS Workspace restart artifacts. The Role
  WebContents completed its navigation, while the paired Rion-owned Web chrome
  stayed in its opening state until teardown rejected its unresolved load.
  Core remained launching and the hidden host never became visible. This
  narrows the stalled boundary but does not prove the original navigation error.
- Source inspection found loadURL rejection was swallowed while waiting only
  for did-finish-load/did-fail-load. A rejected exact navigation request can
  therefore leave the paired create pending when no separate failure event is
  delivered. Route that rejection through the existing load-settlement fence
  and cleanup; preserve its original error and ignore later duplicate outcomes.
  No successful receipt, timeout, retry or alternate engine is introduced.
- New explicit darwin/win32 regression cases fail before the correction and
  pass afterward, verifying both paired surfaces are retired and the creation
  rejects with the original error. The Windows fixture uses its native path
  form. All eight adjacent presentation tests pass. This lower-layer-covered
  fix does not itself establish the CI failure's root cause or native parity.
- Related journeys are CHROMIUM-MACOS-APPKIT-WORKSPACE-WEB-SLOT-016 and
  CHROMIUM-WINDOWS-WORKSPACE-WEB-SLOT-016. No journey or coverage target is
  removed; focused desktop results are recorded separately below.
- Local macOS focused chromium-macos-appkit-smoke execution passed all four
  selected/dependency phases: entity persistence seed/restart and Workspace Web
  slot seed/restart. Artifact 2026-09-06T18-35-13-399Z-darwin records b8a3d3c9
  plus this dirty worktree, clean native final flushes, paired Session isolation,
  retained 0.55 divider width and restart readback. The earlier hosted stall was
  not reproduced; this run is compatibility evidence, not proof of its root
  cause. Windows and full-profile verification remain pending CI.
- Validation after this change: complete single-worker Vitest passed 450 files
  and 3,557 tests (153.53 seconds); TypeScript, ESLint, hygiene, docs and coverage
  passed. Both production builds and E2E production isolation passed after the
  focused native run. The earlier journal-watch failure did not recur in this
  suite, but no watcher repair has been made and that issue remains open.


### CP-15 Windows native chooser discovery without desktop UIA traversal

- Run 34051980128 at b8a3d3c9 passed Windows Workspace slot persistence but
  failed chromium-workspace-web-fullscreen-seed during visible file upload.
  The native chooser helper was killed at its existing external deadline;
  its durable progress receipt stopped at reading-root, before application
  window enumeration. No chooser absence or product upload failure can be
  inferred from that stalled UI Automation root call.
- Replace UIA RootElement/FindAll desktop enumeration with bounded native
  EnumWindows discovery. Admit only the exact application PID or a window
  whose native owner belongs to that PID. Dialog candidates must be visible
  #32770 HWNDs with exactly one native 1148/Edit and 1/Button descendant before
  asking UIA for the admitted dialog and its two actionable controls.
- Native window enumeration failure or exceeding 4,096 HWNDs throws; neither
  can become an empty-dialog success. Discovery remains the existing bounded
  external test-driver loop. Keep the original 15-second process deadline,
  unique-dialog rule, foreground and visible-control checks, exact filename
  write/readback and remote trusted-file/byte/hash evidence. No product file
  upload bridge or hidden synthetic primary action is introduced.
- Snapshot discovery also uses native ownership so collecting routine evidence
  cannot reintroduce the desktop-root traversal. Removed obsolete UIA root
  conditions and unused owner helpers. This is internal-only E2E driver work;
  Windows native execution remains pending. Adjacent source-boundary and
  PowerShell transport checks are not native dialog acceptance.
- Affected journey: CHROMIUM-WINDOWS-WORKSPACE-WEB-FILE-UPLOAD-028, exercised
  inside CHROMIUM-WINDOWS-WORKSPACE-WEB-FULLSCREEN-017. Both macOS and Windows
  CI profiles remain required; no coverage target or journey is removed.
- Local validation: 11 focused source-boundary/PowerShell transport tests,
  TypeScript, ESLint (zero errors), full hygiene, documentation and coverage
  checks pass. macOS E2E was not rerun for this Windows-only test-driver change;
  the prior 266f4abc four-phase macOS run remains separate evidence. No native
  Rust, shared runtime contract or product module changed in this batch.


### CP-15 stable Windows persistence receipt observation

- Run 34051980128 Windows stable Tauri E2E failed force-terminate while waiting
  for alpha's window-state-persisted event. Transcript sequence 214 completed
  alpha activation; 194/222 reported essentialReady/ready. SQLite preserved
  activeTabId 141becfd-f19a-4331-96ed-ac7bb0d44741 (alpha), updated at
  18:44:43.955989900Z, while no matching persisted event appeared. This is
  evidence of saved state without the required observer receipt, not lost data.
- The observer was attached to pending-lane retirement. When a newer queued
  snapshot replaces that lane during the Core commit, the exact older applied
  receipt could not emit because its lane was no longer current. Record the
  event from the submitted snapshot identity and matching Core applied receipt
  instead. Retire only an exactly matching pending lane; a newer request remains
  queued. Superseded receipts do not become applied events.
- Preserve the submitted active tab, window generation and revision in the
  observation. Do not infer persistence from activation, page readiness or a
  later SQLite query, and do not widen the test timeout. Event emission remains
  desktop-e2e-only; persistence authority and actual writes stay in Core.
- Local source-boundary tests pass (23). Required macOS Rust validation and
  native stable recovery execution are running; Windows acceptance remains
  pending. This internal-only observation repair does not close Chromium
  cross-platform parity or the cutover gate.
- macOS lint:rust and test:rust completed successfully (1,643 passed, four
  ignored); the desktop-e2e feature build also compiled successfully. Focused
  full-profile crash-restart execution failed in its seed dependency at the
  maximized-presentation control command, before force-terminate. Artifact
  2026-09-06T18-53-23-677Z-darwin is failed evidence, not recovery acceptance.

### CP-10/CP-11 native Windows evidence at b8a3d3c9

- Native job 101537220504 completed with four failures. Both Session cases
  still received CRLF before RCHRES01 despite windowsHide and
  ELECTRON_NO_ATTACH_CONSOLE. Console routing alone is therefore not a proven
  cause or repair. Keep strict response framing and fresh-process acceptance
  open; no preamble stripping or successful helper outcome is inferred.
- Both viewport configurations recorded hostVisible false while hostFocused
  and siblingFocused were true. These cannot establish visible-host parity.
  Remove windowsHide from the visible viewport probe launcher, matching the
  already-passing direct-input probe's native launch precondition. Retain exact
  host visibility/focus assertions. Local macOS two-configuration execution
  passed afterward; Windows execution remains required. The default-throttling
  hidden resize notification is still indeterminate despite exact dimensions.
- Windows job 101538819689 at e52dd066 progressed past desktop-root discovery
  and compiled the native dialog helper, but UIA FromHandle failed with
  ElementNotAvailableException on an exact native control. This identifies the
  next driver boundary; it is not file-upload acceptance. Native HWND control
  observation remains to be evaluated without relaxing visible primary actions.
- Final local checks for this batch: both production builds, Electron renderer
  verification, E2E production isolation, full hygiene/coverage and targeted
  ESLint passed. The failed macOS recovery run is retained. This batch does not
  claim either current-candidate full desktop profile is green.


### CP-15 use admitted native file-control handles directly

- Follow up the exact-control FromHandle failure from Windows run 34052620782
  at e52dd066. Remove UI Automation from the Windows chooser helper entirely;
  retain bounded EnumWindows/EnumChildWindows discovery and exact PID/owner,
  dialog class and native control ID/class admission. The helper no longer
  needs an accessibility-provider object for already-proven HWND controls.
- Before each real mouse down/up, recheck dialog ownership, child membership,
  visible/enabled state, foreground and nonempty native bounds. Use the center
  only when WindowFromPoint identifies that exact control or its child; an
  occluding window is a failure. Preserve filename write/readback, native
  dialog-close observation and the remote trusted file event/byte/hash checks.
  No DOM file injection, synthetic Open-button message or timeout change is
  introduced. Failure snapshots use native handles/ownership only.
- API references: [GetWindowRect](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getwindowrect)
  supplies screen bounds and is DPI-virtualized;
  [WindowFromPoint](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-windowfrompoint)
  resolves the hit window and excludes hidden/disabled windows. This source
  audit is not physical mixed-DPI acceptance; Windows native CI remains pending.
- Internal-only driver change affects
  CHROMIUM-WINDOWS-WORKSPACE-WEB-FILE-UPLOAD-028 within the existing fullscreen
  journey. The manifest and coverage targets remain unchanged. Local 11 focused
  source/transport tests, TypeScript, ESLint and full hygiene checks pass;
  these checks do not compile or execute the Windows P/Invoke helper on macOS.

### CP-10 bounded diagnostics without accepting a displaced response

- Add a bounded assertion diagnostic to the existing synthetic native Session
  fixtures: response length, header offset, initial header bytes, outcome byte,
  up to 1,024 metadata bytes and bounded stderr. A displaced header is inspected
  only to explain failure; strict offset-zero magic and exact lengths remain
  mandatory, and no secret-bearing real browser profile is used by this fixture.
- Local macOS both fresh-process Session cases pass after the diagnostic change.
  Windows still needs execution to reveal the actual response after its leading
  CRLF. No successful apply/verify/rollback is inferred from finding a header.


### CP-15 AppKit animation reentry outside the Tao callback lock

- Investigated failed local stable recovery artifact
  2026-09-06T18-53-23-677Z-darwin instead of retrying its timeout. The captured
  native sample shows rion_desktop_e2e_control_window calling NSWindow zoom
  inside Tao handle_user_events. AppKit's animated resize enters a nested run
  loop; a display-link redraw then reaches Tao handle_nonuser_event and blocks
  on the same callback mutex on the main thread. Persistence had already emitted
  its exact receipt (sequence 83); this seed failure is a separate native
  reentrancy deadlock, before the recovery activation checks.
- Dispatch the macOS E2E native window control through the existing dispatch2
  main queue rather than Window::run_on_main_thread's Tao user-event handler.
  Preserve the same native AppKit entry point, arguments, completion channel
  and external deadline. Normal correctness still requires its actual response;
  no animation disabling, timer-driven success or synthetic geometry is added.
- Windows control dispatch and product runtime modules remain unchanged.
  This internal-only driver repair is covered by the stable native recovery
  journey; local Rust and recovery verification are recorded below when terminal.
- macOS lint:rust and complete test:rust passed (1,643 passed, four ignored),
  with 23 adjacent source-boundary tests and full hygiene passing. The native
  desktop-e2e feature build succeeded. Focused stable full-profile execution
  then completed seed/restart as PASS and force-terminate/crash-restart as
  EXPECTED_FORCE_TERMINATION, each with exit code zero. Artifact
  2026-09-06T19-09-24-521Z-darwin binds 17431e59 plus this dirty worktree.
  This reproduces the previously failing path after the dispatch correction;
  no timeout was enlarged and no native animation was disabled.
- The focused report verifies GAME-WINDOWS-TABS-001. It does not certify the
  entire full profile or the later crash-discard/final-restart recovery phases.
  Windows and Chromium full-candidate gates remain separate CI requirements.
- Production Tauri and Electron builds and desktop E2E production isolation
  passed after restoring production assets. Documentation, coverage manifest
  and diff checks also passed.
- CI run 34053406711 at 8387a3c9 subsequently completed both macOS and Windows
  stable desktop E2E jobs successfully (101540928663 and 101540928675). This
  supplies paired stable-shell recovery evidence for the persistence receipt
  correction; it does not certify the pending Chromium jobs or this later
  AppKit driver change.

### Windows persistence acceptance and remaining input failure

- Windows Chromium job 101541710883, run 34053711912 at 17431e59, completed
  25 phases as PASS before chromium-macro-background-tab failed. Evidence:
  artifact 9995489407, report 2026-09-06T19-05-58-231Z-win32/report.json.
  Settings seed/restart and CHROMIUM-WINDOWS-SETTINGS-PERSIST-006 passed.
  This validates general preferences only: the separate system-settings phase
  owns retired-control absence and font selection, and was not reached.
  CP-02, CP-06 and CP-13 therefore retain Windows Chromium acceptance pending.
  Previous macOS and native font evidence remains version-qualified; this
  does not close same-candidate full parity.
- The same report verifies native file upload
  CHROMIUM-WINDOWS-WORKSPACE-WEB-FILE-UPLOAD-028, workspace web fullscreen,
  security policy, paired Role/workspace persistence, workspace recovery,
  game-window UI and the foreground Macro effect. The HWND chooser repair
  therefore has native Windows acceptance, beyond its earlier source tests.
- Background continuity now reaches the second hidden start and final stop.
  Fixture sequences 433/434 record trusted hidden Digit2 keydown/consumer
  keydown. After restoring the Role, a pointer-down at sequence 442 precedes
  an untrusted Digit2 keyup/consumer keyup at 443/444. The stop chord follows
  at 450-453, and trusted Digit2 release arrives at 454/455. The strict
  assertion fails on 443 in stopFromShortcut, spec line 425. Do not filter
  away this earlier release or certify uninterrupted ownership from the later
  trusted event. Investigate overlay physical-key classification and focus
  cleanup before changing the test or input behavior.
- Source follow-up: normal Macro dispatch computes suppressOverlayShortcut
  from shortcut collisions, while held-key continuity sets it true. The
  Windows adapter arms the page Macro guard only when that flag is true;
  unguarded trusted keys enter the overlay's physical-key bookkeeping, whose
  blur cleanup can dispatch synthetic keyup. This is a concrete candidate
  mechanism, not yet a proven repair; retain focused reproduction and native
  acceptance requirements.
- Windows native job 101541034613 at 8387a3c9 now passes both viewport probe
  configurations after removing windowsHide from the visible probe. Its two
  remaining native failures are Session response framing (leading CRLF).
  Probe success does not close hidden resize notification or hardware parity.

### CP-08 classify ordinary Windows Macro keys before native delivery

- Reproduced the missing page guard for both hold and release when
  suppressOverlayShortcut is false: two new adapter tests failed with null
  guard envelopes before the repair. The existing page guard identifies Macro
  ownership as well as preventing shortcut recursion. Without it, a normal
  non-colliding Macro key enters physical-key bookkeeping and in-page focus
  cleanup can synthesize a release before the Core-owned stop.
- Arm the same exact code/phase page guard for every key in the Windows Macro
  input lane. Retain private frame/sequence identity, armed acknowledgement,
  native submission and trusted DOM receipt ordering. Core scheduling and the
  physical user-input path remain authoritative and unchanged. Mouse requests
  still do not arm a keyboard guard; macOS retains its native adapter.
- Both new adapter tests pass after the repair. Added an executable overlay
  focus-transfer test proving a guarded ordinary Digit2 receives no early
  release, then exactly its explicit release. The adjacent three-file suite
  passes 61 tests. These portable tests do not replace Windows native evidence.
- CHROMIUM-WINDOWS-MACRO-BACKGROUND-TAB-004 now explicitly requires the held
  state after returning to the Role; the stop helper retains its strict first
  release isTrusted assertion, including focus cleanup during the stop click.
  The paired AppKit journey shares the strengthened pre-stop assertion. No
  synthetic event is skipped and no native-input requirement is weakened.

### CP-10 diagnose and correct the Windows native Session fixture

- Job 101541835757 at 17431e59 reports offset 2, outcome 1 and stableErrorCode
  CHROMIUM_SESSION_MIGRATION_SOURCE_EVIDENCE_INVALID for both synthetic cases.
  Thus finding the response header did not mean migration had run successfully.
- The Windows test envelope omitted mandatory sourceEvidence. Supply the same
  synthetic webview2StorageGetCookies runtime/protocol/partition capability
  evidence used by the canonical Windows codec fixtures. Keep it absent on
  macOS, where the codec correctly rejects Windows evidence.
- Strict offset-zero magic, lengths, successful outcome and independent process
  readback/rollback remain required. Leading CRLF is still an open transport
  failure; correcting fixture admission does not claim to remove it. Both
  macOS native Session cases pass with this fixture correction.
- Final local validation for this batch: all 450 Vitest files / 3,560 tests
  passed; macOS lint:rust and test:rust passed (1,643 passed, four ignored).
  TypeScript, ESLint, complete hygiene, coverage, both production builds,
  Electron renderer validation and production E2E isolation passed.
- No new local desktop E2E profile ran for this Windows adapter repair. The
  strengthened paired background-tab profile and Windows Session fixture must
  execute in the new exact-commit CI. Existing AppKit full-profile evidence is
  historical, not evidence for this modified assertion. The macOS adapter also
  uses the collision flag for page guards; audit its ownership behavior and
  shared guard construction next rather than assuming native equivalence from
  the Windows repair.

### CP-08/CP-09 share exact Macro keyboard arming on both native adapters

- The macOS adapter had the same collision-only guard condition as Windows.
  Two new hold/release tests with suppressOverlayShortcut false reproduced
  null page guards there as well. Correct both platforms through the shared
  createTrustedInputArmEnvelope function: exact role/generation/frame/sequence,
  expected events and Macro keyboard ownership now have one construction site.
  Each adapter retains native admission, submission, deadlines and independent
  receipt checks; AppKit presentation and trusted native input remain intact.
- The adjacent macOS/Windows adapter and overlay focus suites pass 85 tests.
  Both new macOS cases failed before the change and pass afterward. Existing
  click cases still require no keyboard guard, and untrusted/stale/cancelled
  inputs retain their original terminal checks.
- Local macOS profile chromium-macos-appkit-smoke, focused phase
  chromium-macro-background-tab, passed with native AppKit evidence and clean
  exit in artifact 2026-09-06T19-30-38-199Z-darwin. The report binds 33da5f3e
  plus this dirty worktree and verifies
  CHROMIUM-MACOS-APPKIT-MACRO-BACKGROUND-TAB-004 only. Hidden start, return to
  the Role, retained consumer hold, trusted stop and neutral cleanup all passed.
  It does not certify the entire smoke profile or Windows execution.
- Update the paired journey descriptions to retain ordinary Macro ownership
  across in-page focus cleanup. Source consolidation alone is not native parity;
  the new exact-commit Windows run and full candidate gates remain required.

### CP-10 identify the pinned Electron Windows stdout preamble

- Upstream issue [28072](https://github.com/electron/electron/issues/28072#issuecomment-797141819)
  identifies deliberate browser startup output. Inspection of the downloaded
  pinned Electron 43.4.1 source confirms shell/app/electron_main_delegate.cc
  lines 180-186: under IS_WIN, IsBrowserProcess writes std::wcout << std::endl
  before the application entry. This explains the exact CRLF at offset zero
  independently of the helper's error response and NO_ATTACH_CONSOLE.
- This is distinct from Console attachment in electron_main_win.cc. It cannot
  be prevented by changing helper JavaScript after startup. Source reference:
  [pinned main delegate](https://github.com/electron/electron/blob/v43.4.1/shell/app/electron_main_delegate.cc#L180-L186).
- Next transport work must explicitly account for the fixed runtime envelope
  or use a separate inherited response channel. Do not scan for magic, trim
  arbitrary whitespace, accept optional/duplicate prefixes or omit any bytes
  from the existing PID/clean-exit/response digest. If adopting the pinned
  Windows envelope, require exactly one CRLF followed immediately by the full
  canonical RCHRES01 frame, retain raw-wire hashing and bounded EOF, and reject
  it on macOS. Add paired malformed/truncated/trailing-prefix cases and actual
  Windows fresh-process storage/rollback acceptance. This is new evidence for
  a precise transport revision, not acceptance of the currently failing wire.

- Final local checks for shared keyboard arming: macOS Rust lint/tests pass
  (1,643 passed, four ignored), both production builds and E2E isolation pass,
  and TypeScript, ESLint, full hygiene and coverage checks pass. Full Vitest
  reports 449 passing files / one failing file, 3,561 passing tests / one
  failing test. The failure is the existing CP-16 real journal watcher case:
  watch returned, access saw the file, unlink completed at 1 ms, and no event
  followed before its five-second external deadline. Log:
  /tmp/rion-shared-key-full-vitest.log. Do not certify a green full suite or
  rerun this failure into acceptance. Focused keyboard/native evidence above
  remains separate from the still-open updater acknowledgement repair.

### CP-10 validate the exact pinned Windows helper transport envelope

- Added the Windows CRLF-plus-canonical-frame case first and observed its
  protocol failure before changing the launcher. The native launcher now selects
  explicit Canonical or ElectronWindows framing from the compiled target.
  ElectronWindows requires exactly one CRLF before RCHRES01; Canonical does not
  permit it. No optional prefix, whitespace trimming or magic scan is used.
- Bounded stdout retention includes the two runtime bytes. The existing clean
  exit digest is still computed over the complete raw response before parsing;
  the frame is borrowed after exact prefix validation and the entire owned
  response is zeroed on success or failure. Cancellation, EOF, length/outcome
  validation and same-child reap semantics remain intact.
- Tests reject absent, partial, duplicated, foreign and trailing preambles;
  every truncated response length fails. Failed/indeterminate helper outcomes
  remain non-success, and macOS rejects the Windows envelope. Eight adjacent
  Rust launcher tests pass, with one existing ignored test. The original
  unprefixed protocol tests continue to pass under Canonical framing.
- Update the native Session fixture to validate the same mandatory envelope
  before exact frame parsing. Exit evidence continues to hash all stdout bytes.
  Both macOS native Session cases pass. Windows fresh-process apply, verify,
  rollback and rollback verification remain required in exact-commit CI.
- This lower-layer-covered transport repair changes no public user journey.
  Native Session and launcher protocol/cancellation tests provide focused
  coverage; the runtime migration contract now documents the pinned envelope.

### CP-08/CP-15 Windows background Macro acceptance at 33da5f3e

- CI job 101545320036 / run 34055031958 completed 26 phases as PASS,
  including CHROMIUM-WINDOWS-MACRO-BACKGROUND-TAB-004, before failing the
  first controlled Role reload. Artifact report
  2026-09-06T19-30-55-975Z-win32/report.json records this exact result. This
  closes the previously failing premature-release path for the Windows fix;
  it does not certify the later shared-arm commit or the whole profile.
- Controlled reload evidence contains one exact Windows reload menu capture,
  Core browserRuntimeTabReload start at sequence 189 and commit effect start
  at 194. The Role navigated, reached dom-ready/did-finish-load/did-stop-loading,
  but the input-ready reload observation is absent before the 45-second test
  failure. Commit completion occurs during cleanup after that failure. Preserve
  this as an unresolved lifecycle receipt boundary, not a native menu failure
  or proof that page loading itself failed.
- Final local validation: macOS lint:rust and test:rust pass (1,645 passed,
  four ignored), both production builds and E2E production isolation pass.
  TypeScript, ESLint, complete hygiene, documentation and coverage pass.
  Eight focused JavaScript helper/codec/transport suites pass 87 tests.
  No desktop E2E profile was rerun for this lower-layer transport change;
  macOS native Session execution passed and Windows is pending CI. The prior
  full Vitest updater journal watcher failure remains open and is not erased
  by these focused checks.


### CP-16 exact journal file events and CP-11 failure evidence (2026-09-07)

- Reproduced the updater acknowledgement gap with a silent parent-directory
  stream and an exact file deletion event. The previous directory-only watcher
  failed that focused test. Subscribe to both the parent and journal file before
  initial readback, and rebind the file watcher on an authoritative change event
  so atomic replacement does not leave observation attached to the old inode.
- Completion still requires exact-path absence (access or file-watch ENOENT).
  No polling, retry-to-green, deadline extension, or elapsed-time success was
  introduced. Current stream errors/closure fail; retirement of a replaced
  watcher is ignored by exact watcher identity. Both subscriptions close on
  terminal completion.
- Focused tests cover directory silence, replacement, current stream failure,
  and real filesystem atomic replacement followed by deletion. The real test
  waits for native-event-driven rebinding before deleting the replacement.
  Adjacent journal/helper probes pass 18 tests. The complete macOS Vitest run
  passes 450 files and 3,567 tests in 158.13 seconds, including the previously
  failing real deletion test. This is local evidence, not Windows acceptance.
- TypeScript and complete hygiene pass; ESLint reports zero errors and 23
  warnings. Coverage validation retains P0 70/70 and P1 70/70; these manifest
  counts are coverage declarations, not executed native journey counts.
- Add a failure-only DOM snapshot to the first controlled Role reload wait:
  ready state, visibility, active element and canvas membership. Preserve the
  original failure cause and deadline. WebDriver target selection can affect
  focus, so focus is explicitly labelled after-target-selection evidence.
  This internal-only E2E diagnostic sends no input and does not fix or certify
  CHROMIUM-WINDOWS-CONTROLLED-ROLE-RELOAD behavior. No desktop profile was rerun
  for this diagnostic batch; the next exact-candidate CI must provide it.
- At 526264da, CI run 34055737399 has passing checks, renderer and Linux jobs;
  Windows Chromium package validation failed, Windows native validation remains
  in progress and macOS jobs remain queued at observation time. CP-10,
  CP-11/15, CP-16 and cutover gates remain open.


### CP-11/CP-15 macOS controlled Reload at 968b8828

- Clean-worktree candidate 968b88283f08d652d53df9650a2d5de06e569169
  passes the independent chromium-controlled-role-reload phase under
  chromium-macos-appkit-smoke. Report
  .desktop-e2e-artifacts/2026-09-06T19-58-10-559Z-darwin/report.json
  records exit 0 and PASS for CHROMIUM-MACOS-APPKIT-RUNTIME-TAB-RELOAD-031
  and CHROMIUM-MACOS-APPKIT-RUNTIME-TAB-AUDIO-032. The visible AppKit
  menu scenario reloads twice, injects one classified failure, and recovers.
  Other profile journeys are explicitly NOT_RUN, not implied passing.
- Production Electron rebuild and desktop E2E production isolation pass after
  the native run. No product source was changed for this evidence increment.
- Exact candidate CI 34056466345 remains active; Windows package job
  101549172329 was observed in progress. The earlier Windows reload failure
  remains unresolved until new native evidence identifies and verifies a repair.


### CP-08 remaining deletion dependency audit at 01ca1f3b

- The old child-HWND path is not yet removed: rion-node/lib.rs still registers
  windows_chromium_input_attachment and windows_chromium_input_probe. Their
  attachWindowsChromiumInputHwnd, probeWindowsChromiumInputHwnd and
  windowsChromiumInputProbeAbiVersion exports remain addon capabilities even
  though current product/E2E composition does not load the old coordinator.
- Final removal must cover windowsChromiumInputSurfaceAttachmentCoordinator.ts,
  chromiumOwnedInputSubmission.ts, the two native modules and their lib.rs
  registrations, LegacyWindows* receipt/identity branches in
  windowsChromiumTrustedInputContract.ts, and the legacy validation paths in
  windowsChromiumTrustedInputAdapter.ts. Preserve the View branches and shared
  key/mouse delivery code. Remove implementation-only tests while retaining
  production-bundle rejection tests and real View/native journey coverage.
- The rion-node windows-sys dependency currently has one source consumer:
  the legacy attachment's raw SetParent call. Re-audit the complete crate at
  deletion time, then remove that direct dependency if still unused; do not
  remove the separate windows crate or retained foreground/shortcut adapters.
- This is a concrete remaining cleanup set, not deletion acceptance. The full
  replacement parity gate still applies: controlled Windows Reload has an
  unresolved native failure and later input/topology journeys have not run.
- Local full chromium-macos-appkit-smoke execution started against clean
  01ca1f3b; it is still active and cannot yet support a full-profile PASS.


### CP-15 stable full-profile regression and CP-10 native step evidence

- CI 34054386373 job 101543464095 is SUCCESS. Its downloaded macOS report
  2026-09-06T19-28-30-385Z-darwin/report.json binds ca042c190f9208977fa401e493ab4ffcbe9c7674
  and profile full: 29 PASS phases and three EXPECTED_FORCE_TERMINATION phases
  (p1-cross-domain-topology-force, force-terminate, crash-restart). This supplies
  full stable-shell evidence after the AppKit control dispatch deadlock repair.
- CI 34055443364 job 101546394151 is SUCCESS. Windows report
  2026-09-06T19-38-28-719Z-win32/report.json binds 59b405b709a6a0c0d9b80fac52a9e8626326ff62
  and profile full with the same 29 PASS and three expected termination phases.
  These version-qualified stable Tauri results do not close Chromium parity.
- At 526264da, Windows native job 101547293573 now reports SUCCESS for both
  Test target-platform Rust workspace and Lint and test native Electron startup
  and compatibility probes. The job itself is still running renderer tests;
  retain native step success as evidence and inspect its final logs for exact
  Session apply/verify/rollback coverage before claiming the CP-10 deliverable.


### CP-10 Windows helper acceptance and CP-11 exact challenge correction

- Windows native CI job 101547293573 at 526264da is SUCCESS. Its native
  integration run passes eight files and 15 tests, including both
  electron-session-maintenance.native-integration.ts cases. Each case executes
  independent apply, verify, rollback and rollbackVerify helpers, checks cookie
  and LocalStorage counts, distinct verifier identity and raw parent exit digest.
  Both plain text and the CJK/NUL fixture pass. This accepts the mandatory pinned
  Windows stdout envelope for these fresh-process maintenance transactions;
  consented Chrome import and complete migration/release acceptance remain open.
- Windows package job 101549172329 at 968b8828 again fails first controlled
  Reload. Its failure-only snapshot reports complete/visible document, active
  connected game-input-canvas with tabIndex 0, and focus false after target
  selection. Thus missing active canvas alone is not a sufficient explanation.
- A focused regression reproduces window blur setting the advisory input cache
  to document while the canvas remains active. The exact native refresh formerly
  returned that cached target. Two platform-labelled canvas cases fail before
  the correction. Exact refresh now calls the existing DOM context observation
  before producing its receipt, with the existing revision/report propagation.
  Ordinary refresh/blur cleanup is unchanged; text-input cases still return
  document. Six adjacent suites pass 112 tests after correction. Native Windows
  repair acceptance remains pending; this mechanism is not yet a proven complete
  explanation of the remote failure.
- TypeScript, ESLint (zero errors, 23 warnings), hygiene, production Electron
  build and production E2E isolation pass. Full regression is running and not
  yet accepted. No timeout or readiness condition was relaxed.

### CP-15 full macOS profile at 01ca1f3b

- Local report .desktop-e2e-artifacts/2026-09-06T20-00-08-947Z-darwin/report.json
  binds clean 01ca1f3b5107191d802fc3b28708eebdf5ff7c40 and
  chromium-macos-appkit-smoke: 52 PASS phases and four
  EXPECTED_FORCE_TERMINATION phases; command exit is zero. This is the complete
  selected 56-phase profile, including controlled Reload, background Macro,
  system settings and native tab parity. It predates the exact-challenge repair
  above and must not be reused as acceptance of that later product change.


### Exact-challenge correction validation completion

- Full local Vitest passes 450 files / 3,571 tests in 160.77 seconds. Native
  macOS Rust lint passes; workspace tests pass 1,645 with four ignored.
- The subsequent focused macOS controlled Reload run fails before Reload while
  physically selecting Chromium Controlled Reload Window Saved · empty:
  the Swift driver reports that the exact Rion application did not become
  active. Preserve report 2026-09-06T20-15-20-907Z-darwin and its native failure
  sample as FAIL, not as product acceptance or proof of a Reload regression.
  Do not retry this result into green or relax the native activation check.
- The earlier clean full profile remains version-qualified to 01ca1f3b. The
  exact-challenge repair still requires native macOS and Windows acceptance;
  affected journeys are CHROMIUM-MACOS-APPKIT-RUNTIME-TAB-RELOAD-031 and
  CHROMIUM-WINDOWS-RUNTIME-TAB-RELOAD-031, with adjacent audio and Macro
  regression coverage retained. Restore the production Electron bundle and
  recheck E2E isolation after this failed native attempt.


### CP-15 bounded macOS activation-failure observation

- Inspecting the failed 2026-09-06T20-15-20-907Z-darwin screenshot confirms the
  Quick Open destination menu is visible before Role launch. The saved-window
  menu item is selected, but the physical click was not submitted. The native
  sample shows the Electron main thread waiting in its normal AppKit event
  loop, not the earlier Tao callback lock pattern. These observations narrow
  the failure but do not identify which application held foreground ownership.
- The physical-click driver's existing activation failure now includes only
  target PID, active/hidden/terminated/finished-launching flags, activation
  policy and foreground PID. It adds no screen content, extra activation,
  deadline increase or alternative input path. The exact foreground requirement
  and failed verdict remain unchanged.
- The extracted Swift script passes swiftc -typecheck; TypeScript, focused
  ESLint and source hygiene pass. Three adjacent E2E source suites pass 11
  tests. E2E omission is internal-only: no native profile was rerun merely to
  turn the earlier activation failure green. This diagnostic is not a repair.
- Exact product correction ae6d8350 remains under CI 34057473299; Windows
  package job 101551885424 is live and macOS package job 101551885432 queued.


### CP-15 macOS foreground obstruction identified at 8bb0e38d

- One bounded diagnostic run, report 2026-09-06T20-19-45-450Z-darwin,
  fails at the same pre-Reload physical destination click. Target PID 25785 is
  fully launched, regular activation policy, not hidden and not terminated;
  foreground PID 10663 belongs to macOS UserNotificationCenter. This narrows
  the external foreground obstruction without assuming the dialog contents.
- Computer Use refuses access to that system application for safety reasons.
  No alternate UI route or process termination was used. The owner was asked
  to handle the system dialog manually. Local native reruns are paused pending
  that action; independent Windows CI remains active.
- Replace only this activation-timeout fatalError with bounded stderr and exit
  1, preserving the failure evidence and preventing this expected test failure
  from itself causing a Swift crash report. The existing activation deadline
  and exact foreground admission remain unchanged. The earlier failed runs
  stay failed, and this does not claim to resolve the existing system dialog.
- The updated complete Swift driver typechecks. Executing the extracted failure
  branch with fixture evidence returns exit 1, exact stderr and no crash signal.
  TypeScript, focused ESLint, source hygiene and 11 adjacent source tests pass.
  E2E omission is internal-only; no new native run was launched around the known
  system obstruction. The production Electron rebuild and E2E isolation passed
  after the diagnostic attempt.


### CP-16 journal watcher Windows acceptance at 968b8828

- CI 34056466345 native Windows job 101549335257 is SUCCESS. The complete
  job log records electron-updater-journal-acknowledgement.test.ts passing all
  14 tests, including real file removal and atomic replacement coverage.
  Together with the local 968b8828 full Vitest evidence, this supplies paired
  platform verification of the file-plus-directory event watcher correction.
  It does not prove production updater transactions or publication readiness.
- The same Windows job passes eight native integration files / 15 tests,
  including both fresh-process Session maintenance fixtures, and renderer
  regression reports 440 files passed / ten skipped, 3,515 tests passed /
  48 skipped. Skipped native-inapplicable cases remain explicit, not passes.
- Reload correction ae6d8350 is still under live Windows package job
  101551885424 in CI 34057473299. Local native execution remains paused for
  the owner to handle the protected system notification dialog; no attempt was
  made to bypass Computer Use's denial of that application.


### CP-11 Windows Reload accepted at ae6d8350; CP-15 stale evidence gate

- CI 34057473299 Windows package job 101551885424 fails after 28 recorded
  PASS phases. Report 2026-09-06T20-18-37-756Z-win32 binds
  ae6d8350a8f8e864baecdc07baf220059b5aaca2 and explicitly passes
  chromium-controlled-role-reload and chromium-macro-standby-recovery.
  This supplies Windows native acceptance for the exact DOM challenge repair.
- The next chromium-macro-cutover-input-recovery spec itself passes, but its
  post-phase evidence validator throws before appending that phase to report.
  Do not count it as a passed phase or the profile as complete. The raw failure
  is Windows physical input did not prove exact foreground and hidden trusted
  DOM effects at desktopE2eChromiumMacroCutoverEvidence.mjs:120.
- Source and captured physical probe agree on the mismatch: this validator
  still requires child-HWND ABI 3, singleWebContentsSurface, exactParent and
  surfaceVisible fields. The current producer records ownerKind view, exact
  sibling Views, authenticated foreground/control/hidden/final observations,
  zoom viewport acknowledgement and trusted DOM receipts. Its dedicated
  physical-input spec already validates that format and passed in this run.
- Next repair must align the post-phase validator with the actual View contract,
  sharing validation where possible, and retain checks for exact identities,
  sibling focus, hidden presentation, zoom and trusted keyboard/middle-button
  DOM effects. Merely deleting the physical gate is not acceptable.
- The independent same-run native API probe records 18 received trusted event
  scenarios, including hidden/background input with preserved host focus; its
  declared scope is isolated WebContentsView API behavior, not a Role receipt.


### CP-15 shared physical View evidence gate correction

- Replace the obsolete ABI-v3 child-HWND post-phase predicate with exported
  validateWindowsPhysicalInputEvidence. The visible Windows physical-input
  spec and Macro cutover post-phase validator now call this same implementation,
  removing duplicate assertions and their divergent legacy assumptions.
- Require View owner kind, exact sibling Views, applied focus/viewport receipts,
  positive display scale, exact observation identities and generations, shared
  parent, live attached surfaces, foreground/control focus, hidden target
  non-focus, unchanged hidden-to-final focus identity, 125% zoom readback and
  trusted matching foreground/hidden keyboard and mouse DOM receipts. Missing,
  retired and contradicted evidence remains rejected.
- Four adjacent suites pass 42 tests, including malformed identity, focus,
  visibility, viewport and untrusted-event cases. Against the same downloaded
  ae6d8350 input-recovery artifact, the old source reproduces its exact rejection
  and the new validator returns bundled-chromium with one exact native binding
  and foreground-and-hidden-product-path evidence. This is revalidation of an
  existing artifact, not a new full E2E PASS.
- TypeScript, ESLint (zero errors, 23 warnings), hygiene and coverage pass.
  Full regression is running. E2E omission for local execution is internal-only;
  the external macOS system-dialog obstruction is unchanged and Windows must
  execute the remaining profile phases in a new exact-candidate CI run.


- Final local full regression for the shared physical View gate passes 451
  files / 3,602 tests in 156.72 seconds. Windows profile continuation remains
  required in exact-candidate CI; earlier post-phase failure is not erased.


### CP-09/CP-15/CP-16 macOS CI completion at 59b405b7

- CI 34055443364 macOS package job 101546394075 is SUCCESS. Downloaded
  chromium-shell-e2e-macOS-34055443364-1 report binds
  59b405b709a6a0c0d9b80fac52a9e8626326ff62 and chromium-macos-appkit-smoke:
  52 PASS phases plus four EXPECTED_FORCE_TERMINATION phases. This verifies
  the complete selected profile after shared Macro keyboard ownership arming.
- The same job log records the packaged darwin updater transaction for fixture
  version 8.5.0 verified, followed by packaged Electron black-box smoke passing
  for Rion Studio.app. These remain CI-fixture package/update results, not
  production-key trust, a published v22 upgrade or authorization to publish.
- Earlier ca042c19 macOS package job 101543464102 also completed SUCCESS;
  its full shell run, fixture updater and packaged black-box steps completed.
  Prefer the later 59b405b7 evidence above for this milestone.
- Current View gate repair 3a6207c5 still awaits exact-candidate native CI;
  the successful older macOS jobs do not certify the later Reload/validator
  changes. Local macOS native work remains paused for the system dialog.


### CP-11 Windows native regression at ae6d8350

- CI 34057473299 native Windows job 101551984690 is SUCCESS. Native
  integration passes eight files / 15 tests, including two fresh-process
  Session maintenance cases. Renderer regression passes 440 files / 3,519
  tests with ten files / 48 tests explicitly skipped; macro-overlay-runtime
  passes all nine tests, including the exact input-context challenge correction.
- This complements the same candidate's native controlled Reload phase PASS.
  The newer shared physical-evidence validator at 3a6207c5 remains under live
  Windows package job 101554750598; do not transfer its older post-phase
  failure into a passing complete profile before that run finishes.


### CP-11/CP-12 new Windows placement postcondition failure at 3a6207c5

- CI 34058525934 Windows package job 101554750598 fails with 26 recorded
  PASS phases and controlled-role-reload FAIL. Report
  2026-09-06T20-38-23-628Z-win32 binds 3a6207c577b217e1bf713f3089ba250bfae18100.
  Both reload receipts are inputReady/applied (69 and 70 ms); the failure is
  the subsequent empty shell-error assertion, containing
  ELECTRON_WINDOWS_RUNTIME_PLACEMENT_POSTCONDITION_STALE. It occurs before
  the injected Reload failure/recovery subscenario and before the repaired
  post-phase physical View validator is reached. Do not call this a recurrence
  of the old Reload input-ready timeout or certify the new gate end to end.
- Core flow records placement command 102 starting during Role launch and
  completing at 147, plus another placement command at 175/176. Existing
  artifacts do not include the exact before/after placement observations, so
  they cannot distinguish newer projection supersession from a real geometry,
  identity or display mismatch. Preserve the shell-error assertion.
- Refactor the same seven postcondition booleans into named checks and include
  only failing check names plus receipt/observed topology revisions in the
  existing error message. Applied/indeterminate classification and onApplied
  behavior remain unchanged. Seven focused tests pass, including both older
  and newer observed revisions still being rejected and reported distinctly.
- TypeScript, focused ESLint, complete hygiene, production Electron build and
  E2E isolation pass. Full Vitest and native macOS Rust checks are running.
  This lower-layer-covered diagnostic is not a placement repair; Windows must
  provide a new native observation, and local native UI remains obstructed.


- Placement diagnostic final validation: complete Vitest passes 451 files /
  3,604 tests in 156.23 seconds. Native macOS Rust lint and workspace tests
  pass (1,645 passed, four ignored). No native desktop profile reran locally;
  exact Windows CI still has to capture and resolve the postcondition failure.


### CP-16 independent Windows receipt publication failure at 3a6207c5

- CI 34058525934 native Windows job 101554855635 fails in
  rion-updater persistence::tests::terminal_receipt_create_new_commit_has_exactly_one_concurrent_winner.
  One writer unwraps UnsafePath at persistence.rs:1311; its parent thread then
  fails to join. Updater tests report 39 passed, one failed and two ignored.
  Do not treat this job as native acceptance or a loader failure.
- The failing helper's UnsafePath path is ensure_private_directory, which
  validates the parent and maps restrict_directory_to_current_user errors to
  UnsafePath. The Windows platform helper reapplies the root ACL and traverses
  existing descendants. Concurrent writers publish/remove unique temporary
  files in that same directory; descendant enumeration, metadata and ACL calls
  currently fail on disappearance. This identifies a plausible interleaving,
  not the exact failing native API/error, because the wrapper discards it.
- Investigate this independently of the placement postcondition failure. Keep
  no-replace publication, one durable winner, owner-only permissions and all
  unsafe-path rejection intact. Capture the underlying ACL failure before
  deciding whether a disappearing descendant may be safely ignored; do not
  broadly suppress permission, reparse-point or sharing errors.
- New diagnostic candidate e7bee0ae is active in CI 34059403980, including both
  native desktop package jobs. No new local native UI run was attempted while
  the protected system-dialog obstruction remains unresolved.


### CP-16 preserve the ACL failure source for exact native diagnosis

- Replace the discarded PlatformError from restrict_directory_to_current_user
  with PersistenceError::DirectoryProtection carrying that source. Display and
  UpdateManagerError::code remain UPDATE_PERSISTENCE_PATH_UNSAFE. Invalid
  parent/symlink handling still uses UnsafePath, and no ACL or publication
  error becomes success. Native test panic Debug output now retains the actual
  platform operation/error needed to distinguish disappearance from denial.
- A focused manager test verifies the source chain and Debug evidence while
  keeping the public error text/code free of native detail. It passes locally;
  TypeScript, hygiene and native macOS Rust lint also pass. Full Rust workspace
  verification is active. This is lower-layer-covered error preservation,
  not a concurrency fix or a new desktop journey.


- Final native macOS validation passes: Rust lint and 1,646 workspace tests
  (four ignored), stable-shell build, production Electron build and E2E
  production isolation. No local desktop profile ran around the known protected
  system-dialog obstruction. Windows must exercise the retained error source
  in exact-candidate native CI; no ACL race repair is claimed.


### CP-08/CP-11/CP-15 exact e7bee0ae profile evidence and canvas precondition

- CI 34059403980 Windows package job 101557109833 records 29 PASS phases
  and chromium-macro-cutover-keyboard FAIL, report
  2026-09-06T20-55-44-152Z-win32. Controlled Reload, standby recovery, and
  input recovery pass; the shared View physical-evidence validator also passes
  in its actual native profile. The previous placement mismatch does not recur
  in this run; that alone does not prove its cause resolved.
- Keyboard fixture events 624/625 hit an unnamed element; the trusted KeyQ
  keydown at 626 and fallback keyup at 628 both have an empty targetId. Thus
  the canvas-specific blur-release assertion lacks its intended initial canvas
  keydown. The fixed quarter-canvas pointer offset did not establish that
  precondition. Do not redirect production key releases to a different owner.
- E2E key submission now reads an exposed canvas point using viewport-clipped
  geometry and elementFromPoint, performs a real WebDriver pointer click, and
  asserts actual canvas focus before sending keys. No script focuses/clicks the
  page, no retry or delay establishes success, and focusCanvas:false retains
  the existing held-key continuity path. The blur scenario additionally proves
  its trusted canvas keydown before switching tabs; its canvas keyup assertion
  remains unchanged. Both platform labels cover occlusion, viewport clipping,
  offscreen and missing canvas cases in focused tests.
- Affected paired Chromium journey suffixes are ROLE-KEY-BLUR-004,
  MACRO-MODIFIER-CONTINUITY-008, MACRO-SHORTCUT-REENTRY-007, and
  MACRO-MIDDLE-BUTTON-013; the manifest's membership and outcomes are unchanged.
  Native verification of this E2E precondition correction remains pending CI.

### CP-11/CP-15 macOS mixed Workspace restart failure at e7bee0ae

- The same candidate's macOS package job 101557109768 fails with six PASS
  phases and chromium-workspace-web-slot-restart FAIL. Seed SQLite retains the
  exact Workspace tab and resized 0.55 Web slot. Restart restores that same tab
  and Role owner, and the Role document emits did-finish-load/did-stop-loading.
- Native topology remains hidden at revision 5 with no completed Web surface.
  Core effect embeddedLoadWebSurfaces starts at sequence 96 and remains pending
  until cleanup at 1903 rejects it: the Rion-owned Web chrome closed before
  its local document loaded. Saved-window restore terminalizes non-success.
  This narrows the failure to local chrome load completion, not missing saved
  data or a Role navigation timeout. It does not yet identify why that exact
  local navigation did not complete. Preserve the restore assertion/deadline.
- Latest diagnostic candidate d0b99b68 remains in CI 34059812939. No local
  desktop profile bypassed the unresolved protected macOS system dialog.


### CP-12 exact newer placement projection observed at d0b99b68

- CI 34059812939 Windows package job 101558205198 fails the controlled Reload
  shell-error assertion. The preserved diagnostic identifies only
  topologyRevision: receipt=6, observed=8. Identity, display, presentation,
  normal bounds, saved work area, and display topology all match. This is new
  evidence of a newer projection overtaking the placement receipt; the correct
  supersession boundary remains to be implemented and verified. Do not weaken
  stale identity or geometry rejection, or count the failed profile as passed.


- Canvas E2E correction validation: focused tests 16 PASS; full Vitest Test Files  452 passed (452); Tests  3612 passed (3612); Duration  158.86s (transform 3.11s, setup 0ms, import 14.09s, tests 95.96s, environment 21.22s). TypeScript, complete ESLint, source hygiene, documentation/context validation, coverage manifest, and production E2E isolation all pass. Native macOS/Windows profiles for this correction remain pending; no product runtime or shared contract changed.


### CP-12 retire a placement receipt overtaken by an exact newer projection

- Native evidence at d0b99b68 identifies revision 6 overtaken by revision 8
  with every other placement postcondition intact. readRuntimeWindowPlacement
  obtains this revision from the Core-owned Windows chrome projection; it is
  not a timer or a locally invented counter.
- The controller now records superseded / verified:false only when an applied
  exact Core receipt is older than that same host's observed projection and
  topologyRevision is the sole mismatched postcondition. It preserves the
  original receipt for inspection, does not apply its old runtime target, does
  not mark its placement key verified, and does not report this normal
  supersession as a shell failure. A subsequent native event still submits and
  verifies its own exact receipt. No polling, retry or deadline changes.
- Older revisions and any identity, geometry, presentation or display mismatch
  remain indeterminate failures. Eleven focused tests pass, including an
  overtaken receipt followed by a separate exact event, and newer revisions
  combined with identity/bounds/display-topology mismatches. This is
  lower-layer-covered terminal classification within the existing local
  inspection status union; no Core or generated contract changes.
- Affected existing Windows journeys include RUNTIME-TAB-RELOAD-031 and native
  window placement/topology. The E2E shell-error assertions and manifest
  membership remain unchanged. Native Windows acceptance of this correction
  remains pending CI; the previous passing Reload run is not this candidate.


- Final local verification: Test Files  452 passed (452); Tests  3616 passed (3616); Duration  156.08s (transform 3.46s, setup 0ms, import 14.65s, tests 92.33s, environment 21.62s). Native macOS Rust lint and workspace tests pass (1,646 passed, four ignored); TypeScript, full ESLint, source hygiene, documentation, coverage, stable-shell build, Electron build and production isolation pass. This batch runs no local desktop E2E around the unresolved protected system-dialog obstruction. Windows exact-candidate CI remains pending.


### CP-11/CP-15 observe the missing local Web chrome navigation boundary

- The e7bee0ae macOS restart failure's native sample shows the Electron main
  thread servicing the AppKit run loop; it does not show the previously repaired
  Tauri callback deadlock. Existing Role lifecycle evidence cannot describe the
  separate local Web chrome WebContents that remained pending.
- Extend the E2E-only lifecycle observer to identify the bounded local chrome
  file navigation in an in-memory Session and write a separate
  electron-local-web-chrome-lifecycle-observations.json artifact. It records
  the exact loadURL request and its original Promise outcome alongside native
  navigation/load/provisional-failure/process-gone/close events. Identification
  is observational and is not a security admission policy. Persistent Role
  artifact semantics remain unchanged; unrelated transient pages are ignored.
- The observer returns the original navigation Promise and preserves native
  close behavior. Both macOS and Windows tests verify resolve/reject identity,
  ignored unrelated navigation, process-gone detail, and no initiated close.
  This internal-only evidence addition does not change the product load gate,
  deadline, successful restoration criteria or any journey membership. It is
  not a repair or native acceptance for the intermittent restart failure.


- CI 34060549968 / Windows package 101560186467 at ffa18d2b repeats the
  exact receipt=6 / observed=8 topology-only placement failure before the
  keyboard phase. It predates the d27e7129 supersession repair and does not
  verify or disprove the canvas correction. The repaired candidate is live
  in CI 34060823634 / Windows package 101560915332.


- Local observer validation: Test Files  452 passed (452); Tests  3620 passed (3620); Duration  155.87s (transform 3.08s, setup 0ms, import 13.94s, tests 93.21s, environment 21.13s). TypeScript, full ESLint, source hygiene and documentation checks pass. Both E2E and production Electron builds pass, followed by production isolation. No product runtime, shared contract or Rust source changed; native Rust results remain those recorded at d27e7129, not a new run. Desktop evidence collection for this E2E-only change remains pending macOS/Windows CI.


### CP-16 bounded concurrent receipt publication diagnosis

- d0b99b68 Windows native job 101558302354 is SUCCESS, including the existing
  32-round concurrent create-new receipt test. This does not resolve the
  previously observed UnsafePath failure: no native cause was reproduced in
  that run despite retaining PlatformError at the persistence boundary.
- Expand the existing two-writer/fresh-parent test to 256 rounds on every native
  platform, recording the failing round with the retained error source. All
  rounds must still yield exactly one Created and one AlreadyExists outcome,
  with winner bytes read back from the committed file. A failed round fails the
  test immediately; no retry-after-failure or reduced acceptance is introduced.
- The focused macOS test passes in 3.58 seconds. Windows must execute this
  bounded soak to obtain stronger concurrent-native evidence. This changes
  tests only and is lower-layer-covered; ACL policy, no-replace publication,
  operation terminality, production update behavior and journey membership
  are unchanged. It is not an ACL repair.


### CP-08/CP-09/CP-12 Windows progresses through keyboard to multi-Role admission

- Report 2026-09-06T21-23-05-670Z-win32 from CI 34060823634 / job 101560915332 binds d27e7129
  and records 30 PASS phases, then chromium-macro-cutover-topology-seed FAIL.
  Controlled Reload, standby recovery, input recovery and the complete keyboard
  phase pass. This provides native evidence for both the placement supersession
  correction and the visible canvas precondition correction; it is not a full
  profile or legacy-input deletion gate.
- The next failure occurs at the first multi-Role Macro KeyM input. Both roles
  occupy the same visible three-column Workspace in one foreground parent.
  Role B's View is attached/visible but not focused; the sibling Role owns
  focusedWebContentsId 4. Core effects browser-action-5 and browser-action-6
  reject with SYSTEM_TRUSTED_INPUT_DELIVERY_MODE_UNAVAILABLE before submission.
- currentInputDeliveryMode selects foreground from viewVisible, but
  validChromiumViewInputObservation requires foreground contentsFocused and
  the same focusedWebContentsId. Thus visible unfocused sibling input is not
  admitted, unlike the already-tested hidden sibling path. Investigate and
  natively prove this distinct case without stealing focus, weakening exact
  identity/epoch/DOM receipts or treating a portable mock as replacement parity.


- Bounded receipt soak final macOS validation: Rust lint passes; workspace tests total 1646 passed, 0 failed, 4 ignored. Source hygiene, documentation and diff checks pass. This test-only batch does not rerun renderer tests or desktop profiles; Windows execution of all 256 rounds remains pending CI.


### CP-08/CP-09 admit visible unfocused Workspace siblings without taking focus

- d27e7129 native evidence shows the same foreground parent containing multiple
  visible Role Views, with only one focused WebContents. The View validator
  now permits foreground visibility with a different positive focused sibling
  id while requiring contentsFocused to agree exactly with that id. Missing
  foreground focus, inconsistent focus facts, focused hidden Views and all
  existing parent/generation/bounds/epoch fences still fail admission.
- The submission loop continues to compare the full immutable observation
  before every native input edge and after the final edge. Focus stealing or
  changed geometry/identity cannot produce a submitted receipt; the independent
  authenticated trusted-DOM receipt remains required. No focus() call, fallback
  HWND adapter, extra delivery mode, polling or deadline change is introduced.
- Add paired platform tests for visible sibling admission, missing/inconsistent
  focus rejection, focus stealing during a click, and the exact host bridge
  delivery mode. The three focused suites pass 83 tests. These are portable
  regression evidence, not native parity.
- Extend the existing Chromium native probe with both key and middle-button
  cases for distinct visible sibling bounds. Require trusted DOM events,
  target remaining unfocused, sibling remaining focused, matching viewport and
  exact native View-owner receipt on Windows. The prior hidden cases remain.
  macOS probes observe Chromium behavior only; retained AppKit product input
  remains unchanged. The full multi-Role E2E assertions are unchanged and must
  pass independently before old input implementation deletion.


- Affected paired Chromium journey suffixes: MACRO-MULTIROLE-005 and
  MACRO-OWNERSHIP-TRANSFER-010. Their manifest membership and exact visible
  user actions remain unchanged; native validation for this candidate is pending.

### CP-15 independent stable Windows background-tab failure at a20bddec

- CI 34061202087 stable Windows job 101561949113 fails
  verifyBackgroundTabContinuity at macro-runtime-background-tab.ts:158.
  After switching to Role B, the test submits a physical KeyZ down/up sequence
  but receives no consumer-keyup after fixture cursor 767. Diagnostic Role B
  state has zero keydowns/keyups. This is separate from the Chromium visible
  sibling admission failure and cannot be marked resolved by that correction.
- Preserve the failing stable profile and its assertions; inspect its native
  focus/input artifacts before deciding whether the user-input precondition or
  stable product routing failed. Earlier passing stable profiles remain
  version-qualified evidence only.


- Full regression initially found ten failures in the explicit View focus
  admission suite: input eligibility alone cannot prove an explicit focus
  request complete. Preserve that operation's stricter postcondition by
  additionally requiring contentsFocused and the exact target WebContents id
  in ChromiumViewFocusAdmission. Existing focus-event, retirement, hidden-state
  and deadline tests remain unchanged. All four focused suites now pass 101
  tests; full regression is rerunning after this correction.


- Final visible sibling validation: Test Files  452 passed (452); Tests  3632 passed (3632); Duration  157.36s (transform 3.09s, setup 0ms, import 13.93s, tests 94.69s, environment 21.13s). macOS Rust lint and workspace tests pass (1646 passed, 4 ignored); TypeScript, ESLint, hygiene, documentation, coverage, stable-shell build, final Electron build and production isolation pass. No local native UI probe ran around the unresolved protected system dialog. Both extended native probes and Windows multi-Role E2E remain pending exact-candidate CI.


### CP-15 preserve explicit tab focus across passive hydration

- Recover the a20bddec Windows stable failure's SQLite logs from a disposable
  copy of both logs.sqlite3 and its WAL; the immutable database alone omits the
  uncheckpointed evidence. At revision 22, Role B's completed presentation has
  trigger tab-content-became-visible, focusMode none and focusApplied false.
  Its surface becomes visible, but the fixture records no focus or KeyZ event.
- NativeWindowActor previously queued only mode/visibility controls as ordered
  work. An explicit content-focus request could therefore be replaced by a
  later passive hydration request. Include ContentOnly and WindowAndContent
  focus requests in the existing bounded ordered queue. Passive hydration still
  coalesces, and existing generation/revision/focus fences still reject stale
  requests. No new focus retry, timeout, capacity increase or platform branch.
- Add a paired-platform queue regression: hydration cannot replace selection
  focus, subsequent hydration coalesces, and dequeue preserves the focus before
  the latest passive projection. This repairs the existing activation contract;
  it does not introduce a new user interaction. Affected existing journey:
  MACRO-BACKGROUND-TAB-004 on macOS and Windows. The unchanged desktop test must
  still prove physical KeyZ reaches Role B without an artificial refocus.
- Initial focused queue tests and Rust lint pass. The initial full Rust run
  fails stopping_from_one_assigned_role_cancels_the_sibling_invocation with a
  two-second channel Timeout (950 Core tests pass). Its isolated diagnostic
  run passes in 0.01 seconds; this does not resolve the intermittent failure.
  Preserve this result and revalidate the final source after removing one
  redundant predicate-only test. Do not extend the test timeout.
- f0beec3c Windows job 101563096997 completes the target-platform Rust workspace
  step successfully, including the expanded 256-round receipt publication test.
  This is stronger concurrency evidence, not a repair or proof that the earlier
  ACL race cannot recur. Native compatibility probes remain in progress.
- c57075f1 CI 34062078527 has passed checks, renderer build and Linux soak;
  Windows Chromium E2E and native validation are running, while macOS jobs are
  queued. Visible unfocused sibling input is still pending native acceptance.


### CP-08/CP-09 c57075f1 reaches post-input Stop, then loses background-parent admission

- Windows report 2026-09-06T21-48-36-056Z-win32, CI 34062078527 / job
  101564261428, retains 30 passing phases and fails topology-seed later than
  d27e7129: both trusted KeyM assertions and the visible Role B click complete;
  stopChromiumMacroVisible then finds Stop disabled. The whole multi-Role
  journey remains FAIL, not partial acceptance of ownership transfer.
- Core browser-action-12 through browser-action-15 reject with the existing
  delivery-mode-unavailable error. View observations 49-52 show the parent is
  visible and not minimized but parentForeground false, with the main app
  WebContents id 1 focused. Both Role Views remain attached and visible.
  validChromiumViewInputObservation still unconditionally requires a foreground
  parent. This is a distinct background-parent case after returning to the
  launcher, beyond the newly admitted visible sibling in a foreground parent.
- Next: prove exact input and cleanup against an unfocused native parent without
  activating it, preserving foreground identity and trusted DOM receipts. Do not
  fix this by keeping the test's runtime window artificially foreground or by
  enabling Stop without an authoritative live Macro state. Native background
  parent parity and legacy adapter deletion remain unproven.

- Final tab-focus source validation passes macOS Rust lint and workspace tests:
  1647 passed, 4 ignored. Both stable and Electron builds, TypeScript and
  production E2E isolation pass. Full hygiene, ESLint and coverage checks pass; full
  JavaScript regression passes (452 files, 3632 tests). No local desktop profile ran for this
  batch; MACRO-BACKGROUND-TAB-004 remains pending exact-candidate paired CI.


### CP-08/CP-09 preserve Macro input while the visible parent is backgrounded

- The c57075f1 Windows raw Chromium probe records received, trusted key down/up
  and middle-button down/up for background-host, with hostFocused false before
  and after. These raw API samples support feasibility only; they do not prove
  the attached native View owner's full receipt path.
- Allow a boolean parentForeground in exact View input admission while retaining
  visible/non-minimized parent, attached live View, exact generations, geometry,
  zoom, input epoch and consistent content focus. A non-foreground parent must
  report unfocused target contents. The immutable observation and native focus
  token are still compared before every edge and after the final edge, so input
  cannot acquire foreground or follow a changed foreground owner silently.
- Visibility continues to select the existing foreground/background delivery
  mode; no extra mode, activation call, legacy HWND fallback or new timing path.
  Explicit focus admission retains its independent foreground requirement for
  both visible and hidden targets. Initial focused regression caught the hidden
  focus postcondition changing through the shared validator; preserving that
  condition restores all 111 tests across four suites without changing them.
- Add paired unit evidence for key input under a background parent, rejection
  after foreground changes during a click, contradictory focused contents,
  and the exact host bridge for visible and hidden targets. Extend both native
  probes with four background-parent cases: hidden/visible target times key/
  middle button. Require unchanged focused external WebContents, unfocused
  target/parent, trusted DOM edges and the existing scaled viewport. The Windows
  View-owner test additionally requires exact native receipts and monotonic
  dispatch sequence through the same production owner; no portable mock can
  satisfy that gate. macOS AppKit product input remains unchanged.
- Affected existing paired journeys: MACRO-MULTIROLE-005 and
  MACRO-OWNERSHIP-TRANSFER-010. Their actions, assertions and manifest membership
  remain unchanged. Full Windows topology-seed must still visibly stop the
  running Macro, transfer ownership, and independently pass restart before
  these tasks or legacy input deletion can close.
- Native probes and desktop acceptance for this correction remain pending CI.
  No local native UI was run around the unresolved protected system dialog.


- Final background-parent validation: 452 Vitest files / 3642 tests pass in
  157.61 seconds; macOS Rust lint and all 1647 workspace tests pass (4 ignored).
  TypeScript, ESLint, full hygiene/coverage, stable-shell build, Electron build
  and production isolation pass. The initial two hidden-focus regressions were
  fixed by preserving that existing focus contract, not weakening expectations.
  Native background-parent probes and full paired E2E remain pending the exact
  candidate CI. a20bddec macOS job 101561949187 separately completes its Chromium
  shell E2E step successfully; this does not resolve intermittent local-chrome
  restart or validate the current background-parent candidate.


### CP-15/CP-16 bounded follow-up evidence after 1422ea67

- Windows native validation job 101563096997 for f0beec3c is now completed
  SUCCESS. Its full log confirms the 256-round concurrent receipt publication
  test passed, followed by 8 native integration files / 15 tests and the
  platform-filtered portable suite (442 files, 3568 tests; 10 files / 48 tests
  skipped). No retained native ACL error was reproduced in this run; the
  earlier UnsafePath failure is not explained by this success.
- Diagnose the separate macOS Macro stop timeout with a fresh standalone
  rion-core test executable built from current source. Run the exact sibling
  cancellation test in 256 fresh processes with RUST_BACKTRACE=1, stopping at
  the first nonzero exit. All 256 rounds pass. This bounded experiment does not
  erase the earlier full-workspace failure or prove that load-sensitive
  interleavings cannot recur. No test deadline, production logic or assertion
  changed; raw evidence is /tmp/rion-macro-stop-bounded-soak.log on this host.
- The 192120ad Windows stable full E2E job 101566159388 is confirmed in progress;
  its tab-focus correction is still awaiting native acceptance. The 1422ea67
  Windows Chromium job 101567161742 is also live, restoring its Rust cache;
  macOS jobs remain queued. Neither elapsed time nor prior-candidate success
  closes the current full parity gate.


### CP-08 1422ea67 Windows background-parent API evidence

- CI 34063144726 artifact chromium-input-windows-latest-34063144726-1 contains
  four received direct-background cases: hidden/visible sibling times key/
  middle button. Every key edge is trusted KeyB with Control+Shift; middle
  edges are trusted at DOM coordinates 80,96 with viewport 240x160 and zoom
  1.25. The target remains attached, unfocused, and in its specified visibility
  state; its parent remains visible and unfocused. The other WebContents id 2
  remains the exact focused identity before and after every sample.
- This artifact explicitly records nativeParentOwner false. It verifies the
  direct shared Chromium primitive only, not the production native View-owner
  receipt path or whole Macro journey. The Windows native-owner integration and
  full Chromium E2E jobs are still live. Preserve that distinction before
  claiming background-parent parity or deleting the legacy native input code.


### CP-08 c57075f1 exact Windows sibling View-owner gate passes

- Windows native job 101564351639 completes SUCCESS. Artifact
  chromium-view-owner-windows-latest-34062078527-1 contains four received
  direct sibling samples with nativeParentOwner true: hidden and visible target
  keyboard/middle input. All DOM events are trusted, the sibling remains
  focused before/after, and target/sibling remain attached with isolated
  Sessions and exact zoom 1.25 / acknowledged viewport 240x160.
- The actual production owner emits submitted native receipts with monotonically
  increasing dispatch sequences 1 through 6 and foregroundPreserved true.
  This supplies the native-owner evidence that was pending for c57075f1's
  visible unfocused sibling change. It does not test a background parent;
  1422ea67's extended owner probe and full multi-Role/transfer/restart E2E remain
  required before full input parity or legacy implementation removal.


### CP-15 192120ad Windows stable full profile verifies tab-focus correction

- CI 34062775729 / Windows stable job 101566159388 completes SUCCESS. Report
  2026-09-06T22-03-02-442Z-win32 binds exact commit
  192120ad8f4c3dfa0a8dbe355017d1d37f532c08 and profile full: 29 PASS phases,
  zero failed phases. MACRO-BACKGROUND-TAB-004 is PASS.
- The original failing operation now has direct fixture evidence: Role B focus
  sequence 765 precedes trusted KeyZ keydown/consumer-keydown/keyup/consumer-keyup
  sequences 769-772 on game-input-canvas. The unchanged test submits that
  physical sequence without artificial refocus, and its entire background-tab
  case passes. This is native evidence for preserving explicit focus in the
  presentation queue, beyond the paired unit regression.
- This closes the specific stable Windows missing-KeyZ failure observed at
  a20bddec. It does not establish macOS parity for this queue correction or
  qualify the later Chromium background-parent candidate. Those native profiles
  and the remaining CP-15/CP-18 hardware/full-candidate gates stay pending.


### CP-08/CP-15 1422ea67 advances through Macro stop and transfer to inactive-tab close

- Windows Chromium CI 34063144726 / job 101567161742 report
  2026-09-06T22-10-33-524Z-win32 binds 1422ea67 and records 30 PASS phases,
  then topology-seed FAIL at native-runtime-tabs.ts:503: the old tab's close
  button is not clickable. The scenario has already passed trusted inputs on
  both Roles, the visible Role B click, visible Macro Stop, placeholder claim,
  increased owner generation, and a trusted click on the transferred Role.
  Thus the previous background-parent rejection no longer blocks this flow;
  the complete topology and restart journeys remain failed/not run.
- The old tab is inactive after ownership transfer. Its production CSS keeps
  the close button opacity zero until tab hover, focus-within or active state.
  The helper previously waited for clickability without first hovering the
  inactive tab. Add a real WebDriver moveTo on its exact visible activation
  control before reading or clicking the close control. This reveals the
  existing UI without selecting the tab, invoking a debug close command or
  changing product CSS. Retained AppKit close actions remain unchanged.
- The existing paired MACRO-OWNERSHIP-TRANSFER-010 and TABS-VISIBLE-ACTIVATION-019
  scenarios exercise this helper. No new feature, journey membership, timeout,
  retry or weakened assertion is added. Actual Windows inactive-tab closure
  and the remaining full profile require the next exact-candidate native run.


- 1422ea67 artifact chromium-view-owner-windows-latest-34063144726-1 now
  supplies the exact background-parent owner evidence: all four hidden/visible
  key/middle cases receive trusted DOM edges with nativeParentOwner true.
  Submitted native receipts advance sequences 7-12, all foregroundPreserved true;
  the external focused WebContents remains id 2 before and after. Combined with
  the later E2E failure at inactive-tab close, this verifies the previously
  rejected background-parent input path while keeping full topology/restart
  and legacy deletion gates open.


- Final inactive-tab hover validation: TypeScript, ESLint, full hygiene and
  coverage pass; 452 Vitest files / 3642 tests pass in 156.18 seconds. Both
  Tauri and Electron E2E builds complete, then the production Electron build
  is restored and isolation passes. This E2E-only change does not rerun Rust
  unit tests; no Rust/shared/native product source changed. No local desktop
  profile ran around the unresolved protected system dialog. Existing native
  full/paired profiles remain the actual acceptance gate for the hover action.


### CP-15 paired stable focus verification and newer macOS Chromium full evidence

- macOS stable job 101566159290 / CI 34062775729 completes SUCCESS. Report
  2026-09-06T22-12-12-121Z-darwin binds the same 192120ad commit as the verified
  Windows profile, with 29 PASS phases and 3 EXPECTED_FORCE_TERMINATION phases.
  MACRO-BACKGROUND-TAB-004 passes; fixture sequences 560-563 carry trusted KeyZ
  down/consumer-down/up/consumer-up to Role B's game-input-canvas. The explicit
  focus queue correction now has paired native full-profile evidence.
- macOS Chromium job 101561949187 / CI 34061202087 completes SUCCESS. Report
  2026-09-06T21-43-03-012Z-darwin binds a20bddec with 52 PASS phases and 4
  EXPECTED_FORCE_TERMINATION phases. Workspace Web-slot restart verifies its
  retained AppKit Chromium host and persisted 0.55 divider width. This pass does
  not explain the earlier intermittent local-chrome load stall; the observer
  remains available to capture its exact failure if it recurs.
- The same macOS job verifies the packaged CI-fixture updater transaction for
  version 8.5.0 at 22:23:50 UTC and passes packaged Electron black-box smoke at
  22:24:21 UTC. These are newer qualified CP-16 fixture/package results, not
  production-keyed release transactions or permission to publish.
- Windows native job 101567263605 for 1422ea67 also completes SUCCESS: the
  256-round receipt publication test passes, all 8 native integration files /
  15 tests pass, and the platform-filtered portable suite records 442 files /
  3590 tests passed (10 files / 48 tests skipped). Exact background-parent
  native-owner evidence is recorded above; the full Chromium profile still
  requires the inactive-tab hover correction and subsequent stages.
- Current runtime acceptance candidate remains 5863c303 / CI 34064073603;
  no source implementation changed during this evidence update. Its Windows
  jobs are live and macOS jobs queued. Keep evidence tied to each exact SHA.


### CP-15 5863c303 closes the inactive tab; short Macro presentation wait is invalid

- CI 34064073603 Windows job 101569645720 report binds 5863c303, with 30 PASS
  phases followed by topology-seed failure at startChromiumMacroVisible for the
  single Role one-shot Macro after transfer and old-tab closure. The close
  hover correction passes that operation. Core acknowledges macroStart and
  input effects browser-action-17 through 19 without rejection; the transferred
  exact Role remains running after old-tab destruction.
- Fixture sequences 690-693 show trusted KeyS down/consumer-down/up/consumer-up
  on macro-multirole-a's game-input-canvas in roughly 41 milliseconds. The
  Macro did execute. Waiting for the renderer's transient running state is
  inappropriate for this short task: Macro presentation updates are throttled
  at 250 milliseconds, while terminal status propagation is reliable.
- Extract the existing visible Start click from the ongoing-Macro helper.
  Keep all ongoing callers' running-state requirement. The ownership seed and
  restart one-shot cases now use the same visible click, require trusted KeyS
  down and subsequent consumer-keyup, then require the Macro's absent terminal
  projection. Keep exact owner transfer/readiness and non-target input rejection.
  No loop/delay is added to keep the Macro artificially running; no product
  behavior, event throttle, deadline or retry changes.
- Affected paired journey suffix: MACRO-OWNERSHIP-TRANSFER-010. The existing
  E2E now checks completed balanced input as well as eligibility; manifest
  membership and native driver boundaries remain unchanged. Full paired
  topology/restart acceptance remains pending the next candidate.


- Final one-shot E2E correction validation: all 452 Vitest files / 3642 tests
  pass in 157.22 seconds; TypeScript (including tsconfig.e2e), ESLint, full
  hygiene/coverage, Electron E2E build, restored production build and isolation
  pass. No Rust/product contract source changed, so Rust unit tests were not
  rerun for this test-only batch. Local native desktop profiles remain paused;
  paired seed/restart execution awaits exact-candidate CI. Separately,
  1422ea67 macOS job 101567161677 has completed its Chromium shell E2E step
  successfully while later package/update steps remain live.


### CP-15 1422ea67 macOS Chromium full profile verified

- Artifact chromium-shell-e2e-macOS-34063144726-1 report
  2026-09-06T22-26-31-096Z-darwin binds
  1422ea67a812fb8ba3bf45608c1bcd5a826f33ad and chromium-macos-appkit-smoke:
  52 PASS phases plus 4 EXPECTED_FORCE_TERMINATION phases. The exact Macro
  ownership topology seed and restart phases both pass on retained AppKit.
- This is the newest verified macOS full Chromium runtime evidence, including
  the shared background-parent validator version. Later macOS package/update
  work remains live. It does not substitute for Windows full acceptance: the
  latest E2E-only candidate 557456e0 / CI 34065004149 still needs to execute
  the one-shot completion correction and all subsequent Windows phases.


- 1422ea67 macOS native job 101567263611 now completes SUCCESS. Its native
  integration stage records 6 files / 13 tests passed, with the 2 Windows-only
  files/tests skipped as declared; the direct Chromium probe passes separately.
  Together with Windows native job 101567263605, this supplies paired native
  validation for that runtime implementation. AppKit product input remains
  retained; this does not turn the Mac compatibility probe into Windows
  View-owner evidence. Latest 557456e0 full Windows E2E remains live and its
  macOS jobs queued, so no full-candidate or legacy deletion gate closes here.


### CP-15 557456e0 proves input release but renderer journal completion is missing

- CI 34065004149 Windows job 101572107531 report binds 557456e0, with 30
  passing phases then topology-seed failing at the new absent Macro projection
  wait. Both the trusted KeyS down and consumer-keyup assertions have passed.
  The failure screenshot shows Macros with 0 running and both rows ready.
  Therefore the earlier transient-running explanation does not explain all
  observations; do not call this resolved or remove the completion assertion.
- The preload creates an independent listener for each event subscription, and
  the E2E journal searches all retained post-cursor Macro entries. Source review
  alone does not establish why the journal lacks a matching completion while
  the renderer displays idle. Keep product behavior and all assertions unchanged.
- On a projection-wait rejection, record a one-time read-only diagnostic from
  the same page: journal presence, current sequence, waiter count, last 32
  relevant Macro entries and current typed-bridge Macro statuses. Retain the
  original exception as cause and fail the test. No polling, retry, timeout
  increase or replacement success path is introduced. This is internal-only
  E2E diagnosis; the next native failure must distinguish missing propagation,
  cursor/journal mismatch and a still-live Core Macro before another repair.


### CP-10/CP-15 new Windows import restart lock failure at 557456e0

- Native Windows job 101572210336 / CI 34065004149 fails the Rust workspace
  stage: a_fully_verified_import_journal_allows_launch_without_new_role_evidence
  panics at behavior_21_session_migration_launch_gate.rs:1056 while reopening
  with APP_INSTANCE_LOCKED. The same test output reports state worker shutdown
  timed out after 3 seconds, followed by unproven terminal teardown. 950 Core
  tests pass and one fails; native probes after this gate are not acceptance
  evidence for this run.
- Preserve the failure and inspect exact shutdown acknowledgement and lifetime
  ownership before changing the restart fixture or product code. Do not treat
  an elapsed timeout as release, bypass the application lock, extend deadlines,
  or retry the reopen into success. This is separate from the renderer Macro
  journal observation failure and the earlier updater ACL concurrency issue.


- Final journal-diagnostic validation: 452 Vitest files / 3642 tests pass in
  153.95 seconds; TypeScript, ESLint, full hygiene/coverage, Electron E2E build,
  restored production build and isolation pass. This changes only E2E failure
  observation, so no Rust unit rerun or local native desktop execution was
  performed. Native journal diagnosis and the separately observed restart-lock
  failure remain open; no success criterion was changed in this batch.


### CP-10 shutdown failure attribution and source audit

- The verified-import restart test now requires `shutdown_checked()` to return
  `Completed` before reopening the v22 data directory with Chromium, and again
  for final Chromium teardown. Previously the compatibility `shutdown()`
  printed the original error and allowed the test to continue into
  `APP_INSTANCE_LOCKED`. The assertion change preserves the first failing
  boundary; it does not repair the Windows shutdown timeout.
- Source audit confirms the state worker acknowledges only after its explicit
  WAL checkpoint and SQLite connection close. Core retains the instance lock
  when this acknowledgement fails. Its SQLite busy timeout is five seconds
  while the shutdown receive boundary is three seconds; this is a possible
  source of an unknown acknowledgement, not proof of lock contention in the
  observed failure. Existing logs do not distinguish queue delay, checkpoint,
  and connection close. No deadlines, retries, locking rules or production
  behavior are changed.
- Latest journal-diagnostic candidate b310c06d / CI 34065969000 remains live:
  Windows Chromium job 101574657954 is executing its shell E2E and Windows
  native job 101574759393 is executing Rust tests. The macOS Chromium and
  native jobs remain queued at this observation. Retain these run handles.

- Validation for this lower-layer-covered test change: the focused macOS
  import test passes; full native Rust workspace passes 1647 tests with 4
  declared ignored tests, and Rust lint passes. Vitest passes 452 files /
  3642 tests in 159.22 seconds; JavaScript lint passes with 23 existing
  warnings, and full hygiene / coverage checks pass. No user-visible behavior
  or journey membership changed. No local macOS desktop E2E profile ran;
  Windows execution of the stronger shutdown assertion remains pending CI.


### CP-15 b310c06d stable macOS restore-event ordering correction

- CI 34065969000 stable macOS job 101574657940 fails with 23 PASS phases
  followed by p1-cross-domain-topology-force. Its report binds b310c06d; the
  restore control succeeds with native presentation normal at sequence 368,
  but the test then times out waiting for window-focus-persisted after 368.
  The pre-restore cursor was 357. The native sample shows the AppKit main
  thread in its event loop, not a demonstrated runtime mutex deadlock.
- Source inspection establishes that native-control-submitted is recorded
  after native control execution and native readback, while focus persistence
  runs independently from the authoritative native focus callback. There is
  no guarantee that focus persistence happens after the submitted receipt.
  Use the pre-action restore cursor for both observations, retaining the
  required same-window/generation focus event and restored presentation check.
  Do not remove the focus assertion or change timeout/product behavior.
- This corrects an invalid E2E ordering assumption; available artifacts do
  not establish the missing focus event's exact sequence, so native replay
  remains required before calling the observed failure resolved. Affected
  existing journey: RUNTIME-TAB-TOPOLOGY-009 (p1-cross-domain-topology-force);
  manifest membership and platform-specific focus requirements are unchanged.


### CP-04/CP-09/CP-15 surviving Chromium window misses its post-close projection

- b310c06d Windows Chromium job 101574657954 / CI 34065969000 again passes
  30 phases and fails topology-seed. The added diagnostic proves Core Macro
  statuses are empty, but the renderer journal remains at nextSequence 120
  throughout a wait fenced after 119. Its last Macro snapshot is sequence 117.
  This is missing subsequent projection delivery, not an ongoing Macro.
- Core flow ends appSnapshot reads at 554/556 after embeddedDestroyTab closes
  the old Workspace. Native topology observation 15 removes that tab but
  keeps the surviving window at topologyRevision 14. Source inspection shows
  native tab destruction edits membership only, while logical close advances
  Core's window revision. The snapshot validator correctly rejects mismatched
  revisions and waits for another native projection, holding the refresh lane.
- A new lower-layer regression first failed because no post-destruction
  EmbeddedFollowRoleOwnership projection existed. The final matrix exercises
  both Role and Workspace typed tab closure on explicit darwin and win32,
  with another Workspace remaining. It requires the projection after native
  destruction to carry the exact final Core window generation, revision,
  remaining tab list and active tab, and retain the parent operation identity.
- Both close paths now call one shared Rust helper after successful terminal
  cleanup and outside the runtime sequence lease. Only v23 and a surviving
  original window require the existing fenced projection effect. Native close
  failure remains failure; the destroyed tab is never recreated, the last
  window does not receive a spurious projection, and v22 behavior is unchanged.
  The matrix passes all four combinations after the repair. Native E2E replay
  remains pending before declaring the Windows symptom resolved.
- Existing affected journeys: paired MACRO-OWNERSHIP-TRANSFER-010 and
  RUNTIME-TAB-TOPOLOGY-009. Existing native topology seed/restart cases remain
  the acceptance gate; no new feature or manifest membership is introduced.


### CP-15 b310c06d stable Windows recovery activation remains open

- Stable Windows job 101574657780 / CI 34065969000 report binds b310c06d:
  27 PASS phases and one EXPECTED_FORCE_TERMINATION precede force-terminate
  failure. Cross-domain topology/recovery passes on this platform, as does
  the previously repaired background-tab KeyZ journey. The new failure is
  waitEvent in activateRecoveryTab at game-window-lifecycle.e2e.ts:705, called
  by forceTerminatePhase at line 749. Activation terminal, ready and session
  assertions precede this failed window-state-persisted wait. It occurs before
  the deliberate process termination and is not an expected-termination result. Preserve the artifact
  and inspect its activation receipt separately; no failure is waived.

- Final validation for the close-projection repair and restore-cursor E2E
  correction: macOS native Rust workspace passes 1648 tests with 4 declared
  ignored tests; Rust lint, TypeScript, ESLint and full hygiene/coverage pass.
  Vitest passes 452 files / 3642 tests in 154.34 seconds. Tauri E2E and
  Electron E2E builds pass after the Rust repair; the restored Electron
  production build and desktop E2E isolation check pass. No local macOS UI
  profile was executed due the previously documented protected-dialog boundary.
  Paired native CI, especially Windows full topology/restart and the new
  stable Windows persistence observation, remains pending for the new commit.


### CP-15 recovery durability waits on committed Core definitions

- Further inspection of b310c06d Windows stable force-terminate evidence shows
  alpha tab 48611348-6e87-466b-8c85-f70e8698701c is already the active tab in
  the captured SQLite game_windows record, updated at 23:20:03.033713600Z.
  All three tabs remain. Native activation terminal 195 arrives later at
  23:20:03.096145400Z. The failed wait was fenced after 127 and requested
  the shell-worker-only window-state-persisted event; missing durability is
  therefore not established by that timeout.
- Core activation has its own authoritative snapshot commit path through
  persist_runtime_ui_windows and mutate_state. The shell background worker
  emits its applied receipt only for its own accepted snapshots; it is not
  the sole writer of persisted active-tab state. The artifact does not reveal
  which individual writer produced the observed row, so do not invent a
  missing worker receipt or classify a superseded snapshot as applied.
- Recovery activation now subscribes before the visible native action and
  waits for a post-cursor committed Game Window definition with the exact
  window ID, active tab and unchanged tab count. It retains native activation
  completion, page/session evidence, same-generation readback and the later
  force-termination/restart checks. Both platforms use this same Core event
  source; no polling, retry, timeout increase or synthetic write is added.
- Extend the renderer-journal unit test to reject a pre-cursor matching
  active tab and a post-cursor wrong active tab, then complete only on the
  matching committed definition. Existing GAME-WINDOWS-TABS-001 and
  APP-RECOVERY-001 journeys retain their manifest membership. This is
  internal-only E2E correction; paired native replay remains pending.


### CP-16 efbff1c7 identifies the Windows ACL race precisely

- CI 34066500135 Windows native job 101576170068 fails the updater
  concurrent terminal-receipt publication test at round 27. The preserved
  source error is DirectoryProtection(Operation("inspect migrated data ACL
  entry: The system cannot find the file specified. (os error 2)")).
  Updater totals: 40 passed, one failed, two ignored. This is not the
  separate Core import-shutdown failure.
- The error-preservation and bounded concurrency changes have now supplied
  the previously missing classification: a descendant disappears during
  migration ACL enumeration/metadata inspection. Inspect that exact boundary
  before repair; do not broadly suppress permission/reparse/root failures,
  increase deadlines, or retry publication into success. Keep the native
  failure and require paired validation of any subsequent platform change.

- Final recovery-event validation: focused renderer journal test passes; all
  452 Vitest files / 3642 tests pass in 155.89 seconds. TypeScript, ESLint,
  full hygiene/coverage and Tauri E2E build pass. The production isolation
  check correctly rejected the E2E renderer output until the Electron
  production build was restored; the final isolation check passes. No Rust
  source or contract changed in this batch, so native Rust unit suites were
  not rerun. Local native UI remains paused; paired desktop CI is required
  to validate this internal-only E2E correction.


### CP-16 handle disappearing descendants during Windows ACL migration

- Repair the classified efbff1c7 failure in the shared Rust filesystem
  adapter. After the root ACL has been applied, a previously enumerated child
  may disappear through concurrent rename/delete. One helper accepts only
  Windows FILE_NOT_FOUND/PATH_NOT_FOUND as absent descendant work; successful entries and
  every other error remain distinct.
- Apply this rule to descendant metadata, native ACL application and opening
  a queued descendant directory. Root ACL application and root enumeration
  do not use the absence rule. Keep existing root preflight behavior and
  reparse/symlink exclusion unchanged. No retry, broad permission suppression,
  timeout change or replacement of the create-new publication contract occurs.
- Deterministic tests remove an enumerated temporary child and a queued child
  directory before the next operation, and preserve permission/invalid-input/
  other errors. A Windows-only native-code matrix accepts FILE_NOT_FOUND (2)
  and PATH_NOT_FOUND (3), while retaining access/sharing/network/invalid-name
  failures (codes 5, 15, 32, 33, 53, 67, 87, 123 and 4390). The
  existing 256-round updater concurrent publication test remains the native
  integration gate with exactly one winner; it is not reset or weakened.
- This is lower-layer-covered maintenance with no new UI journey. Native
  Windows execution remains required; portable helper tests do not establish
  Windows ACL API reachability or fix acceptance.


### CP-15 2e139861 macOS stable full profile passes after restore-cursor correction

- CI 34067205038 macOS stable job 101577953085 completes SUCCESS. Artifact
  desktop-e2e-macOS-34067205038-1 report binds
  2e1398619acd80c7d8192855cad8709d84ddf0b6, profile full, with 29 PASS
  and 3 EXPECTED_FORCE_TERMINATION phases. Cross-domain topology-force now
  reaches its intended process termination, and recovery/final restart pass.
- This verifies that candidate's retained macOS stable profile including the
  corrected pre-action restore cursor. Windows Chromium job 101577953053
  remains live in its shell E2E step at this observation. This is not paired
  full-candidate acceptance and does not include the later ACL repair.


### CP-04/CP-09/CP-15 2e139861 Windows topology seed and restart pass

- Windows Chromium job 101577953053 / CI 34067205038 report binds
  2e1398619acd80c7d8192855cad8709d84ddf0b6 with 32 PASS phases, including
  chromium-macro-cutover-topology-seed and topology-restart. This verifies
  the surviving-window post-close projection repair through the previously
  failing ownership transfer and process-restart journey on Windows.
- The next phase, chromium-macro-cutover-terminal-cleanup-seed, fails in
  startChromiumMacroVisible called from chromium-macro-cutover-cleanup.ts:166.
  It waits for Macro 47bfe998-144a-4506-9441-3660417f808b running after 104;
  the diagnostic reads empty Core statuses and a journal still at 105.
  Preserve this separate failure for exact effect/projection investigation.
  Full Windows parity and legacy-input deletion remain pending.

- Final ACL repair validation: macOS Rust lint and full workspace pass
  (1650 tests passed, 4 ignored) after the final native-code restriction.
  Vitest passes 452 files / 3642 tests in 159.78 seconds. ESLint, hygiene,
  typecheck through build, Tauri build, Electron production build and desktop
  E2E isolation pass. Windows API reachability and the unchanged 256-round
  concurrent publication gate remain pending the new candidate's CI. No
  local macOS or Windows desktop E2E profile ran for this lower-layer-covered
  adapter repair.


### CP-08/CP-09/CP-15 hidden Macro admission must preserve a background parent

- Inspecting 2e139861 terminal-cleanup flow distinguishes this failure from
  the earlier close-projection stall: macroStart 339 fails because browser
  action 2 is rejected with ELECTRON_VIEW_BACKGROUND_FOCUS_INVALID (341/343).
  No successful Macro admission exists, so waiting for running cannot succeed.
- The parent Role is in an inactive hidden View after a second Role launches
  into the same window. Starting from the main UI leaves that runtime parent
  in the background. Hidden admission never activates its parent/View, but
  still required parentForeground even after the underlying shared background
  input validator had gained verified background-parent support. This guard
  prevented a legitimate hidden Macro start before input delivery.
- Remove only the hidden admission's extra foreground-parent condition. Keep
  the exact identity, parent visibility/non-minimized state, attached View,
  hidden/nonfocused contents and focus-consistency validation. Visible View
  admission still requires exact parent and WebContents focus events; no
  parent activation, synthetic focus, retry or timeout change is added for
  hidden input. Existing input submission validates/preserves the foreground
  identity for every edge.
- The explicit macos/windows unit matrix first fails both background-parent
  cases, then passes after repair. It checks no parent/content focus call and
  rejects a hidden View claiming content focus. Related focus/runtime/probe
  tests pass 27 assertions. Extend the Windows native View-owner probe to run
  the production hidden admission before both key and middle-button samples
  under foreground and background parents, with a parent activation callback
  that throws if invoked. Native assertions require the admission receipt and
  the existing unchanged foreground/trusted DOM evidence.
- Affected existing journeys: CHROMIUM-MACOS-APPKIT-MACRO-TERMINAL-CLEANUP-006
  and CHROMIUM-WINDOWS-MACRO-TERMINAL-CLEANUP-006, both replacing the retained
  MACRO-TERMINAL-CLEANUP-006. Native terminal-cleanup seed/restart and full
  Windows acceptance remain pending the new candidate.

- Final local validation: 452 Vitest files / 3644 tests pass, including the
  focused 27-assertion focus/runtime/probe set. macOS Rust lint and workspace
  tests pass (1650 passed, 4 ignored). Typecheck, ESLint (23 existing warnings),
  full hygiene and coverage-manifest checks pass. Tauri build, Electron E2E
  build, restored production Electron build and production E2E isolation pass.
  No local desktop E2E profile or native input probe ran; the protected macOS
  dialog obstruction remains unresolved. Both native CI profiles and Windows
  terminal-cleanup seed/restart remain pending for this exact repair.

### CP-15 e85d2ea5 paired stable recovery acceptance

- CI 34067494537 stable jobs 101578732099 (macOS) and 101578732120
  (Windows) complete SUCCESS. Both downloaded desktop-e2e artifacts bind
  e85d2ea549fa93f96ddbe1813f10d6b5dc61eea1, runtime tauri-v22, profile full,
  with 29 PASS and 3 EXPECTED_FORCE_TERMINATION phases per platform.
  Force termination, crash restart/discard and final recovery complete as
  declared. This verifies the recovery activation assertion against committed
  Core definitions on both platforms (GAME-WINDOWS-TABS-001, APP-RECOVERY-001).
- The same candidate's Windows Chromium job 101578732049 still fails at
  terminal-cleanup-seed's Macro running assertion. It predates the hidden
  admission repair; stable acceptance does not establish Chromium parity.
- Hidden admission repair 7ec46086 is committed and pushed. Exact-source CI
  34068441192 is dispatched and pending; do not combine the older platform
  receipts into acceptance for that repair. The earlier ACL candidate CI
  34067927527 remains live and is neither cancelled nor restarted.

### CP-05 completion audit: Chromium font API adoption

- Re-inspected both original 8f474391 native reports, rather than inferring
  compatibility from source or aggregate CI success. Both bind Electron 43.4.1
  / Chromium 150.0.7871.224. macOS reports 528 faces / 180 families; Windows
  reports 260 faces / 89 families. Automatic enumeration succeeds without
  transient user activation, shown/reload results agree, and subframe, denied,
  navigated and other-owner queries each return zero families. The previously
  recorded native-name/CJK comparison and canonical-family decision stand.
- Re-ran current renderer font settings, shared browser-font helpers and
  Chromium provider tests: 3 files / 44 tests pass. Explicit darwin/AquaKana
  and win32/Fixedsys cases preserve saved selections absent from enumeration;
  generic/fallback handling and the authenticated provider remain covered.
- CP-05's adopt/retain experiment and decision are verified. This closes the
  assessment deliverable, not CP-06's production Windows Settings journey or
  CP-17's removal of the retained v22 provider. Those requirements and their
  original gates remain unchanged. No new UI behavior is introduced by this
  internal-only evidence reconciliation.

### Native hardware follow-up validation isolation — 2026-09-07

A root-worktree full JavaScript run during concurrent owner edits reports
465 passing files / 3771 passing tests, two failed files / three failures.
One failure is the old controlled-Role-reload source guard expecting an inlined
expectedWindowIdentifier in macos-appkit-ui.ts after 040aaedc moved focus to the
shared typed helper. The guard now follows that helper and retains the exact
native focused-window identity assertion. The other two failures are in
runtime-web-chrome.test.ts while an independent task changes the address
normalizer and displayed URL. Those unrelated source/test changes are preserved;
this session does not patch them or claim that root full run passed. Further full
validation uses the isolated worktree with this session's explicit file set.

The initial isolated full suite reports 465 passing files / 3772 passing tests
and two failures: the above source guard used the wrong spelling for the shared
focus call, and updater signer containment correctly rejects node_modules linked
outside the isolated checkout. The corrected guard follows the actual exact-PID
call. Independent in-checkout dependencies are required before repeating the
full suite; the signer containment assertion is not weakened.

The first native/Core-coherence edit used runtimeWindows instead of the typed
EmbeddedRuntimeState.windows member. Typecheck rejects that spelling. A hardware
run had already been launched concurrently before the failed typecheck result
was inspected; it is invalid validation and must not be treated as acceptance.
The field is corrected to windows and subsequent native dispatch must follow a
successful typecheck, not run concurrently with it.

Independent isolated installation now succeeds with pnpm install --offline
--frozen-lockfile (pnpm 12.3.4, Node 24.20.0). Typecheck and the 18 focused native
source/updater-signing cases pass. The subsequent complete isolated JavaScript
suite passes **467 files / 3774 tests**; no test is skipped or deadline extended
to resolve the earlier failures. Root-worktree concurrent changes remain outside
this test verdict. Swift native-controls typecheck and full source/docs/context/
Cargo-dependency/E2E-coverage hygiene pass; P0 70/70, P1 77/77 and both cutover
parity sets 41/41 remain unchanged.

Report 2026-09-07T14-21-13-714Z-darwin still catches logical maximized/native
normal at revision 25 after the renderer runtime-summary check. That summary
follows browser native slots, not the Kernel placement used by appSnapshot's
logicalWindows. The hardware completion predicate now uses the existing full
fullscreen-toolbar inspection to require Kernel/native presentation, generation,
revision and exact tab ownership together. It retains the original 45-second
bound and writes native-window-control-stages.json after each successful exact
state. This is an E2E completion correction, not a production polling mechanism
or a relaxation of the failing inspection. Acceptance remains pending.

### Physical fullscreen exit deadlock — 2026-09-07

Report 2026-09-07T14-26-06-731Z-darwin passes exact Kernel/native stages at
revisions 20 (secondary-display show), 22 (drag), 23 (resize), 24 (maximize),
25 (normal restore) and 27 (fullscreen). It then hangs while exiting fullscreen;
WebDriver readback/screenshot fail and the runner terminates the failed process.
This is not an expected-force-termination PASS.

A three-second sample of the exact isolated Electron PID 35768 is retained at
macos-takeover-8dff7722/macos-fullscreen-exit-hang.sample.txt. The main-thread stack
is NSWindow DidExitFullScreen -> Electron leave-full-screen ->
NativeAppKitRuntimeHost.prepare_fullscreen -> with_live_controller (mutex held)
-> prepareForFullscreenTransition:NO -> setStyleMask -> synchronous resize ->
Rust content-layout readback acquiring the same mutex. No permission prompt is
the cause.

AppKit's retained DidExitFullScreen observer already restores the windowed
chrome and publishes placement. The Electron leave-full-screen observer must
only read the resulting layout; its redundant prepareFullscreen(false) was a
second native mutation from inside the same OS notification. The fix removes
that redundant preparation, preserving AppKit ownership, native callbacks,
Rust projection authority and the separate failed-entry compensation path.
A focused behavioral regression models resize reentry while native preparation
is held: it fails before the correction; afterward 47 host/presentation tests
pass. The existing presentation test is updated to reject duplicate native
preparation after the exit event. Full native verification is pending; no
Windows CI is dispatched.

### Physical macOS display/control acceptance after fullscreen fix

Local report **2026-09-07T14-33-20-828Z-darwin**, Node 24.20.0,
chromium-v23-macos-appkit / chromium-macos-appkit-hardware-extended focused to
chromium-native-window-display-extended, passes **all three required phases**:
tabs-visible-seed, tabs-visible-restart and native-window-display-extended.
Every phase has exitCode=0, electronFinalFlush=true and electronProcessExited=true.
The report records HEAD 040aaedc plus this session's explicit working-tree fixes;
it is not a clean exact-SHA or complete inherited hardware-profile verdict.

Two real Studio Displays remain at scale 2: primary ID 2, secondary ID 3 with
bounds {x:2560,y:0,width:2560,height:1440} and work area
{x:2560,y:30,width:2560,height:1410}. No display mode is changed. Exact native
and Kernel control-stage evidence reaches revisions 20 (show), 22 (drag),
23 (resize), 24 (maximize), 25 (restore), 27 (fullscreen) and 29 (fullscreen exit).
The visible minimize action and exact native AXMinimized readback then pass.
No terminal-quit shortcut fixture replaces fullscreen exit or minimize.

The isolated complete JavaScript suite now passes **467 files / 3775 tests**.
The Electron E2E build/typecheck and complete hygiene pass. Native Rust lint
passes; full Rust test passes 1677 tests / 5 ignored across eight binaries,
retaining the updater concurrency gate. Latest-source full macOS regression
remains pending at this checkpoint. Prior 806ddb0a CI/package evidence remains historical after
this production fullscreen-exit fix. The focused hardware pass closes this
specific macOS physical display/control task, not real sleep/wake, all inherited
hardware phases, Windows acceptance or CP-17 production retirement.

Affected journeys: CHROMIUM-MACOS-APPKIT-NATIVE-DISPLAY-001,
CHROMIUM-MACOS-APPKIT-GAME-WINDOWS-NATIVE-001,
CHROMIUM-MACOS-APPKIT-FULLSCREEN-TOOLBAR-012, plus retained native tab driver
journeys CHROMIUM-MACOS-APPKIT-TABS-VISIBLE-ACTIVATION-019 and
CHROMIUM-MACOS-APPKIT-GAME-WINDOWS-TABS-020. Paired Windows journeys remain in
the manifest and are deferred to the Windows workstation; no Windows CI runs
are requested by this session.

### Exact 61f32424 regression and native divider follow-up

Commit **61f3242491d16a119acbd349b048278208f00098** is pushed and contains the
fullscreen-exit/native-control corrections, atop the independently committed
f99684f2 address-display/search feature. The clean isolated checkout passes
468 JavaScript files / 3803 tests. Mac-only CI **34133998284** targets that exact
SHA (manual platform_scope=macos); no Windows jobs are present. This is a new
regression for the concrete native fullscreen fix, not a retry of unchanged code.

The complete local inherited hardware profile report
**2026-09-07T14-37-48-363Z-darwin**, clean 61f32424, stops after 7 PASS and one FAIL:
chromium-workspace-web-slot-seed cannot discover the native AXSplitter through
System Events' list-based traversal (PENDING windows=Chromium Workspace Web
Window:95;:113; splitters empty). No divider drag is submitted by that failed
attempt. A typed exact-PID/AppKit-window AX traversal now finds the unique native
splitter without crossing AXWebArea; it checks Accessibility trust, object owner,
positive finite geometry and exact native-window focus. The existing OS hit-test,
real CGEvent drag and Core geometry/session/restart assertions remain intact.

With that E2E-only correction, focused report
**2026-09-07T14-43-04-481Z-darwin** passes all four prerequisites/target phases: entity-persistence seed/restart
and workspace-web-slot seed/restart, each with finalFlush=true and
processExited=true.
Typecheck, Swift typecheck and three focused source-boundary tests pass. This
focused result is not relabelled as a complete hardware-profile PASS. Affected
journeys are CHROMIUM-MACOS-APPKIT-WORKSPACE-WEB-SLOT-016 and its retained
native divider behavior; Windows companion acceptance remains deferred.

### Full-profile View-menu ownership follow-up

Commit **e627422e** is pushed with typed native divider discovery. Typecheck,
complete hygiene and lint pass (0 errors / 23 existing warnings); the complete
isolated JavaScript suite passes 468 files / 3803 tests.

Clean e627422e complete hardware report **2026-09-07T14-46-20-667Z-darwin** passes
15 phases, then fails chromium-fullscreen-toolbar-seed. Its View-menu helper
selects the first frontmost application without a Rion PID fence and errors
-1719 at the menu-bar operation. The helper now selects the exact probed Rion PID
through a retained process reference and activates only that process before
clicking the real View menu and existing preference item. The preference's Rust
persistence assertions are unchanged. Focused toolbar seed/restart acceptance is
pending; this complete profile remains a failure.

Focused report **2026-09-07T14-51-37-769Z-darwin** now passes toolbar seed and
restart with the exact-PID View-menu correction. Both phases retain their
persisted preference, native-toolbar geometry and terminal native-quit evidence.
This does not replace the separate physical display profile's successful normal
fullscreen exit/minimize. No permission grant, timeout or domain assertion is
changed; the production runtime remains identical to 61f32424.


### 61f32424 native/full CI completion and launcher focus ordering

Mac-only CI **34133998284**, exact checkout
**61f3242491d16a119acbd349b048278208f00098**, has successful native validation
101780741827, stable full 101780553465, shared checks, renderer build and sanitizer
jobs. Stable artifact **10023742160**, report **2026-09-07T14-38-40-942Z-darwin**,
has **29 PASS + three expected force terminations / 40 journey PASS** and
worktreeDirty=false. Chromium artifact **10023841493**, report
**2026-09-07T14-38-53-221Z-darwin**, has **56 PASS + four expected force terminations
/ 52 journey PASS**. Its worktreeDirty=true is the existing CI ephemeral updater
fixture preparation, not a clean production-key candidate. Package job
101780553083 has advanced to artifact construction; package/updater completion
is not yet claimed. No Windows job was dispatched.

Clean **a810af49** local complete hardware report
**2026-09-07T14-54-13-031Z-darwin** stops after two PASS at shell-smoke: the Swift
control helper reports no launcher AXWindows while opening the visible Open in
menu. Its native sample shows the main thread normally waiting in the AppKit
event loop, not the earlier fullscreen mutex deadlock. Diagnostic report
**2026-09-07T15-00-05-301Z-darwin** adds exact AX error/trust/PID output; it advances
past AXPress but the destination menu never becomes clickable within the original
10000 ms. Neither failure is labelled a permission problem or a passed profile.

The driver previously set DOM control focus, raised the launcher and then
activated all application windows before AXPress. Native activation now occurs
first, fenced to the exact PID and unique non-AppKit launcher AXWindow with
AXMain=true; only then does it set exact control focus. The redundant
activateAllWindows call is removed. Existing AXPress, physical CGEvent destination
click, trusted click receipts and all domain assertions remain. The root AX read
now preserves its exact error code and trust/process state instead of collapsing
all failures to an empty array; no retry or larger deadline is added.

Focused report **2026-09-07T15-02-46-550Z-darwin** passes shell-smoke after this
E2E-only correction, based on a810af49 plus the recorded helper edit. Typecheck,
source hygiene and focused Macro/application-shortcut boundary tests pass.
Production runtime content remains identical to 61f32424. This focused PASS does
not clear the failed complete hardware profile. Affected journeys include
CHROMIUM-MACOS-APPKIT-SHELL-001 and
CHROMIUM-MACOS-APPKIT-APPLICATION-SHORTCUTS-030; Windows behavior is unchanged and
its native acceptance remains with the separate workstation.


### 61f32424 package completion and typed native file-panel follow-up

CI **34133998284** is completed **SUCCESS**, including package job
**101780553083**. Exact checkout is 61f3242491d16a119acbd349b048278208f00098;
there are no Windows jobs. The log confirms the darwin packaged updater
transaction for 8.5.0 at 2026-09-07T15:21:17Z. Native validation has
1677 Rust PASS / 5 ignored and 14 native Electron PASS / two platform skips;
the full updater concurrency test remains intact.

Packaged black-box artifact **10024719890**, report
**2026-09-07T15-21-19-584Z-f30aae40-b672-4385-9b91-7dbc25f76881-darwin-packaged-black-box**,
records verdict=passed, exitCode=0, fixtureInteraction=visible-os-accessibility-click,
nativeHostKind=appkit-chromium and remoteDebugging=false. Executable SHA-256 is
e280954351cc587d7d8350372922d4c0e835f2c8fd8697cd3ebbb92dfed373b5;
app.asar SHA-256 is
6aa67186f268bfc14d35a06885737538e653b9f99a255f16572568027ab4b899.
These are existing ephemeral CI signing fixtures, not production-key migration
transactions, publication or CP-17 retirement authorization.

Clean **d14d203f044ccc5abed762c77496e4ffc6e35996** hardware report
**2026-09-07T15-04-41-665Z-darwin** reaches **38 PASS / one FAIL**. The new failure
is chromium-system-settings: the exact native save panel appears, but the old
System Events entire-contents traversal cannot resolve its Cancel button
(-2700). No cancellation or successful full profile is inferred.

The existing typed folder-panel helper is generalized as
macos-native-file-panel.swift with explicit select-directory and cancel modes.
Both modes discover only the exact app's attached AXSheet/AXDialog, retain the
bounded native traversal and exact AppKit XPC owner checks, and never enter
AXWebArea or enumerate unrelated processes. Cancellation requires one enabled
Cancel AXButton on the same attached panel, submits AXPress once and observes
panel closure within the unchanged deadline. The original directory selection
still uses visible Go to Folder, its exact field, Open and panel-closure checks.

Focused settings report **2026-09-07T15-15-21-611Z-darwin** stops before testing
cancellation: Courier New's menu option never appears after the picker click.
The screenshot shows a closed menu; the native font inventory assertion already
passed. This is not evidence that Courier New is missing. A passive click/hit/
focus/expanded-state diagnostic is retained. The next diagnostic settings report
**2026-09-07T15-45-51-961Z-darwin** passes, including typed native cancellation,
Core diagnostics export invocation count zero, finalFlush=true and processExited=true.
This does not prove the intermittent font-picker failure repaired. Its final
picker receipt has expectedTarget=false on click while aria-expanded=true and a
menu exists; do not treat that click receipt alone as proof the dropdown did not
open. Subsequent diagnostics retain each picker attempt instead of overwriting
one final receipt.

Focused import report **2026-09-07T15-46-57-735Z-darwin** passes both
chrome-profile-import seed/restart with the shared native panel helper. Each has
finalFlush=true and processExited=true. Swift and TypeScript checks, complete
hygiene, lint (0 errors / 23 existing warnings) and complete JavaScript validation
(**468 files / 3803 PASS**) pass. These focused reports use d14d203f plus the
recorded E2E edits, not a clean exact-SHA complete hardware verdict.

Affected journeys: CHROMIUM-MACOS-APPKIT-DIAGNOSTICS-EXPORT-029,
CHROMIUM-MACOS-APPKIT-SYSTEM-SETTINGS-013,
CHROMIUM-MACOS-APPKIT-FONT-APPLICATION-033 and
CHROMIUM-MACOS-APPKIT-CHROME-PROFILE-IMPORT-033. Changes are internal-only native
E2E driver/evidence work; product behavior, Windows implementation, deadlines,
coverage targets and domain assertions remain unchanged. Complete hardware
revalidation and real sleep/wake remain pending. API closure remains 9/18.


### 015dbaa2 product-source advance and exact lifecycle source boundaries

Independent owner commit **52cc4bb9e3ea4924848fed3371a739b2066c5bdd** adds Website
entrance and localized naming to both shells. It landed before this session's
**015dbaa22afa1ed148a1bf145ec6267f96594d35** native-file-panel commit. All owner
changes are preserved. The isolated checkout was advanced and rebuilt before
new native E2E; the old 61f32424 binary was not used to validate these product
changes. Other uncommitted owner assets in the root checkout remain untouched.

At 015dbaa2, Electron E2E build/typecheck, native Rust lint and the complete Rust
workspace suite pass: **1681 PASS / 5 ignored**, including the unchanged updater
concurrency gate. Complete hygiene passes. Initial complete JavaScript has
**3812 PASS / two FAIL** in tauri-system-runtime-source.part-2.test.ts.
Both failures are the blanket webView.URL token ban: the new BFCache event
callback reads that value to reject a mismatched main-frame message URL.

The callback and all product code remain unchanged. The source boundary now
requires one exact BFCache callback, its live lease/context, quiesce rejection,
exact WebView owner, main frame, restored message and event/current URL equality,
plus isolated-world trusted persisted pageshow registration. It forbids isolation
or release terminalization inside that callback and still forbids webView.URL
throughout the remaining source, including every close/quiesce path. Existing
loading/observer bans and event-bound terminal assertions remain. This separates
an event security fence from forbidden URL-based completion inference; it does
not admit polling or optimistic native completion.

The complete lifecycle test is moved to tauri-native-lifecycle-source.test.ts and
its shared assertion to tests/helpers/assertMacosLifecycleSource.ts to retain
the original 65536-byte source limit. No test case is removed. Fourteen focused
tests, source hygiene, targeted lint and the complete JavaScript suite now pass:
**471 files / 3814 PASS**. Full pre-extraction lint had 0 errors / 23 existing
warnings. This is internal-only source-boundary validation; no runtime behavior
or E2E journey is changed by the assertion correction.

Manual CI **34140329397** fails before checkout/build because this session passed
short input ref 015dbaa2: actions/checkout searched branch/tag names instead of
treating it as the full commit SHA. Native validation is dependency-skipped and
no Windows job exists. This is a dispatch-input error, not native product
failure or evidence. The corrected dispatch must use the complete 40-character
SHA after committing the source-boundary correction; do not rerun this failed
short-ref request. Complete local hardware acceptance remains in progress at
015dbaa2; source assertion edits do not change its runtime or E2E drivers.


### Complete macOS hardware profile — 2026-09-08 workstation time

Report **2026-09-07T15-51-31-568Z-darwin** completes the entire inherited
chromium-macos-appkit-hardware-extended profile with **57 PASS + four expected
force terminations / 54 journey PASS**. It starts from clean exact commit
**015dbaa22afa1ed148a1bf145ec6267f96594d35** and finishes at
2026-09-07T16:01:28Z. All 57 ordinary PASS phases have electronFinalFlush=true,
electronProcessExited=true and exitCode=0. No failed termination is reclassified.
The later a8fab843 commit changes only source tests and this ledger; runtime
and E2E content remain identical throughout this report.

This complete report includes system-settings diagnostics cancellation, font
application, Macro/native/background/standby/topology/terminal cleanup, mixed and
window recovery, native tabs seed/restart, visible consented Chrome Profile
import seed/restart and the actual secondary-display control phase. The earlier
intermittent closed font menu is not claimed repaired merely because this full
run passes; per-picker diagnostic evidence remains available for attribution.

The hardware phase uses two real Studio Displays at scale 2, with target display
ID 3. Its exact native and Kernel checks cover show (topology revision 20),
physical titlebar drag (22), resize (23), maximize, normal restore (24), fullscreen
(27), normal fullscreen exit (29), and visible minimize / AXMinimized readback.
Every stage retains display identity, scale, work area, owner and presentation
assertions. This completes macOS ordinary physical multi-display and the complete
hardware profile, not the owner-removed physical mixed-DPI task, actual machine
sleep/wake, Windows, production-key transactions or Tauri retirement.

Corrected macOS-only CI **34140975454** binds full source
**a8fab843815739b98fb3d7d7fb6def6b82bc58cf**. The exact checkout succeeds;
renderer assets 101802662328 pass. Shared checks 101802662640, sanitizer
101802662530, native validation 101802824934, stable full 101802662673 and
Chromium/package 101802662653 are in progress at this checkpoint. No Windows
job exists. Current local complete hygiene passes; production build/isolation
verification follows the completed native profile without touching the owner's
root development output.


After the complete local native profile, **a8fab843** passes both Tauri/renderer
production build (`pnpm run build`) and Electron production build, followed by
`pnpm run check:desktop-e2e-isolation`. Output is restored to production only in
the isolated worktree; the owner's root development process/output and ongoing
Workspace asset work are preserved. No production runtime changes follow
015dbaa2 in this session. Real sleep/wake is not performed: the earlier owner
availability question has no answer, and simulated standby is not substituted.
The full API objective remains incomplete at 9/18; no protected Tauri code,
release gate, credential or published state is removed or changed.


### Font-picker failure attribution audit — 2026-09-08

All six picker attempts in complete report 2026-09-07T15-51-31-568Z-darwin have
hasFocus=true and hitMatches=true before the WebDriver click, then
aria-expanded=true and one visible menu. Their subsequent click receipts target
HTML rather than the trigger. The installed @radix-ui/react-dropdown-menu
**2.1.24** source opens the menu from its trigger's onPointerDown; click is later
in that gesture. Thus a click-target mismatch is insufficient to diagnose a
missed dropdown activation. It is not the authoritative event that opens this
control. No production code is changed on that inference.

The failed 2026-09-07T15-15-21-611Z run has no equivalent pointerdown/focus receipt,
so the audit cannot retrospectively prove a specific input or focus cause.
The closed-menu screenshot and original 10000 ms failure remain preserved.
Any future recurrence should capture pointerdown, focus and open-state evidence
before deciding a correction; do not repeat unchanged runs to relabel this
failure or weaken its font/menu/domain assertions.


### a8fab843 native and stable CI completion — 2026-09-08

CI **34140975454** native job **101802824934** completes successfully: Rust lint,
**1681 Rust PASS / 5 ignored**, native Electron **14 PASS / two platform skips**,
and the native Tauri build pass. The unchanged updater concurrency gate remains
part of the complete Rust result. Shared checks, renderer and sanitizer/soak also
pass; no Windows job exists.

Stable desktop job **101802662673** succeeds. Artifact **10026325981**, report
**2026-09-07T15-59-07-542Z-darwin**, is exact clean
**a8fab843815739b98fb3d7d7fb6def6b82bc58cf**, tauri-v22 full profile:
**31 PASS + three expected force terminations / 40 journey PASS**. The two extra
ordinary phases cover the Website entrance extension to the stable profile;
the historical 29-PASS count must not be copied to this source. Chromium/package
job 101802662653 remains in progress at this checkpoint; package/updater success
at 61f32424 is still historical for the newer product source.


### Latest grouped-Website source acceptance — 2026-09-08

The independent owner commit 486e0842 was preserved before the documentation
commit 1f186739. It changes the shared Website catalog/categories, renderer
picker and bundled start page; the only Rust change extends the stable Website
E2E fixture. Neither old binaries nor the a8fab843 CI are relabelled as this new
source. All following local checks use an isolated clean checkout of exact
**1f186739135db07853e7c9e970f1db5ab8dabd00**, pinned Node 24.20.0.

- Full JavaScript: **472 files / 3833 PASS**; complete hygiene and Rust lint PASS.
- Electron E2E build PASS, followed by actual visible/native focused replay.
- Report **2026-09-07T16-23-30-795Z-darwin**: entity persistence seed/restart and
  Workspace Web slot seed/restart, **four PASS**. Journeys:
  CHROMIUM-MACOS-APPKIT-ROLE-PERSIST-003,
  CHROMIUM-MACOS-APPKIT-WORKSPACE-PERSIST-004,
  CHROMIUM-MACOS-APPKIT-MACRO-PERSIST-005 and
  CHROMIUM-MACOS-APPKIT-WORKSPACE-WEB-SLOT-016.
- Report **2026-09-07T16-24-21-899Z-darwin**: Web-only seed/restart,
  **two PASS**. These preserve empty Role topology, grouped start-page content,
  visible failure recovery and restart persistence. Journey CHROMIUM-MACOS-APPKIT-WORKSPACE-WEB-ONLY-024 passes;
  native/Core receipts remain in report.json.
- These are focused affected-source results, not a replacement for the latest
  complete profile. No deadline, assertion or selected phase dependency changes.

Earlier-source CI 34140975454 artifact **10026513038** now confirms report
**2026-09-07T15-59-40-012Z-darwin**, a8fab843, chromium-macos-appkit-smoke:
**56 PASS + four expected force terminations / 52 journey PASS**. Its dirty flag
is true during ephemeral updater-fixture preparation, as in the previous CI
run; this is recorded rather than described as a clean local build. The job
advances to macOS release artifact construction. Its package/updater result is
still pending at this checkpoint.

After checking existing runs and finding no latest-source run, macOS-only CI
**34143187025** was dispatched with immutable full ref
1f186739135db07853e7c9e970f1db5ab8dabd00. This covers newly changed product source;
it is not an unchanged failure rerun. It neither dispatches Windows acceptance
nor cancels the different-source a8fab843 run. Production output restoration and
latest Rust test results are recorded below when completed.


Latest-source Rust tests complete **1681 PASS / five ignored**, with all eight
workspace test binaries successful and the updater 256-round concurrency test
unchanged. All six focused native phases have exitCode=0,
electronFinalFlush=true and electronProcessExited=true; no forced termination
or missing terminal receipt is hidden in those PASS results. Both Tauri/renderer
production build and Electron production build pass for 1f186739 in the isolated
worktree. The root development process/output remain untouched.

Production E2E isolation also passes after both builds. Full lint completes with
zero errors / 23 existing warnings; documentation and AI-context validation pass.
These log files are retained under
.desktop-e2e-artifacts/macos-takeover-8dff7722/macos-1f186739-*.log.
No real sleep/wake, Windows execution, credential change, publication, promotion
or protected runtime deletion is performed. API closure remains **9/18**.


### Release-context consistency correction — 2026-09-08

The final release audit found stale wording in the updater transaction contract
and its AI release context: they described the hard-disabled draft's private
store, separate Apps and environments as unconditional infrastructure needs.
This contradicted the owner's 2026-09-06 v22 reuse/final-delta decision already
recorded in the migration execution ledger. The contract now distinguishes
current draft prerequisites from approved product requirements; the context
links that policy instead of imposing duplicate configuration rules.

This does not enable the draft, modify credentials/settings, authorize public
mutation, or waive verified authority, independent recovery drill, real updater
transactions or terminal promotion. Existing v22 authority must actually satisfy
the invariants before any equivalent configuration can be accepted. CP-16/17
remain open. E2E omission: **internal-only**, documentation consistency only;
no product, executable workflow, manifest or journey behavior changes.

The documentation correction passes complete hygiene, documentation/context
checks, all **472 JavaScript files / 3833 tests**, and full lint with zero errors
/ 23 existing warnings. Runtime source remains identical to CI input 1f186739.
At the follow-up observation CI 34140975454 is live in previous-version updater
fixture construction; CI 34143187025 has renderer and sanitizer/soak success,
with native Rust, shared checks, stable full and Chromium/package jobs still
live. Neither run has been restarted or treated as terminal on observation delay.


### 1f186739 native CI receipts — 2026-09-08

CI **34143187025**, exact source
**1f186739135db07853e7c9e970f1db5ab8dabd00**, completes native job
**101809598811** successfully. The downloaded ci-1f186739-native.log confirms
**1681 Rust PASS / five ignored**, **14 native Electron PASS / two platform
skips**, Rust formatting/clippy and the target-platform Tauri build. No updater
concurrency assertion or ignored-test policy changed. This is current-source
macOS native acceptance; Windows remains delegated to its later workstation.

Shared checks **101809468356** also succeed. The hosted Linux JavaScript result
is **470 passing files / two skipped files; 3824 PASS / nine skipped tests**.
It is distinct from the complete physical-Mac result of 472 files / 3833 PASS.
The Linux portable Rust result is 977 + 24 PASS / one ignored; it is not the
native workspace count above. Renderer and sanitizer/soak jobs pass as well.

Artifact **10026691318**, chromium-input-macos-latest-34143187025-1, records
24 received input outcomes on Electron 43.6.0 / Chromium 150.0.7871.250, including
foreground, modifiers/repeat, middle button at zoom, reload and hidden/background
host and sibling cases. Its scope explicitly says isolated WebContentsView API
probe, not a Role/native-adapter receipt. It does not authorize removing AppKit
trusted input or replacing full Macro evidence. Artifact **10026947083** retains
the paired current-source macOS local-font probe.

At this checkpoint the exact-source stable full and Chromium/package jobs are
still live. Earlier a8fab843 CI 34140975454 is also live, building previous-version
updater fixtures. Observation intervals do not imply failure or completion;
neither run is restarted. Runtime and E2E source after 1f186739 are unchanged by
the intervening documentation commits. API closure remains 9/18.


### 1f186739 stable full and font-provider acceptance — 2026-09-08

CI **34143187025** stable desktop job **101809468337** completes successfully.
Artifact **10027155344**, desktop-e2e-macOS-34143187025-1, contains report
**2026-09-07T16-26-19-087Z-darwin**: exact clean
**1f186739135db07853e7c9e970f1db5ab8dabd00**, profile full / tauri-v22,
started 16:26:20.261Z and finished 16:43:33.731Z on 2026-09-07 UTC.
It records **31 PASS + three expected force terminations / 40 journey PASS**.
The expected-force phases remain p1-cross-domain-topology-force,
force-terminate and crash-restart. This verifies the retained stable shell on
the latest grouped-Website source; it does not retire that shell.

The downloaded current-source font artifact **10026947083** records 180
production font families, an identical family set after reload, empty data for
other-owner/subframe/denied requests, and rejection of the retired-document
request after navigation. Raw enumeration records 528 faces on admitted main
frames and zero for rejected boundaries. This supports CP-05/06 provider parity;
it is not evidence that the earlier intermittent closed font-picker menu has
been repaired. Provider permission/data ownership and visible-menu activation
are distinct behaviors.

Chromium/package job **101809468475** remains live in its complete AppKit E2E
step. Earlier-source package job **101802662653** remains live in previous-version
fixture construction. Both existing watch processes are retained; no retry,
new dispatch, deadline change or simulated physical evidence is introduced.
API closure remains **9/18**. Windows, real sleep/wake and production cutover
requirements remain separate and open.


### Latest full Chromium completion and earlier updater cleanup failure — 2026-09-08

CI **34143187025** artifact **10027197794**, report
**2026-09-07T16-26-39-813Z-darwin**, verifies exact
**1f186739135db07853e7c9e970f1db5ab8dabd00**, profile
chromium-macos-appkit-smoke: **56 PASS + four expected force terminations /
52 journey PASS**. Its worktreeDirty flag is true during ephemeral fixture
preparation. The job advances through package construction to previous-version
fixture construction; package/updater is not yet complete.

Earlier-source CI **34140975454** is now terminal **FAILURE**. Job
**101802662653** passes package build, prior-version fixtures, extension isolation,
runtime/ABI, package structure and distribution payload verification, then fails
**Verify packaged macOS Rust-owned updater transaction** at
**2026-09-07T16:46:20Z**. Packaged AppKit Role black-box is skipped as a dependent
step, not accepted. The original ci-a8fab843-package.log is retained locally.

The error is "Darwin returned malformed process-group state", caused by
kill EPERM. The stack is isDarwinProcessGroupAlive -> waitForProcessGroupExit ->
terminateDetachedDarwinProcessGroup -> captureFailure, during exact detached
Cargo-group cleanup. The existing diagnostic discards the rejected ps row,
so it does not identify whether the invalid field was PID, PGID, UID or state.
No missing field is guessed and no failed cleanup is relabelled active-zero.

The diagnostic correction retains the original EPERM cause and adds a frozen,
bounded processGroupObservation: exact requested group ID, the original rejected
row (maximum 256 characters), truncation flag, field count and row count. The ps
query still requests only pid/pgid/uid/stat, not command arguments or environment.
It does not reread a newer snapshot after rejection. Every existing liveness,
malformed/foreign-group rejection and deadline is unchanged; no permission error
becomes absence and no unknown state becomes successful cleanup.

Apple's [ps state formatter](https://github.com/apple-oss-distributions/adv_cmds/blob/main/ps/print.c)
and [Mach state table](https://github.com/apple-oss-distributions/adv_cmds/blob/main/ps/tasks.c)
show that its display state is not simply an uppercase state plus flags; an
unknown Mach state can be displayed too. That is one reason to retain the actual
row, not proof that this CI failure contained an unknown state. The old failure
remains unclassified until equivalent native evidence identifies the field.

Two diagnostic regression cases fail against the unmodified helper (12 PASS /
two FAIL), then the corrected helper and adjacent cleanup suite pass **18 tests**,
including the real macOS zombie-group case. Full JavaScript passes **472 files /
3835 tests**, full hygiene passes, and lint has zero errors / 23 existing warnings.
This is **internal-only** validation-tool observability, not a user-visible runtime
change or repaired packaged transaction. No extra CI has been dispatched for it
while the already-running 1f186739 package job remains live. AppKit/Rust authority,
Windows deferral and every update/retirement gate remain intact; closure is 9/18.


### Bounded Cargo-group reproduction and diagnostic-source CI — 2026-09-08

A standalone physical-Mac reproduction uses **32 exact owned detached groups**,
eight orphan workers each, with the group leader reaped before SIGTERM and at
most 16 liveness observations per trial. Every trial ends with an absent group;
no EPERM or malformed snapshot is observed. The fixed trial count is not repeated
until a desired outcome. Source, executable and every observation are retained
in .desktop-e2e-artifacts/macos-takeover-8dff7722/group-exit-reproduction/.
This negative result does not reproduce or fix the CI cleanup failure, and it
does not establish packaged updater success.

After confirming no existing run for the diagnostic source, macOS-only CI
**34145679440** is dispatched at exact
**90614cef1864de09b75a39b36a15de56b1a4d4f9**. Its purpose is to retain the original
rejected ps row if the native packaged failure recurs, using the already-tested
bounded observation field. The original 1f186739 run **34143187025** continues
in previous-version fixture construction and is not cancelled or restarted.
No Windows acceptance job is dispatched. This is a changed-observability run,
not a retry used to claim a repaired transaction; a green result alone cannot
close the unexplained a8fab843 failure. Liveness conditions, deadlines, primary
errors and cleanup gates remain unchanged. The task remains open at 9/18.


### 1f186739 full CI completion and retained updater discrepancy — 2026-09-08

CI **34143187025** is terminal **SUCCESS**, exact source
**1f186739135db07853e7c9e970f1db5ab8dabd00**. Package job **101809468475** passes
its package/payload verifiers, Rust-owned packaged updater transaction and native
packaged AppKit Role black-box. The log records "Verified darwin packaged updater
transaction for 8.5.0" at **2026-09-07T17:11:32Z**. These are existing ephemeral
fixture transactions, not production-key publication or the four-cell cutover.

Artifact **10027869820**, report
**2026-09-07T17-11-34-252Z-ee40f177-7420-4a95-850c-296764c582a7-darwin-packaged-black-box**,
is passed / exitCode=0, visible-os-accessibility-click, appkit-chromium,
remoteDebugging=false. Executable SHA-256:
c85c757ce2b8e82cfaa196b74990b3365bd9fe0a162e3cec74b353dd14c20a9a;
app.asar SHA-256: 335f9510b55245d716d593700d834f70e4c0478f588960e0da4e589378ba6b63;
native addon SHA-256: 739c2bda059188b8b10e962fb6a7026a663d784711018c306b1f04ad92e6acf8.

This successful later run does not explain the a8fab843 EPERM/malformed-group
failure. Diagnostic-source run **34145679440** continues at 90614cef. No original
failure is removed or changed to PASS, and no production/migration gate is waived.

### Current-source local hardware attempt: service ordering and native foreground

To replace the earlier 015dbaa2 physical profile with a current-source receipt,
a clean isolated **90614cef** Electron E2E build precedes one full
chromium-macos-appkit-hardware-extended attempt. Report
**2026-09-07T17-08-56-017Z-darwin** fails its first extensions seed phase at the
original 30000 ms wait for the new Role's loaded extension. Installation and
visible Role creation complete; Core admits launch, creates its tab and submits
nativeWindowTransition mode=focus. The only native state receipt is show with
focused=false. No successful final flush is claimed; shutdown correctly refuses
to release the still-nonterminal browser-operation lease. Ordinary physical
controls and the rest of this full attempt are NOT_RUN, not passed.

The WDIO log also contains a definite prior setup failure:
"Cannot set properties of undefined (setting 'windowHandle')" at
wdio.electron.conf.ts:102. The Electron service and configuration before hooks
execute concurrently. The configuration consumes browser.electron before the
service attaches it, and consequently never prepares native failure sampling.
Inspection of the successful 1f186739 Chromium artifact finds the same hidden
setup error in 31 phase logs; their actual journey assertions still passed, but
those results do not prove setup/sampler readiness.

The correction leaves the independent script-timeout setup in before and moves
Electron-dependent launcher selection and sampler preparation to the first
beforeSuite, after Runner awaits all before hooks and starts Mocha. A one-time
flag prevents nested suites from stealing a journey's active target. No polling,
extra deadline, forced activation, input substitution or domain assertion change
is introduced. Two explicit darwin/win32 mocked lifecycle cases fail before the
correction and pass after; the adjacent window-selector cases total five PASS.
The WDIO runtime config is loaded through Vitest's runtime loader in the unit
test rather than added to the node project's static module graph; Electron's
service type augmentation is imported explicitly.

Focused report **2026-09-07T17-20-20-264Z-darwin** confirms sampler preparation
and captures PID **79655**. It still fails the same original Role-loaded wait;
the main-thread sample is a normal AppKit event-loop wait, not a mutex deadlock.
The setup correction therefore is not described as a fix for that focus failure.

A read-only native observation is then added before and after the visible Open
operation, with no activation or AX action. Report
**2026-09-07T17-23-44-827Z-darwin** captures target PID **79874** inactive before
and after launch, while **com.apple.UserNotificationCenter, PID 10663**, remains
the native foreground application. Chromium document.hasFocus() is true despite
that native state. AX access is trusted and succeeds; the new exact AppKit
runtime window exists with AXMain=true and AXFocused=false. This is not evidence
of missing Accessibility permission. The original 30000 ms failure is retained.
No protected system-application UI content is read or manipulated; the owner is
asked for any visible system prompt text and buttons. New foreground validation
is paused pending that information/state change, while non-GUI work and existing
CI continue. Real sleep/wake remains separately unperformed.

Affected journeys: CHROMIUM-MACOS-APPKIT-EXTENSIONS-001 and
CHROMIUM-WINDOWS-EXTENSIONS-001; the hook correction applies to Chromium profile
initialization generally. This is **internal-only** test-driver/diagnostic work,
with user actions and all existing domain assertions retained. Windows native
acceptance remains assigned to the later workstation. Swift diagnostic typecheck
and actual readback succeed; complete local JavaScript passes **473 files / 3837
tests**, typecheck and hygiene pass, and lint has zero errors / 23 existing warnings.


### Service-order correction validation and 90614cef CI receipts — 2026-09-08

The owner reports that no system prompt is currently visible or it has been
closed. A subsequent read-only NSWorkspace foreground identity query still
returns com.apple.UserNotificationCenter / PID 10663. No system prompt content
is inferred from that identity, and no protected UI is read or manipulated.
The discrepancy remains recorded instead of retrying the same native focus
failure unchanged. Actual sleep/wake remains a separate unperformed gate.

The corrected WDIO lifecycle and diagnostics pass the focused five tests,
complete JavaScript suite (473 files / 3837 tests), typecheck, hygiene and lint
(zero errors / 23 existing warnings). Documentation, AI context and coverage
checks pass; P0 70/70, P1 77/77 and both Chromium parity sets 41/41 remain intact.
The isolated worktree initially retained the earlier literal-import test copy,
causing TS6307/TS2339 during production restoration. After copying the already
corrected runtime-loader test and explicit service type import, the complete
renderer/Tauri build and Electron production build pass, followed by production
E2E isolation. Logs are macos-service-order-production-build-final.log,
macos-service-order-electron-production-build.log and the adjacent service-order
validation logs under .desktop-e2e-artifacts/macos-takeover-8dff7722/.
The root development outputs and independently running owner application are
untouched. This is source 90614cef plus the recorded local test-driver patch,
not a clean committed full-hardware receipt.

Diagnostic-source CI 34145679440 supplies two exact-source reports:

| Artifact / report | Source and profile | Observed result |
| --- | --- | --- |
| 10028091987 / 2026-09-07T17-00-31-100Z-darwin | 90614cef1864de09b75a39b36a15de56b1a4d4f9; chromium-macos-appkit-smoke; worktreeDirty=true during fixture preparation | 56 PASS + four EXPECTED_FORCE_TERMINATION; 52 journey PASS; every ordinary phase has final flush and process exit |
| 10027918461 / 2026-09-07T17-00-01-325Z-darwin | Same exact source; stable full / tauri-v22; worktreeDirty=false | 31 PASS + three EXPECTED_FORCE_TERMINATION; 40 journey PASS |

Native job 101817239355 is SUCCESS. Its complete downloaded job log confirms
**1681 Rust PASS / five ignored** and **14 Electron native PASS / two platform
skips** (six passing native files / two skipped files), with Rust lint and the
target-platform Tauri build successful. The source log is retained as
.desktop-e2e-artifacts/macos-takeover-8dff7722/ci-90614cef-native.log.
Package job 101817105602 is still building
previous-version updater fixtures at observation time, so package/updater is
not accepted for this run yet. These reports contain the prior WDIO hook;
they cannot establish native-driver setup for the local correction. Windows
native execution remains deferred to the owner's workstation. No failure,
production transaction or retirement gate is closed from these partial results.


### 90614cef complete package acceptance and service-order candidate — 2026-09-08

CI **34145679440** is terminal **SUCCESS** for exact
**90614cef1864de09b75a39b36a15de56b1a4d4f9**. Package job **101817105602**
records "Verified darwin packaged updater transaction for 8.5.0" at
**2026-09-07T17:44:54Z**, then passes the packaged AppKit Role black-box.
The complete job log is retained as ci-90614cef-package.log. No rejected
processGroupObservation or malformed-group error occurs in this run. This
successful observation therefore does not explain or repair the earlier
34140975454 / a8fab843 failure; its exact rejected row remains unavailable.

Artifact **10028650298**, report
**2026-09-07T17-44-56-386Z-f13b0f69-f950-4f07-89bc-9062f1e30a3d-darwin-packaged-black-box**,
records passed / exitCode=0, visible-os-accessibility-click, appkit-chromium,
remoteDebugging=false and appVersion=8.5.0. Its screenshot visibly retains the
AppKit window controls and tab strip above the Chromium Role fixture.

| Package identity | SHA-256 |
| --- | --- |
| Executable | 1f424498deb17183f295938d7590fb6a899ee7eeb51d4022759cb04294b94ed2 |
| app.asar | 335f9510b55245d716d593700d834f70e4c0478f588960e0da4e589378ba6b63 |
| Native addon | 2663b3b09fe9104ed6f098911774f0d12c2e16d68d6850fbdb1df33f6bb9f382 |
| Package manifest | 98b3bc07acacf7e8bb940ed44141a28d1b469ed3e7965a44c279549c8ddafa81 |

The prior watcher exits successfully and is not restarted. After confirming no
run already exists for the changed test-driver source, macOS-only CI
**34149031009** is dispatched for complete SHA
**b8bae38bb10acb1e6d295c027c100d7267803815**, containing the **8d68be93** service-order
correction. Its purpose is full native/profile validation of that correction,
including checking phase logs for the previously hidden before-hook exception.
This is a changed-source validation, not a same-source retry of the updater
failure. Later evidence-only documentation commits do not create a new runtime
candidate or justify another dispatch. No Windows acceptance job is requested.

On the local workstation, selecting Finder and using its accessible menu does
not change NSWorkspace's foreground identity from UserNotificationCenter / PID
10663. The background Finder menu is cancelled through its exposed Cancel action;
no protected system-application content is read or acted on. The owner is asked
to manually switch to Finder or the desktop and report the result before another
foreground-dependent hardware attempt. No local replay is repeated with the
same unresolved precondition. Sleep/wake, Windows workstation acceptance, the
four production updater transactions and gated retirement remain open. Closure
is still **9/18**.


### Service-order candidate: shared checks and stable full — 2026-09-08

CI **34149031009** remains bound to
**b8bae38bb10acb1e6d295c027c100d7267803815**. Shared checks job **101827170345**
is SUCCESS: **471 passing files / two skipped files, 3828 PASS / nine skipped
JavaScript tests**. The two explicit darwin/win32 service-order cases pass in
that complete suite. Typecheck passes, and lint has zero errors / 23 existing
warnings. The downloaded source log is ci-b8bae38b-checks.log under the takeover
artifact directory. These Linux-hosted checks are not native Windows acceptance.

Stable macOS full job **101827170370** is SUCCESS. Artifact **10029006584**,
report **2026-09-07T17-48-03-669Z-darwin**, binds the complete b8bae38b source,
worktreeDirty=false, full / tauri-v22, with **31 PASS + three expected force
terminations / 40 journey PASS**. It runs from 2026-09-07T17:48:04Z through
18:02:00Z. The report has no other phase verdict. It is retained in
ci-b8bae38b-stable under the same artifact directory.

Native job 101827298150 has passed Rust lint/test and Electron native probes,
and is building the target-platform Tauri shell at this checkpoint. Complete
native totals will be bound to its final log rather than copied from the prior
source. Chromium/package job 101827170427 remains in its full Chromium E2E step;
its before-hook repair, full profile and package/updater are not yet accepted.
No Windows job, new source dispatch or local foreground replay is started.


### Service-order candidate: native/full Chromium accepted — 2026-09-08

CI **34149031009** native job **101827298150** is now SUCCESS at exact b8bae38b.
Its complete ci-b8bae38b-native.log confirms **1681 Rust PASS / five ignored**,
**14 Electron native PASS / two platform skips**, Rust lint and the target-platform
Tauri build. These are this job's observed totals, not inherited counts.

Chromium artifact **10029068885**, report
**2026-09-07T17-48-13-518Z-darwin**, binds
**b8bae38bb10acb1e6d295c027c100d7267803815**, chromium-macos-appkit-smoke,
worktreeDirty=true during fixture preparation. It runs from 17:48:13Z to
18:04:46Z on 2026-09-07 and passes **56 ordinary phases + four expected force
terminations / 52 journeys**. Every ordinary phase records final flush and
process exit. The actual source pin and WDIO logs identify Electron **43.6.0**;
the earlier 43.4.1 research baseline is historical.

All **60 phase log sets** contain exactly one "Native failure sample target
prepared" message. None contains the original undefined-windowHandle exception,
"Native failure sample preparation unavailable", or the prior before-hook error.
Together with the complete successful journeys, this establishes the 8d68be93
service-order correction on native macOS. It does not establish Windows native
acceptance, physical hardware replay or a current packaged transaction.

The extension Open observations provide a useful comparison with the failed
local run: CI's exact Electron PID **4739** is active and owns native foreground
both before and after the action, and the Role-loaded journey passes. Its
runtime window is
com.rionstudio.runtime.appkit-window.v1:2eb80c93-5f10-4d4f-b249-82953ed19eb8.
AXFocused is false in this successful run too. That individual AX attribute
therefore cannot independently establish a focus failure; distinguish it from
NSWorkspace foreground identity, targetActive and authoritative journey results.
The failed local PID 79874 was inactive with UserNotificationCenter foreground,
and that discrepancy remains unresolved. No native success is inferred merely
from renderer document.hasFocus().

The current Chromium job has advanced to release artifact construction. Its
package/updater and packaged black-box remain pending until their own terminal
receipts. Later documentation-only commits do not trigger another same-candidate
run. No user action, assertion, deadline or platform gate is weakened; the
API-ledger count remains 9/18.


### b8bae38b complete CI and remaining external gates — 2026-09-08

CI **34149031009** is terminal **SUCCESS**, exact candidate
**b8bae38bb10acb1e6d295c027c100d7267803815**. Every listed job succeeds; no
Windows acceptance job was dispatched. Package job **101827170427** verifies
package structure, runtime/native compatibility, extension persistence and
payloads, then records "Verified darwin packaged updater transaction for 8.5.0"
at **2026-09-07T18:21:35Z**. Its complete log is ci-b8bae38b-package.log under
.desktop-e2e-artifacts/macos-takeover-8dff7722/.

Artifact **10029447207**, report
**2026-09-07T18-21-37-032Z-669bb645-d20e-4d0f-856b-dfb3befad51e-darwin-packaged-black-box**,
records passed / exitCode=0, visible-os-accessibility-click, appkit-chromium,
remoteDebugging=false and application 8.5.0. The recorded identities are:

| Package identity | SHA-256 |
| --- | --- |
| Executable | e57c0a971e6f41a1064e8057b17af1683a79253248e1c3aaf2afe2a0d1ed4092 |
| app.asar | 335f9510b55245d716d593700d834f70e4c0478f588960e0da4e589378ba6b63 |
| Native addon | 2cd5985327b2d1e1be61177a27416bf76920df0485dd9d565cd171704d5594df |
| Package manifest | b75dc142f775a7453ab6079eb465c167df98a29fbe2bcc7b9661e3ada5b13396 |

This log contains no rejected processGroupObservation or malformed-group error.
The successful run does not retrospectively explain the a8fab843 failure.
The original error, bounded unsuccessful reproduction and diagnostic correction
remain recorded. No unchanged source is dispatched again to seek a different
outcome. The completed watcher exits zero and is not restarted.

A further ordinary application-switch shortcut through Computer Use does not
change local NSWorkspace foreground from UserNotificationCenter / PID 10663.
No protected system UI is inspected, dismissed or accepted. The owner's report
of no visible prompt remains distinct from the observed native foreground state.
Manual switching to Finder/desktop is still awaited before another physical
profile; no identical local failure is rerun. Current evidence does not prove
all requirements complete:

| Remaining scope | Missing evidence or external condition |
| --- | --- |
| Current-candidate macOS physical replay, CP-04/11/12/15/18 | Restore an ordinary foreground session, then run the complete hardware profile with normal terminal receipts. The complete 015dbaa2 physical run remains historical; the later failed local attempts remain failures. Physical mixed-DPI is removed by owner decision. |
| Actual power/lifecycle, CP-12 | A coordinated real sleep/wake session and its authoritative runtime/terminal receipts. Serialized injected lifecycle events and CI success do not replace it; no sleep is initiated while owner coordination is pending. |
| Windows workstation, CP-04/08/10/11/12/15/16/18 | Execute the seven ordered Windows handoff workstreams above on the owner's other workstation, including full JS, native, full profiles, visible import, ordinary physical input/display/session-end and install/update evidence. No Windows CI acceptance is initiated from this Mac. |
| Production update/cutover, CP-16/17/18 | The four real production updater transactions, terminal promotion, final v22 configuration delta and exact-candidate platform evidence remain separate gates. Existing fixture signatures do not establish production-key cutover. Publication, merge, credentials and protected runtime removal remain unauthorized. |

Both handoff ancestors (8dff7722462f51d5407cf520bc7d37629829ede9 and b0c3c184)
remain in current history, and the preserved graphics branch still exists.
The branch changes after b8bae38b affect only this evidence ledger, so they do
not invalidate the fixed runtime/test candidate or justify new CI. AppKit and
Rust data/topology/Macro authority remain intact. API closure remains **9/18**;
no completion or Tauri retirement is inferred from the fully green macOS run.
