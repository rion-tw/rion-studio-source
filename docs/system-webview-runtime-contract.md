# System WebView Runtime Contract

Contract version 8 defines the shared semantics for WKWebView on macOS and
WebView2 on Windows. It does not pretend that the native APIs are identical.
Rust orchestration owns the contract, while the AppKit/WKWebView and
Win32/WebView2 adapters implement it. Existing macOS behavior is the observable
reference for user-visible ordering, focus, visibility, and navigation behavior;
WKWebView APIs themselves are not an implementation template for Windows.

## Operation envelope and receipt

Every contract operation has one monotonic operation ID created before it is
submitted, plus a platform, subsystem, trigger, acceptance time, deadline,
explicit completion scope, and any available revision, topology revision,
window generation, lifecycle epoch, session, window, tab, role, parent
operation, or surface-generation fence. Planning, coalescing, failure handling,
diagnostics, and public API responses retain that same ID and completion scope.
A terminal receipt uses one of these statuses:

- `applied`: the declared completion scope was reached.
- `superseded`: a newer revision, epoch, or surface generation replaced it.
- `cancelled`: accepted work was safely stopped before its native mutation could
  begin, most commonly because shutdown or application suspension started.
- `degraded`: the operation completed with a weaker verified guarantee.
- `failed`: the declared completion scope was not reached.
- `indeterminate`: native mutation may have occurred and compensation could not
  restore a known state.

The receipt's `completionScope` is part of the guarantee. In particular,
`nativeSubmission` does not claim that page JavaScript handled an input event,
and `stateCommit` does not claim that a later queued native paint has completed.
Failure stages cannot weaken or replace the scope declared when the operation
was accepted.

Input, authorization, and not-found failures discovered before acceptance reject
the API call. Once accepted, every outcome—including `failed` and
`indeterminate`—resolves as a terminal receipt. Renderer handling is uniform:
`applied` succeeds, `superseded` is silent, `degraded` raises a non-blocking
warning, `failed` exposes its stable code, and `indeterminate` asks the user to
restart before retrying.

The registry holds at most 256 active operations and 80 recent terminal
receipts. Active entries are never evicted to make room. A queued operation that
passes its deadline is `failed`; an operation whose native call started but did
not confirm before its deadline is `indeterminate`. Lifecycle cancellation is
`cancelled` only while work is still queued and becomes `indeterminate` after
native submission. The first terminal receipt wins, so a late native callback
cannot replace a timeout, supersede, cancellation, actor-stop, queue-full, or
shutdown result.

## Shared subsystem semantics

| Subsystem | Shared guarantee | Native mechanism |
| --- | --- | --- |
| Surface lifecycle | Generation-fenced register, isolate, release, retire, or quarantine | WKWebView lifecycle callbacks / WebView2 controller callbacks |
| Navigation | Only a permitted main-frame HTTP(S) navigation or controlled reload can create an input-fence operation; the latest operation reaches page finish or is superseded, and automatic input resumes only after drain plus new-document proof | WKNavigation callbacks / WebView2 main-frame navigation callbacks |
| Input | Epoch- and generation-fenced native submission with bounded cleanup | AppKit event delivery / WebView2 native input |
| Presentation | Latest-only revisions coalesce tab surfaces and focus; a bounded per-window FIFO preserves non-idempotent visibility/fullscreen/maximized controls and returns native acknowledgement for the submitted native transaction | AppKit window and view APIs / Win32 and WebView2 controller APIs |
| Tab activation | The live tab UI commits a latest-only revision immediately; Core selection, focus work, and native acknowledgement run asynchronously, and stale background commits are `superseded` | AppKit tab controller and presentation / WebView2 controller presentation plus the local tab-strip WebView |
| Tab mutation | The live AppKit or HTML topology commits first. Per-tab FIFO work owns role isolation and surface movement, while SQLite durability and native chrome readback reconcile in the background without reverting the visible tabs | AppKit tab controller and lifecycle / Win32, WebView2 controllers, and the local tab-strip WebView |
| Tab chrome projection | One complete, revisioned projection replaces native tab metadata, order, active state, ARIA state, toolbar, display, language, and theme | Idempotent AppKit projection and readback / instance-fenced Windows tab-strip hydration and acknowledgement |
| Geometry and layout | Per-window serialized revision applies logical bounds, DPI conversion, child-surface layout, readback, and reverse-order compensation; asynchronous window modes declare native submission | AppKit content-layout geometry / Win32 window and WebView2 controller bounds |
| Popup | Owner-scoped, fail-closed policy; only `about`, `http`, and `https` are eligible | WKUIDelegate-backed Tauri callback / WebView2 NewWindowRequested-backed callback |
| Security | Policy installation succeeds before a role or popup becomes live | WKWebView policy adapter / WebView2 settings and event handlers |
| Session | Bounded cookie and LocalStorage transfer with readback and rollback | WKWebsiteDataStore / WebView2 profile data |
| Audio and zoom | Reversible native fan-out followed by a live-state commit; saved-window durability is latest-revision-wins and never compensates the visible UI | Per-view System WebView APIs |
| Metadata | Native tab metadata batch is submitted or reported degraded | AppKit tab controller / Windows tab-strip WebView evaluation |
| Performance and capability | Probe result carries evidence and policy mode, never inferred support | Platform runtime probe plus bounded foreground sampling |
| Shutdown | Idempotent drain rejects new work, fences input, isolates all managed surfaces under one deadline, and reports incomplete release or unknown isolation | Shared lifecycle registry plus platform release callbacks |
| Display topology | One revision-fenced snapshot drives remap, native movement, state commit, projection publication, and reverse-order compensation | NSScreen notifications and geometry / Win32 display notifications and geometry |
| Window lifecycle | Close intent, native submission, exact window generation, release proof, and terminal receipt are one idempotent transaction | NSWindow lifecycle / Win32 window lifecycle |
| Focus | One global intent lease owns focus across the main window and every runtime window; native observation confirms or supersedes it | AppKit activation and focus observation / Win32 foreground and focus observation |
| Drag | One session freezes source/target generations, topology revision, lifecycle epoch, and terminal receipt | AppKit tab drag adapter / Windows tab-strip pointer adapter |
| Recovery | One attempt fences generation and input, builds a provisional replacement, retires the old surface at an explicit destructive boundary, and reaches `inputReady` or `restartRequired` | WKWebView process termination / WebView2 process-failure callbacks |
| Power | Sleep rejects new native work, interrupts old-epoch work, drains input and Core, persists recovery state, and wake restores the same epoch before accepting work | NSWorkspace sleep/wake notifications / `WM_POWERBROADCAST` message-only window |

## Revisioned projections

Getter responses and events for runtime state, display topology, the main window,
and application lifecycle are backed by one stored projection per domain. An
unchanged semantic payload replays the exact same `revision` and `capturedAt`;
only a semantic change advances the revision. A getter therefore cannot produce
a new envelope that races an already emitted equivalent event.

Consumers apply only newer revisions. Display observations may retain their
original `cause` metadata when a getter sees the same topology, but observation
metadata alone does not create a new revision. `NativeWindowStateRecord` also
contains `windowGeneration` and `lifecycleEpoch`, so late AppKit or Win32
readback from a replaced window or pre-sleep epoch is not current state.

## Window and tab ownership

The presentation actor is the only normal path for runtime window show, hide,
focus, restore, fullscreen, maximize, and role focus. It coalesces pending work
per window and records a `superseded` receipt for every request it replaces.
Topology and geometry transactions first commit fenced runtime ownership, then
queue presentation; their separate receipts distinguish `stateCommit`, native
submission for asynchronous window-mode changes, and native acknowledgement.

Platform-specific code may perform the native calls inside the adapter or a
bounded rollback transaction. It must not make an independent product decision
about the active tab or visible role.

Runtime window close is a generation-fenced transaction rather than an
uncoordinated window callback. Repeated close requests share the same active
operation; a late callback for a replaced window is superseded. Failure before
native submission is `failed`. Failure after the exact native generation may
have closed is `indeterminate`, and the affected ownership remains fenced until
release is proven or the application restarts. `rion://window-lifecycle`
publishes the same terminal receipt stored in diagnostics.

The main window uses a bounded FIFO actor for show, hide, minimize, maximize,
fullscreen, focus, and readback. Its queue limit is 64; stop and capacity errors
terminalize accepted operations rather than dropping them. Readback and events
share `NativeWindowStateRecord`. Focus itself is global: the latest intent lease
across the main window and runtime windows wins, a matching native focus
observation confirms it, and a different observation supersedes older leases.
Every lease is scoped to the exact window generation and lifecycle epoch.

### Role slot and native-surface ownership

A runtime tab owns a stable list of role slots. Every slot keeps its slot ID,
role ID, normalized rectangle, and zoom policy for the lifetime of the tab,
whether it currently contains a role surface or a local placeholder. Layout is
always computed from the full slot list, so stopping or moving one role never
reflows the remaining slots.

At most one native role WebView may exist for a role. Core stores that global
surface owner as `{ windowId, tabId, slotId, generation }`; all other slots for
the role project `blocked`. A stopped role has no owner and all of its slots
project `available`. Workspace state is derived from these slot projections and
is never a second mutable ownership authority.

Blocked and available slots use a bundled local placeholder WebView. It is not
registered as a managed role surface and cannot receive macro input, role audio,
role navigation, or role zoom. Its command is accepted only from the exact
registered placeholder label and frozen tab, slot, role, and owner generation.
The placeholder names the current owner tab when one exists and disables its
button while a claim is in flight.

A role claim is serialized by the role operation lease and generation-fenced.
Core first marks the source `stopping`; native code then closes and verifies the
exact source surface before Core moves ownership to the target as `launching`.
Only then may native code create the target surface. Input readiness commits
`running` and replaces every other occurrence with a placeholder carrying the
new owner generation. Native state locks cover only snapshot preparation and
commit and are never held across WebView creation, close, navigation, or layout
calls.

If source isolation cannot be proven, no target WebView is created and the old
owner remains fenced. If isolation succeeds but target creation or readiness
fails, Core releases the owner and every occurrence remains an available,
retryable placeholder. Closing a tab isolates only roles whose owner points to
that tab; blocked placeholders do not stop a role owned elsewhere.

Geometry, presentation, and native window controls share one mutation lane per
window. A geometry transaction snapshots native bounds and mode before mutation,
suppresses intermediate move/resize persistence, applies child WebView layout as
one reversible batch, and commits runtime placement only after native success.
Window controls remain ordered while ordinary presentation requests coalesce, so
rapid fullscreen/maximized toggles cannot collapse into the wrong final state.
Normal-mode bounds allow one logical pixel of DPI rounding. Fullscreen and
maximized geometry restoration still claims `nativeSubmission`; the explicit
tab-strip control APIs instead acknowledge completion of their native call and
do not claim that a later operating-system animation has visually settled.

`hideGameWindow`, `showGameWindowTab`, `setGameWindowTabMuted`,
`moveGameWindowTab`, `setGameWindowTabHidden`, `stopGameWindowTab`, and
tab-strip minimize/fullscreen/maximize controls return terminal receipts
directly. `moveGameWindowTabToNewWindow` returns the target window ID together
with its terminal receipt. Unhiding a tab is activation convergence and returns
the existing `tabActivation` receipt rather than creating a second mutation.
`showGameWindowTab` uses the tab-activation transaction described below and does
not wait for or claim page readiness.

## Tab activation convergence

Tab pointer selection, tab-strip Ctrl+Tab, AppKit native selection, launcher
selection, and `showGameWindowTab` first commit a new `LiveWindowTabState`
revision. The visible selection is complete at that boundary. Renderer-facing
calls receive an `applied` `stateCommit` receipt after the background native
presentation has been queued; AppKit menu callbacks return without waiting for
any receipt.

Core active-tab projection, content focus, and native chrome acknowledgement run
after that commit. Presentation work is latest-only by window. A newer revision
supersedes older work, and a late Core or native acknowledgement cannot repaint
the old tab. Presentation timeouts remain in diagnostics as `superseded`; they do
not become `NATIVE_OPERATION_INDETERMINATE` user errors. Same-tab activation may
still enqueue idempotent native repair work, but it never delays the UI callback.

## Tab topology mutation transactions

Move, move-to-new-window, hide, reorder, and stop use one per-tab mutation lane.
AppKit or the local HTML tab strip commits the post-intent order and selection to
`LiveWindowTabState` first. Every insert, replacement, removal, reorder, move,
selection, audio, zoom, divider, and placement change advances a monotonic live
revision. Core receives the owner-lifecycle command afterward; its completion
scope is `stateCommit`, not topology convergence.

Each tab owns a bounded FIFO of 32 accepted mutations. Every operation has a
20-second deadline. A queued timeout is `failed`; a timeout after Core or native
work begins is `indeterminate`; and the first terminal receipt wins. A queued
mutation whose frozen identity is no longer current is `superseded`. Repeated
stop requests join the same active stop operation, while move, hide, and reorder
are rejected with `TAB_MUTATION_CLOSING` after stop has been accepted.

The generated mutation request retains identity and generation fences for owner
work and diagnostics, but expected Core order, SQLite state, and native chrome
readback no longer define visible success. Core topology mutations do not write
saved Game Window tabs and cannot compensate a committed UI revision because a
database write failed. Native chrome mismatch is reconciled and logged in the
background. Drag completion keeps its existing drag parent and the same owner
lane, so pointer and menu/API paths cannot race role ownership.

## Native tab chrome projection

`RuntimeTabChromeProjectionRecord` is the complete native tab-chrome authority.
Presentation state supplies visible order and active tab; the Core snapshot
supplies metadata and hidden state; saved state is used only to verify
persistence. The projection also carries the exact window generation, lifecycle
epoch, semantic projection revision, tab metadata, display state, fullscreen and
toolbar state, language, and theme. Identical semantic content reuses its
revision; a topology or active-tab change advances it.

On Windows, every tab-strip document load creates a new renderer instance ID and
announces `RuntimeTabChromeReadyRecord`. Native code then sends a complete
replace projection for that exact instance. Until hydration completes, the
renderer queues deltas. Atomic hydration removes extra tabs, creates missing
tabs, replaces metadata, order, active and ARIA state, and then replays only
newer deltas. An acknowledgement is accepted only when instance, revision,
observed order, and observed active tab all match. Old instances, stale
revisions, wrong order, wrong active state, and late acknowledgements cannot
complete current work.

Windows waits at most two seconds for projection acknowledgement and resends the
complete projection once. A second failure terminalizes that projection with
`TAB_CHROME_PROJECTION_TIMEOUT`; the committed live tab state remains unchanged
and reconciliation continues independently. A newly ready renderer supersedes
pending projections for the old instance, which makes WebView reload recovery
deterministic instead of depending on retained DOM.

macOS consumes the same projection builder without a renderer instance ID. The
AppKit controller applies every item idempotently and reads back exact order and
active tab before acknowledgement. WKWebView/AppKit remains the product reference
for observable order and selection, while Windows is required to converge to
that behavior through its renderer protocol.

## Destructive tab stop boundary

Stop first removes the live tab and creates an idempotent tombstone containing
its slots and expected owner generations. Cancelling a provisional launch is a
normal applied outcome and never enters saved state. For a live tab, early input
revocation and surface isolation precede owner release.

The successful close boundary is: the tab is absent from live UI, its login,
input, and overlay capabilities are revoked, and every owned WebView is proven
isolated. A blank controller may remain in the retired registry for background
reclamation; this returns `applied` with
`tabStopIsolatedReleasePending`. Native chrome mismatch likewise returns applied
and schedules reconciliation. Only failure to prove isolation is
`indeterminate`; the tombstone retains the generation fence, roles are
quarantined, and a second login surface cannot be created. SQLite is not part of
the stop receipt and can never restore the closed tab.

## Live window snapshot persistence

Each saved live window owns one serialized persistence lane. A 200 ms debounce
coalesces revisions and writes only the latest complete snapshot: placement,
ordered tabs, active tab, role-slot demand, zoom, hidden state, and audio state.
Runtime role ownership is never serialized. Core compares
`(windowId, windowGeneration, revision)` and returns `superseded` for an older or
duplicate write.

A failed write leaves the newest snapshot dirty. Retries use 250 ms, 1 s, 5 s,
then bounded exponential backoff up to 30 s. Failure never mutates
`LiveWindowTabState` or native chrome. Window close captures and attempts the
final snapshot before teardown, continues closing regardless of that result,
and retains the captured input so retries do not depend on a native window
handle. Application exit performs one bounded flush and records any remaining
dirty revision without blocking shutdown.

## Display topology and tab dragging

Display topology reconciliation freezes one observed topology revision and one
remap plan. Native window movement, child-surface layout, readback, runtime
placement, and persistence form the `topologyCommitted` transaction; the
revisioned projection is published from that committed state. A failure before
terminal commit compensates already attempted native mutations in reverse
order. Successful compensation is `failed`; incomplete compensation is
`indeterminate` with a rollback count. A stale observation is `superseded` and
cannot overwrite a newer topology. Both platforms are tested with explicit
platform inputs even when only one native shell is locally available.

A runtime tab drag has one stable session and operation ID from pointer-down to
terminal commit. It freezes the tab, source and target window generations,
topology revision, lifecycle epoch, and drag ordering. Duplicate completion
replays the first terminal receipt. Topology changes, window replacement,
suspension, or a newer session cancel/supersede the old transaction; a partially
applied cross-window move uses bounded compensation and becomes `indeterminate`
if compensation cannot restore known ownership.

## Lifecycle and readiness rules

- A surface identity is `(instanceId, generation, windowId)`. Stale generations
  cannot receive navigation, input, presentation, or recovery work.
- Closing first fences input, then proves isolation. An unverified close becomes
  `indeterminate`, quarantines the role, and blocks relaunch until recovery.
- `pageFinished` means the engine completed an HTTP(S) navigation callback.
- `inputReady` is stronger: Core input drained, a different completed document
  instance was observed, and the native input epoch resumed.
- Main-frame navigation is the only implicit input-fence transaction boundary.
  Subframe, iframe, document-resource, and other resource requests never create,
  advance, extend, or release a role input fence on either platform.
- macOS and Windows share the observable ordering: synchronously close Core and
  native input before allowing the main-frame navigation, asynchronously drain
  that epoch once, then wait for the matching generation's page finish and new
  document proof. Platform adapters may use different native APIs to provide it.
- A navigation watchdog belongs to one current main-frame or controlled-reload
  operation. Recovery is valid only while that operation ID, input epoch, and
  surface generation remain current; resource activity cannot start or reset it.
- Timeouts never silently become success. A newer operation becomes
  `superseded`; an unknown native result becomes `indeterminate`.
- Reload is a navigation operation rather than a bare native command. Every role
  fences and drains macro input before reload, reaches a new HTTP(S) document,
  and resumes only when its generation is still current. Overlapping controlled
  navigations are reference-counted per WebView, so a superseded reload cannot
  release the newer reload's policy fence. A tab-level receipt is `degraded` when
  role outcomes differ.
- Native reload menu actions wait in the background for the aggregate `inputReady`
  receipt. Menu submission never reports success before the new document and
  matching input epoch are ready.
- Role-load navigation is registered before submission and carries the accepted
  lifecycle epoch. Sleep can cancel a queued load; a load already submitted to
  WKWebView or WebView2 becomes `indeterminate`. Page-finish callbacks from the
  old epoch cannot reassert keys, mark a tab ready, persist success, or overwrite
  the lifecycle terminal receipt.

## Surface recovery

Process failure creates one `SurfaceRecoveryAttemptRecord` and one optionally
parent-linked native operation for the exact `(roleId, surfaceGeneration,
windowId, lifecycleEpoch)`. At most 32 attempts are active and 40 terminal
attempts are retained. Duplicate callbacks for the same active or completed
attempt replay its record; an explicit safe retry receives a new operation ID.
Recovery is limited to two claims per role in a 60-second window.

Recovery fences and drains automatic input, creates and configures a hidden
provisional surface, then checks identity again before retiring the old surface.
Before that retirement boundary, failure leaves the old surface authoritative
and may be retried. After retirement begins, an unverified failure is
`indeterminate`, the role is quarantined, and the attempt reports
`restartRequired`. Success requires replacement navigation, authoritative swap,
Core recovery, and native input resume; a visible recovered page without proven
input resume is `degraded`, never `applied`.

Suspension before the destructive boundary safely terminalizes the old attempt
and retains one bounded latest-generation retry for wake. Suspension after the
boundary remains `indeterminate/restartRequired`. Recovery events and operation
receipts use the real lifecycle epoch; they never default a live attempt to epoch
zero.

## Application power lifecycle

`ApplicationLifecycleStatusRecord` is a revisioned projection with `active`,
`suspending`, `suspended`, `resuming`, and `degraded` states. It is available from
`getApplicationLifecycleStatus()` and
`onApplicationLifecycleChanged()`. Native notification callbacks only enqueue a
signal; the shared lifecycle actor performs all state changes.

On sleep, the actor advances the global lifecycle epoch, revokes focus, blocks
new native work, cancels queued operations, marks in-flight operations
`indeterminate`, invalidates old tab-drag sessions, fences and drains every
role's input, clears pressed-key state, suspends Core runtime work, and persists
placements plus an unclean restore session. Close, release, power, and shutdown
completion remain available. On wake, Core resumes first, then only the exact
recorded input epochs may resume. The actor republishes runtime/main-window
projections and returns to `active` or `degraded`; it then cancels stale drag
state, requests a fresh display-topology reconciliation, and schedules bounded
deferred surface recovery under the active epoch.

macOS uses `NSWorkspaceWillSleepNotification` and
`NSWorkspaceDidWakeNotification`. Windows owns a hidden message-only window and
handles `PBT_APMSUSPEND` plus automatic, critical, standby, and suspend resume
classes from `WM_POWERBROADCAST`. These adapters report signals only; neither
adapter defines ordering or terminal semantics.

## Shutdown rules

Shutdown moves once through `accepting`, `draining`, and either `closed` or
`indeterminate`. While draining, new launch, navigation, geometry, presentation,
input, and recovery work is rejected with `SYSTEM_RUNTIME_SHUTTING_DOWN`; close
and release completion remains accepted. All role, recovery, popup, and divider
surfaces are isolated concurrently under one ten-second reclamation deadline.
Creation gates and per-window mutation lanes must drain inside that same deadline
before the final surface snapshot is committed.
Confirmed isolation with an unconfirmed controller release is `degraded`;
unconfirmed content isolation is `indeterminate` and marks the runtime unhealthy.
Every `close_all()` caller waits for and receives the same shutdown receipt,
including update installation and repeated exit requests.

The restore session is marked `cleanExit: false` while the runtime is active and
before any updater drain. It becomes `true` only after the shared shutdown
receipt is terminal `applied` or `degraded`. A failed or indeterminate drain
therefore remains recoverable on the next launch instead of being mislabeled as
a clean exit.

## Popup, security, and capability policy

Popups without a role owner or with an unsupported scheme are denied before a
native window is created. A created popup must install security, lifecycle,
failure-monitor, zoom, ownership, and main-frame navigation handling before
registration. Popup resource and subframe activity never participates in the
role input-fence transaction. Failure at any stage closes the provisional window
and records a failed receipt.

`capabilityEvidence` reports each capability's runtime probe, policy mode,
evidence stage, and failure reason. `supported`, `degraded`, `unsupported`, and
`disabled` are explicit states; no feature may infer support solely from the
operating system name.

## Diagnostics and compatibility

`SystemRuntimeDiagnosticsRecord` publishes the contract version, shutdown state,
application lifecycle projection, capability evidence, active
lifecycle/navigation counts, and at most 80 recent operation summaries from the
same registry used by API waiters. Summaries may
include stable IDs and error codes, but never
URLs, origins, session values, tokens, or native error messages.
Input-fence log contexts include the owning operation ID together with the input
epoch and surface generation, so every recovery event can be traced to its
main-frame or controlled-reload transaction without exposing page data.

Additive fields remain compatible within version 6. The subsystem, status, and
completion-scope values are generated Rust/TypeScript enums shared by Core,
Tauri, renderer, and tests. `projection` and `tabMutation` are contract
subsystems, `tabTopologyConverged` is the tab-mutation completion scope, and the
unreachable `focusObserved` scope is not part of version 6; focus continues to
use `nativeAcknowledgement`. Changing a terminal status,
completion scope, identity fence, popup/security policy, or ordering guarantee
requires a contract-version bump and matching macOS and Windows behavior tests.
macOS checks run locally where available; Windows native reachability and SDK
integration remain mandatory in `windows-latest` CI.
