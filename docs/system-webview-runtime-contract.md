# System WebView Runtime Contract

Contract version 5 defines the shared semantics for WKWebView on macOS and
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
| Tab activation | One latest-only revision converges the visible surfaces, native tab chrome, authoritative runtime selection, and Core selection | AppKit tab controller and presentation / WebView2 controller presentation plus the local tab-strip WebView |
| Geometry and layout | Per-window serialized revision applies logical bounds, DPI conversion, child-surface layout, readback, and reverse-order compensation; asynchronous window modes declare native submission | AppKit content-layout geometry / Win32 window and WebView2 controller bounds |
| Popup | Owner-scoped, fail-closed policy; only `about`, `http`, and `https` are eligible | WKUIDelegate-backed Tauri callback / WebView2 NewWindowRequested-backed callback |
| Security | Policy installation succeeds before a role or popup becomes live | WKWebView policy adapter / WebView2 settings and event handlers |
| Session | Bounded cookie and LocalStorage transfer with readback and rollback | WKWebsiteDataStore / WebView2 profile data |
| Audio and zoom | Reversible fan-out followed by an atomic runtime-state commit | Per-view System WebView APIs |
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

`hideGameWindow`, `showGameWindowTab`, `setGameWindowTabMuted`, and tab-strip
minimize/fullscreen/maximize controls return terminal receipts directly.
`showGameWindowTab` uses the tab-activation transaction described below and does
not wait for or claim page readiness.

## Tab activation convergence

Tab pointer selection, tab-strip Ctrl+Tab, WebView2 accelerator Ctrl+Tab, AppKit
native selection, launcher selection, and `showGameWindowTab` all create one
`tabActivation` parent operation before native mutation. Its completion scope is
`tabActivationConverged`; the same operation ID, presentation revision, window
generation, lifecycle epoch, target tab, and ordered tab IDs remain frozen until
the terminal receipt. A newer activation in the same window supersedes the old
one, and late native, renderer, or Core acknowledgements cannot restore it.

macOS applies and verifies the AppKit active-tab selection idempotently even when
the native control already changed it. Windows submits a revision-fenced request
to the local tab-strip WebView before presenting the target content. The renderer
updates all active and ARIA states, reads the resulting active tab, and
acknowledges the exact operation ID, revision, and target. It ignores older
revisions instead of repainting stale selection.

Content presentation is authoritative after it has been acknowledged. A missing
Windows chrome acknowledgement triggers one bounded reconciliation containing
the complete ordered tab IDs and target. If that also fails while content is
known, the parent receipt is `degraded` with
`TAB_ACTIVATION_CHROME_NOT_CONFIRMED`; content is not rolled back. A Core commit
failure is retried once and then becomes `degraded` with
`TAB_ACTIVATION_STATE_COMMIT_FAILED`. Failure before native submission is
`failed`; an unknown content-presentation result is `indeterminate`. Same-tab
activation still performs convergence and can repair a prior chrome mismatch.

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

Additive fields remain compatible within version 4. Changing a terminal status,
completion scope, identity fence, popup/security policy, or ordering guarantee
requires a contract-version bump and matching macOS and Windows behavior tests.
macOS checks run locally where available; Windows native reachability and SDK
integration remain mandatory in `windows-latest` CI.
