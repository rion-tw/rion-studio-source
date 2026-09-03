# Desktop E2E and AI Development Strategy

`docs/e2e-coverage.json` is the versioned source of truth for desktop user-journey
coverage. Coverage is measured by product journeys, not bridge methods or source
lines. The targets declared in the manifest are authoritative and must not be
lowered without owner approval. Every product feature listed in the manifest
must have an automated UI happy path.

The manifest binds every profile to one runtime target. The current `smoke`,
`full`, and `extended` evidence belongs only to the `tauri-v22` compatibility
runtime; it is not Chromium cutover evidence. Chromium v23 has two deliberately
separate required targets: `chromium-v23-macos-appkit` proves the retained AppKit
window/tab/input/fullscreen host with embedded Chromium, while
`chromium-v23-windows` proves the Windows Electron/Chromium host. Profiles may
inherit phases and specs only within the same runtime target, so a v22 result or
a Windows result can never silently establish the macOS AppKit verdict.

Chromium parity is accounted separately from aggregate coverage. A v23 journey
may claim a v22 equivalent only through its explicit `replaces` list, and the
replacement must retain the source priority, feature, UI/native kind, risk, and
every source outcome. The coverage checker reports each cutover target's
replacement count and refuses to
promote either target from `planned` to `active-compatibility` while any v22
P0/P1 journey is missing. Adding more Chromium-only journeys therefore cannot
make an incomplete migration look cutover-ready.

## Profiles and gates

| Profile | Gate | Scope |
| --- | --- | --- |
| `smoke` | Pull requests on hosted macOS and Windows | Legal/first run, primary navigation, Game/Role/Workspace/Macro creation and launch admission, Game Window lifecycle, and Settings persistence. |
| `full` | Required hosted macOS and Windows gate on `main` and release/rebuild validation; advisory on non-release branch pushes | All smoke journeys, edit/reorder/bulk-delete persistence, Workspace partial failure/cancellation, the unsaved-change quit guard, native Game Window/tab persistence and recovery, and system Settings boundaries. |
| `extended` | Scheduled or manually dispatched hardware runners | The complete full profile plus mixed-DPI, multi-display, fullscreen Spaces, and other native fixtures. |
| `chromium-macos-appkit-smoke` | Pull requests on hosted macOS | Chromium main-shell/preload/Core readiness, Electron native non-client drag regions, real Command+N/fullscreen/zoom application shortcuts through the retained NSMenu, visible Game/entity persistence, retained AppKit fullscreen-toolbar auto-hide/reveal/pin/restart parity, real CoreGraphics tab reorder plus retained NSMenu move/detach/hide/reveal/reload and restart persistence, cross-entity CRUD/reorder/cleanup parity, managed-page Quick Access interception, visible Settings persistence, visible Macro authoring/list/scheduler plus foreground and hidden native-effect parity through the retained AppKit trusted-input adapter, exact-Session permission/download deny parity and OS-native file-upload parity from visible remote controls, system Settings boundaries including exact-PID native diagnostics-export cancellation, and a retained-v22 Role whose blocked launch, visible explicit reset, AppKit-hosted Chromium launch, and restart continuity are verified. |
| `chromium-windows-smoke` | Pull requests on hosted Windows | Chromium shell/preload/Core readiness bound to the Windows Electron target, real Ctrl+N/F11/zoom application shortcuts, visible Game/entity persistence, local-shell fullscreen-toolbar auto-hide/reveal/pin/restart parity, visible context-menu controlled Role reload, paired cross-entity CRUD/reorder/cleanup parity, managed-page Quick Access and F11 interception, visible Settings persistence, visible Macro authoring/list/scheduler parity, exact foreground and hidden native trusted-input effects plus the ABI-v3 physical gate, exact-Session permission/download deny parity and exact-PID native file-upload parity from visible remote controls, system Settings boundaries including exact-PID native diagnostics-export cancellation, and the retained-v22 Role explicit-reset and restart journey. |

The paired Chromium tab-topology phases use only visible native primary actions.
macOS locates the exact retained AppKit radio tab through Accessibility and sends
a real CoreGraphics drag or selects the real NSMenu item. Windows sends real
WebDriver pointer/context-menu input to the bundled host. Read-only evidence
binds Core and native order, generation, topology revision, parent handle, and
the selected-detach successor before and after restart. Windows also resizes two
exact hosts and proves content bounds equal the Chromium viewport, then
minimizes and visibly restores without a resize event. Debug bridges only read
these receipts and never perform a tab mutation.

The paired `chromium-*-hardware-extended` profiles require a real secondary
display with a different scale factor. Their native-window phase reuses the
persisted three-tab Chromium namespace, selects that display through visible
UI, and drives retained AppKit controls on macOS or bundled Chromium controls
on Windows for drag, resize, maximize, fullscreen, and minimize. Missing
hardware is `BLOCKED`/`NOT_RUN`, never a synthetic pass. Read-only evidence
compares native display id, bounds, work area, scale, and presentation with the
Rust-published display topology.

The scheduled hardware workflow runs those profiles explicitly with
`pnpm run test:e2e:desktop:chromium:macos-appkit:hardware` on its macOS AppKit
runner and `pnpm run test:e2e:desktop:chromium:windows:hardware` on its Windows
runner. Their results remain separate from the Tauri v22 `extended` evidence;
one platform cannot establish the other platform's verdict.

Run profiles with `pnpm run test:e2e:desktop:smoke`,
`pnpm run test:e2e:desktop:full`, or
`pnpm run test:e2e:desktop:extended`. The runner reads its phase list from the
manifest, resolves `full` from `smoke` and `extended` from `full`, launches the
real debug-feature binary for the profile's runtime target, and rejects unknown
profiles. During the migration, the existing three profiles still launch the
Tauri v22 compatibility binary. Product builds continue to be checked for
E2E-control isolation.

The two Chromium foundation profiles run with
`pnpm run test:e2e:desktop:chromium:macos-appkit` and
`pnpm run test:e2e:desktop:chromium:windows`. Each profile retains its isolated
shell gate and now owns one platform-scoped half of the same P0 Game lifecycle:
the test rejects an invalid URL, creates and edits through visible UI, restarts
into the same user-data namespace, verifies Core and read-only SQLite
continuity, cancels a delete, and then visibly confirms deletion. A
`coverageGroup` pairs those separate macOS AppKit and
Windows target verdicts; neither target may stand in for the other. These
profiles also own paired P0 Role migration-reset phases. An E2E-only native
entry first creates a real retained-v22 Role, its visible Open action proves the
Core migration gate, and the visible role menu plus confirmation dialog perform
the explicit reset. The test correlates the exact Chromium clear receipt with
the atomic `v23Ready` journal. That receipt is emitted only after a fixed-mode
fresh child reopens the exact Rust-owned role path, receives Chromium's
whole-store clear acknowledgement, flushes and reads back an empty cookie store,
drains its Session, and reaches native-confirmed clean exit plus pipe EOF. The
journey then launches the Role in the target native host and repeats the visible
launch after restart. These foundation profiles still do
not establish complete Game Window, input, macro, or v22 parity, and they do not
inherit any v22 journey verdict.

The same two Chromium profiles separately execute a shared visible-UI P1 app
CRUD chain. Each platform edits and duplicates Role, Workspace, and Macro
definitions, selects a Workspace layout, reorders Role and Workspace cards with
real WebDriver pointer input, cancels and confirms destructive bulk operations,
observes reverse-dependency rejection before ordered cleanup, and proves the
empty persisted result after a final process restart. Their SQLite artifacts
retain exact ordinal and dependency evidence; neither platform's verdict is
used for the other target.

They also execute paired P0 Quick Access phases. The shared spec opens and
closes the palette from the sidebar and the real main-window shortcut, then
sends Command+K on macOS or Ctrl+K on Windows to the actual managed Role
Chromium page. Main-side input interception proves the game page never receives
K. Escape restores the exact originating runtime tab and focus, while a
successful destination keeps main-window focus. Visible pin, recent, restart,
unpin, and clear actions are correlated with read-only persisted evidence. The
macOS verdict retains the AppKit tab host; it does not replace native chrome
with renderer HTML, and the separate Windows verdict cannot satisfy it.

The profiles then run paired P0 Settings-persistence phases against that same
Role and Macro state. Visible Preferences controls select Light theme and Game
Window close/startup behavior; visible Interface controls hide the in-game
Macro tool, badges, and click markers. A visibly edited delay-only Macro still
starts and stops from its visible app control before and after restart, proving
scheduler/UI availability without claiming Windows trusted-input delivery. UI
state, typed read-only Core evidence, and final SQLite evidence must agree. The macOS half additionally
observes the retained AppKit Chromium host after launch; Windows keeps a
separate bundled-Chromium verdict.

The paired P0 Macro-UI phases then create a second Role-assigned Macro from the
visible role group. Its recorder must reject Command+K on macOS or Ctrl+K on
Windows with the dedicated reserved-shortcut message. Visible mind-map node
focus is sampled across animation frames and must remain stable while every
node and focused-edge computed filter stays `none`; grouped and flat tables plus
their selection toolbar are exercised before the visible Start and Stop actions.
The persisted Macro contains one 60-second delay step so both targets prove
scheduler/UI availability without sending a native input effect. Read-only
runtime and SQLite evidence bind the macOS verdict to retained AppKit Chromium
and keep the Windows bundled-Chromium verdict separate. This Macro-UI journey
does not itself claim native effects; the following dedicated phase owns them.

Both profiles then run the shared P0 Chromium Macro native-effect phase. The
spec visibly creates one Role-assigned KeyA/left/middle/right Macro, opens the
managed Role, and clicks Start in the main Macro UI. Core's Focus action must
move the exact Role host to foreground and acknowledge native readback before
any effect; this is not a pointer-focus race or an E2E focus control. The local
fixture then requires exact trusted keydown/keyup and mouse button/buttons
transitions plus click, auxclick, and contextmenu semantics. The long final
delay keeps the run available for a visible Stop action. macOS keeps its AppKit
adapter and native chrome. Windows additionally requires ABI-v3
`parentWasForeground` evidence and the hosted physical gate. The following
dedicated `chromium-macro-background-tab` phase replaces
`MACRO-BACKGROUND-TAB-004` independently on both platforms: visible shortcut
input holds Digit2 on Role A, Role B becomes the sole visible/focused sibling,
and a second visible shortcut starts trusted input on hidden A without selecting,
showing, or focusing it. Read-only native/Core evidence must preserve the exact
parent, tab order, owner, generations, visible Role B, and final input neutrality;
Windows additionally proves same-owner held-key continuity and a trusted hidden
KeyB in the ABI-v3 physical probe.

Both Chromium profiles also run one shared system-Settings phase with separate
platform verdicts. It enters every section through visible sidebar controls,
proves the macOS-only high-refresh selector (and its Windows absence), inspects
font-preview layout, cancels before portable export crosses into a native save
dialog, verifies the unpackaged updater boundary, and opens then visibly closes
a legal document. Separately, the visible Export diagnostics action crosses the
typed production bridge into the unique native save dialog owned by the exact
application PID. macOS and Windows OS automation cancel their respective dialog,
then the authenticated E2E-only read bridge returns a bounded production-call
journal whose exact new observation must contain typed outcome `null` and zero
Core `diagnosticsExport` invocations. The FPS action
is backed by the production Electron diagnostic-operation owner: begin publishes
`waitingForFocus`, exact cancel publishes a higher-revision terminal event, and
the renderer returns to Measure only from that event. The test bridge supplies
runtime identity only; its sole Core read verifies the high-refresh value and
never performs the setting change.

The paired P1 Chromium application-recovery journeys use three phases in one
standalone user-data namespace and the same visible-UI spec on both targets.
The seed phase creates one permanent Game Window containing a two-Role
Workspace, writes distinct cookie and LocalStorage markers through trusted
clicks in the actual managed Chromium pages, and reaches the normal event-bound
clean lifecycle terminal so the durability precondition never depends on a
timer or test-only flush. A fresh force phase visibly reopens the saved window,
proves both isolated Chromium Sessions already contain their markers, records
the read-only main PID, and force-terminates that exact process. SQLite must
transition through clean, exact `cleanExit: false` one-window live cohort, then
clean again. The final phase clicks the visible dashboard Restore session action
and proves the same marker and path identities. macOS evidence additionally
binds every phase's window and tab to the retained AppKit native host; Windows
produces a separate bundled-Chromium verdict and cannot satisfy the AppKit gate.

Two further paired recovery replacements extend that event-bound pattern. The
mixed-runtime journey cleanly seeds one Role tab beside a Role/Web Workspace
tab, visibly Shows it before exact-PID termination, and visibly Restores it.
Read-only evidence binds the exact schema-v2 cohort to isolated per-Role
Chromium paths and to the persistent global-Web content Session without
confusing it with the memory-only Rion web-chrome Session. The window-recovery
journey cleanly seeds two windows and three Role tabs, visibly Shows both before
termination, visibly Restores and activates every native tab before a second
termination, visibly Discards that exact cohort, and finally visibly Shows the
unchanged dormant definitions. Every terminal phase requires an empty
restore-in-progress cohort. macOS must report the retained AppKit host and
identity throughout; Windows reports an independent bundled-Chromium verdict.

The same profiles pair
`CHROMIUM-MACOS-APPKIT-WORKSPACE-WEB-SLOT-016` and
`CHROMIUM-WINDOWS-WORKSPACE-WEB-SLOT-016` under one replacement group. Their
shared spec creates a mixed Web App plus Role Workspace from visible slot
controls, selects YouTube from the visible popular-site menu, overrides the
editable URL with the fixture, and opens the Workspace through its visible card.
The remote surface must read back the Rust-resolved persistent global-Web path,
the external Rion chrome surface must read back an in-memory local-shell session,
and neither may alias the managed Role session. A real CoreGraphics pointer drag
targets the retained AppKit splitter on macOS; a real WebDriver pointer drag
targets the bundled-host separator on Windows. Read-only native/Core history and
SQLite then prove the exact resized layout, configured start URL, session marker,
and restart persistence. Contained fullscreen is deliberately excluded because
`WORKSPACE-WEB-FULLSCREEN-005` owns that independent verdict.

That verdict is replaced by the paired
`CHROMIUM-MACOS-APPKIT-WORKSPACE-WEB-FULLSCREEN-017` and
`CHROMIUM-WINDOWS-WORKSPACE-WEB-FULLSCREEN-017` journeys. Their shared spec
clicks the real controls in the remote global-Web Chromium document and submits
Escape through an exact-PID native keyboard event after WebDriver proves that
the target Chromium document owns focus. Read-only evidence must show the Rion-owned local
chrome hidden while remote content exactly fills its existing slot, with the
Core revision, sibling Role bounds, window bounds, and window presentation
unchanged. The same visible flow repeats inside a Core-admitted controlled
popup; macOS additionally proves the exact retained AppKit identities for both
the parent and popup hosts. Both website exit and Escape restore the paired
projection, and the restart phase proves this transient presentation never
became durable state. Windows retains a separate CI verdict.

The same paired popup verdict also holds a second navigation at native-ready,
then closes its exact parent tab through the visible AppKit/Windows control.
Detached evidence must bind the original popup/open-operation identity and full
parent generation fence to Core's `nativeClosed`, `parentRetired`,
`nativeDestroyed`, operation-terminal, and lifecycle-terminal receipt. The
fixture's transport-cancel event is corroboration only. This exact terminal
journal permits `popup=supported`; macOS and Windows profile executions remain
independent release gates.

Those same two phases also own the paired P1
`CHROMIUM-*-WORKSPACE-WEB-SECURITY-POLICY-027` verdict before the parent tab is
retired. The primary actions are visible clicks in the actual remote global-Web
document: one geolocation request and one attachment download. The exact
persistent Chromium Session's read-only journal must prove the canonical
origin, `geolocation`, and `callback=false`, then the attachment URL plus
`will-download/defaultPrevented=true`. The fixture's held response must observe
transport cancellation as corroboration. Absence of a downloaded file, elapsed
time, or a fixture-only event cannot establish the policy result. Capabilities
remain `permissions=degraded` and `downloads=disabled`, matching the stable v22
deny semantics; this paired journey neither claims nor substitutes for file
upload parity. macOS still binds the result to its retained AppKit host, and the
Windows result remains independent.

Those phases also own the paired P1
`CHROMIUM-*-WORKSPACE-WEB-FILE-UPLOAD-028` verdict. WebDriver clicks the real
visible remote file input while an OS helper concurrently selects one bounded
fixture through the unique native chooser owned by the exact app PID. macOS
requires the retained AppKit `AXDialog`/`AXSheet` and native Go plus Open/Choose
actions; Windows requires the one `#32770` dialog, file-name AutomationId `1148`,
and Open AutomationId `1`. The page must report a trusted change plus the exact
filename, byte count, and SHA-256, and detached evidence must bind those values
to the artifact-local fixture path. The native liveness deadline is failure-only.
This paired verdict changes `fileUpload` to `supported`; it does not weaken the
independent permission/download deny policy or replace the macOS AppKit host.

Three further paired Workspace groups replace `WORKSPACE-WEB-ONLY-006`,
`WORKSPACE-SHARED-ROLE-003`, and `WORKSPACES-RECOVERY-002`. Their primary
actions remain visible Web/AppKit/Windows controls; E2E-only APIs only read
Core/native evidence or gate the fixture. Web-only seed/restart share one
durable namespace, while shared ownership and navigation recovery each use an
isolated namespace. Evidence requires the AppKit retained-host identity on
macOS and bundled-Chromium identity on Windows, exact owner generations and
topology revisions, Role-scoped failure status, SQLite definitions, a clean
terminal journal, and two independent platform verdicts.

On macOS, `native-non-client` in these main-renderer assertions names Electron's
native drag-region integration. It is not evidence for runtime Game Windows.
Those windows must continue to prove the retained AppKit controller, native tab
chrome, gestures, focus, fullscreen, traffic lights, and Chromium-surface
attachment through native-host observations and visible native actions.

`CHROMIUM-MACOS-APPKIT-APPLICATION-SHORTCUTS-030` and
`CHROMIUM-WINDOWS-APPLICATION-SHORTCUTS-030` share one focused-runtime proof.
The native Command/Ctrl+N accelerator first creates one observably empty Game
Window. Visible Quick Access then launches a fixture Role into that exact
window, making the retained AppKit window on macOS or bundled host HWND on
Windows the foreground owner. Zoom, reset, and fullscreen input uses the
`focused-runtime` OS-input mode, which never enumerates or activates a fallback
launcher window: macOS requires the exact PID to be frontmost with one matching
AX focused/main window, and Windows requires `GetForegroundWindow` to resolve
to the exact PID. The token-authenticated read-only E2E endpoint must show a
monotonic per-window Core zoom-receipt sequence, equal Core/executor window
factors, exact Role/global-Web factor readback, zero popup surfaces for this
fixture, stable native host identity, and an unchanged main BrowserWindow zoom
and fullscreen sentinel. Debug controls may create the Game and Role fixture;
they do not perform the shortcut or replace the visible Quick Access launch.

`CHROMIUM-MACOS-APPKIT-RUNTIME-TAB-RELOAD-031` and
`CHROMIUM-WINDOWS-RUNTIME-TAB-RELOAD-031` reopen the platform's visible tab menu
for each of two consecutive Reload actions. macOS uses `AXShowMenu` on the
retained AppKit radio tab and presses its real NSMenu item; Windows uses a real
right-click and the bundled host context-menu item. The second selection must
come from a newly rendered menu/projection, never replay the first capture.
Read-only evidence binds both exact source fences to Applied EventBound
`inputReady` receipts, monotonic document and navigation identities, resumed
native/Core input, unchanged tab/window/Role-surface/AppKit host identity, a
surviving pre-existing popup, and an initially empty shell-error journal. The
token-authenticated E2E harness then arms one exact window/tab failure without
performing the action; a third visible menu selection must publish exactly one
classified shell error without changing the document, owners, or popup, and a
fourth visible selection must recover successfully. This is a v23 Chromium
journey; stable Tauri v22 intentionally has no controlled-reload UI or command.

`scripts/electronAppKitRuntimeProbe.cjs` is a lower-layer, standalone native
adapter probe, not a Chromium product-journey verdict. With
`RION_STUDIO_DESKTOP_E2E_BUILD=1`, it attaches a sandboxed Chromium
`WebContentsView` to an Electron `BaseWindow` and reads back retained AppKit tab,
traffic-light, accessibility-action, background-focus, close-button, and
fullscreen-toolbar evidence. Without that exact build flag, the same probe
fails if any desktop-E2E N-API method is present, establishing production-addon
surface isolation. Neither result substitutes for a full Game Window journey
through the renderer, Core topology, session owner, and runtime host.

`CHROMIUM-MACOS-APPKIT-FULLSCREEN-TOOLBAR-012` and
`CHROMIUM-WINDOWS-FULLSCREEN-TOOLBAR-012` are paired under one coverage group.
The macOS phase clicks the standard View menu and retained AppKit traffic light;
the Windows phase clicks the Settings switch and submits F11 from the actual
managed Role page, where main prevents both key halves from reaching content.
Both move the real WebDriver pointer to the physical reveal edge and consume an
E2E-only, token-authenticated observation history. That history must bind a
nonempty live Role/tab set to exact Core/native generation and topology fences,
prove hidden, revealed, pinned, reverse-live-update, and terminal normal states,
and retain the auto-hide preference across a clean restart. It never mutates
runtime state or substitutes for any primary action.

The Electron foundation build substitutes dedicated E2E main and preload entry
points. Before loading the production main entry, that E2E main may seed the
retained-v22 reset precondition through the native Core binding. The renderer
bridge remains observation-only except for explicit fixture setup and classified
failure preconditions: it is available only in a non-packaged build,
accepts only the exact main-renderer file URL, requires the per-run 256-bit
session token, checks the exact host target, and exposes only bounded setup,
failure-arm, and coherent runtime inspection contracts. Production
Electron entry points, addon APIs, preload output, and ASAR do not import or
package this control. Legal acceptance, validation, create/edit/delete, launch,
and Clear saved data remain visible UI actions.

After the production rebuild and static package verifier pass, CI reruns the
same shell assertion from the final executable with
`pnpm run test:e2e:desktop:electron:packaged -- --app <bundle>`. The packaged
gate verifies the ASAR renderer, sandboxed preload bridge, Rust Core snapshot,
and target-specific gesture projection. On macOS its Chromium profile uses an
artifact-local `CFFIXED_USER_HOME`. On Windows the gate runs inside a temporary
local-user profile whose HKCU and OS Known Folders supply the real Roaming AppData,
Local AppData, and UserProgramFiles paths; changing `APPDATA` or `LOCALAPPDATA`
alone is not isolation. The temporary-user root command is assigned, while
suspended, to a kill-on-close Job Object, and the gate rejects any active process
left when that command exits. The packaged product still rejects
`RION_STUDIO_USER_DATA_DIR`. The ASAR verifier independently rejects source
maps, missing entry points, WebDriver packages, and renderer E2E navigation
markers, so running an E2E build earlier in the job cannot contaminate the
shipping archive unnoticed.

PR smoke is a required, non-advisory macOS and Windows check. The full hosted
profile is required for `main`, release candidates, and manually dispatched
rebuild validation; non-release branch pushes may keep it advisory. Product
failures are never auto-retried. Extended runs remain fail-closed when explicitly
scheduled or dispatched on provisioned hardware: `BLOCKED` or an incomplete
platform is not success, but unavailable hardware runners do not block release.

`CHROMIUM-MACOS-APPKIT-MACRO-STANDBY-RECOVERY-023` and
`CHROMIUM-WINDOWS-MACRO-STANDBY-RECOVERY-023` replace the standby recovery
journey with one shared Chromium spec. Macro Start and Stop remain visible UI
actions. A token- and sender-fenced E2E signal injects suspend/resume into the
same serialized production lifecycle lane as Electron's power monitor and
awaits its exact Core-backed terminal projection; a separate read-only journal
observes trusted-input requests and native receipts without becoming a success
source. The verdict requires held-key cleanup and proved input neutrality,
Macro terminality, disabled Start throughout suspension, and a new run/input
epoch after wake. macOS additionally binds the two-tab result to the retained
AppKit host. Windows explicitly reselects the Role before the wake restart,
while its separate ABI-v3 physical gates prove both exact foreground and hidden
background delivery; neither result is simulated by the standby signal.

## Journey authoring

- Add one stable journey ID per independently reportable user outcome. P0/P1
  entries must name an existing spec, both required platforms, a profile/gate,
  every phase required to establish its verdict, and success plus any applicable
  failure, cancellation, or restart outcome. A journey passes only after all of
  those phases have successful evidence; a focused run reports missing evidence
  as `NOT_RUN` instead of inferring success.
- Put a `[journey:JOURNEY-ID]` marker in the owning spec. Run
  `pnpm run check:e2e-coverage`; missing files, markers, platforms, profiles,
  duplicate IDs, low targets, and feature UI gaps fail CI.
- Perform the primary action through visible UI. `rendererCall` and debug-only
  native controls may create deterministic preconditions, inject a controlled
  fault, or read authoritative state; they may not substitute for the action
  being tested.
- Wait for authoritative renderer/native events or persisted evidence. Do not
  use elapsed time as success. External OS boundaries may be declared `BLOCKED`,
  which deliberately fails gated runs.
- Preserve `report.json`, failure screenshots, frontend/backend logs, the event
  transcript, fixture log, and read-only SQLite snapshots/query output for every
  phase. Artifacts are retained for 14 days on hosted CI and 30 days on hardware
  runners.

## Agent change contract

Every user-visible implementation handoff must list affected journey IDs and the
macOS/Windows profiles actually run. New visible behavior updates the manifest and
its E2E in the same change. If E2E is genuinely inapplicable, use exactly one of
`internal-only`, `compile-only`, or `lower-layer-covered`, and include the focused
lower-layer evidence. A platform that was not executed locally must be called out
as pending its required CI gate.

Windows native and mixed-DPI procedures are indexed in
`docs/validation/README.md`. Full and extended evidence must bind to the same
exact SHA, and `BLOCKED` never establishes cross-platform completion.

P0 and P1 are fully automated. The full profile performs primary actions through
visible UI and uses the local runtime fixture only to hold or fail exact navigation
boundaries. The P1 quit-guard journey enters through the real OS-native
Command-Q/Ctrl-Q path and observes the visible unsaved-change decision. P2 planned
entries record other expensive native work without inflating P0/P1 coverage.
Current planned extended work includes complete portable import/export, Chrome
profile import, font installation, diagnostics-export completion beyond the
exact native cancel journey, staged updater installation, remaining tray/menu
behavior, and native window controls.
