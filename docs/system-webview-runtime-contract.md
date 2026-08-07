# System WebView Runtime Contract

Contract version 12 defines the shared semantics for WKWebView on macOS and
WebView2 on Windows. It does not pretend that the native APIs are identical.
Rust orchestration owns the contract, while the AppKit/WKWebView and
Win32/WebView2 adapters implement it. Existing macOS behavior is the observable
reference for user-visible ordering, focus, visibility, and navigation behavior;
WKWebView APIs themselves are not an implementation template for Windows.

## Operation envelope and receipt

Every contract operation has one monotonic operation ID created before it is
submitted, plus a platform, subsystem, trigger, acceptance time, explicit
completion policy, completion scope, and any available revision, topology revision,
window generation, lifecycle epoch, session, window, tab, role, parent
operation, or surface-generation fence. Planning, coalescing, failure handling,
diagnostics, and public API responses retain that same ID and completion scope.
A deadline-bound operation also carries its accepted deadline. An event-bound
operation carries no deadline and completes only from its exact authoritative
event, cancellation, supersede, actor stop, or event-stream failure.
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
receipts. Active entries are never evicted to make room. For deadline-bound
work, a queued operation that passes its deadline is `failed`; an operation
whose native call started but did not confirm before its deadline is
`indeterminate`. Event-bound work never terminalizes because time elapsed.
Lifecycle cancellation is
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
| Tab activation | The live tab UI commits a latest-only revision immediately; native active style, visibility, and focus only follow that revision. There is no activation receipt coordinator, chrome acknowledgement gate, or Core active-tab command | AppKit tab controller and presentation / WebView2 controller presentation plus the local tab-strip WebView |
| Tab mutation | AppKit or HTML commits the complete post-intent topology to `LiveWindowTabStore` in one short memory transaction. Native surfaces retry toward it and SQLite consumes latest-only snapshots; neither can compensate the visible tabs | AppKit tab controller and lifecycle / Win32, WebView2 controllers, and the local tab-strip WebView |
| Tab chrome projection | One complete, revisioned projection replaces native tab metadata, order, active state, ARIA state, toolbar, display, language, and theme | Idempotent AppKit projection and readback / instance-fenced Windows tab-strip hydration and acknowledgement |
| Geometry and layout | User move/resize commits placement directly to the live store and queues latest-wins persistence without readback or compensation. Programmatic fullscreen/maximize and surface layout retain generation-fenced native transactions | AppKit content-layout geometry / Win32 window and WebView2 controller bounds |
| Popup | Owner-scoped, fail-closed policy; only `about`, `http`, and `https` are eligible | WKUIDelegate-backed Tauri callback / WebView2 NewWindowRequested-backed callback |
| Security | Policy installation succeeds before a role or popup becomes live | WKWebView policy adapter / WebView2 settings and event handlers |
| Session | Bounded cookie and LocalStorage transfer with readback and rollback | WKWebsiteDataStore / WebView2 profile data |
| Audio and zoom | Reversible native fan-out followed by a live-state commit; saved-window durability is latest-revision-wins and never compensates the visible UI | Per-view System WebView APIs |
| Metadata | Native tab metadata batch is submitted or reported degraded | AppKit tab controller / Windows tab-strip WebView evaluation |
| Performance and capability | Probe result carries evidence and policy mode, never inferred support | Platform runtime probe plus bounded foreground sampling |
| Shutdown | Idempotent drain rejects new work, fences input, isolates all managed surfaces under one deadline, and reports incomplete release or unknown isolation | Shared lifecycle registry plus platform release callbacks |
| Display topology | One revision-fenced snapshot drives remap, native movement, state commit, projection publication, and reverse-order compensation | NSScreen notifications and geometry / Win32 display notifications and geometry |
| Window lifecycle | The final live snapshot and visible close commit are immediate and idempotent. Exact role isolation and controller release follow in background without deciding whether the window may close | NSWindow lifecycle / Win32 window lifecycle |
| Focus | One global intent lease owns focus across the main window and every runtime window; native observation confirms or supersedes it | AppKit activation and focus observation / Win32 foreground and focus observation |
| Drag | Visible motion is immediate UI work. Every in-strip order change flows one way from AppKit/HTML into `LiveWindowTabStore`, then into a debounced latest-wins SQLite snapshot; neither gesture adapter waits for Core, SQLite, persistence, native readback, or a receipt | AppKit live window/tab drag adapter / Windows tab-strip pointer adapter |
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
Tab topology commits only to `LiveWindowTabStore`, then queues native
presentation. Geometry and window-mode operations retain their own native
receipts, but neither Core nor SQLite participates in a tab UI commit.

`LiveWindowRecord` and `LiveTabRecord` contain topology and persistence demand
only. Native bindings, desired/applied follower revisions, and host visibility
live in `NativeTabProjectionStore`; loading, degraded, and provisional phases
live in `TabRuntimeStatusStore`. These stores do not share a mutable record, so a
native or status update cannot acquire topology write access by construction.

Platform-specific code may perform the native calls inside the adapter or a
bounded rollback transaction. It must not make an independent product decision
about the active tab or visible role.

Runtime window close captures the final immutable live snapshot, installs one
tombstone per live tab, removes the live window, and submits native close before
starting Core role cleanup. Repeated or late callbacks are silent
`superseded`. A surface-isolation uncertainty may quarantine an exact role
owner, but it cannot restore the window or any tab. `rion://window-lifecycle`
therefore reports the visible state commit; background cleanup has its own
generation-fenced diagnostics.

The teardown scope is the exact tab-ID list read from `LiveWindowTabStore` when
close is accepted. Core launch-time `windowId` metadata is never used to infer
that scope: a tab detached into another live window survives closing its source,
even while Core role bookkeeping is still settling. The explicit list flows
one way into role isolation and cannot move or restore visible tabs.

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
registered placeholder label and generation-fenced tab, slot, role, and owner.
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
with its terminal receipt. Unhiding and `showGameWindowTab` commit the live
selection immediately and queue visibility/focus as forward-only native work;
they do not wait for or claim page readiness.

## One-way tab activation

Tab pointer selection, tab-strip Ctrl+Tab, AppKit native selection, launcher
selection, and `showGameWindowTab` first commit a new `LiveWindowTabStore`
revision. The visible selection is complete at that boundary. Renderer-facing
calls receive an immediate `applied` topology result after background native
presentation has been queued; AppKit and HTML callbacks never wait for it.

Content focus and native active-style projection run after that commit. Core has
no active-tab projection or selection mutation. Presentation work is latest-only
by window. A newer revision supersedes older work, and a late native completion
cannot repaint the old tab. There is no activation convergence timeout or
renderer acknowledgement. Same-tab activation may still enqueue idempotent
native repair work, but it never delays the UI callback or surfaces a shell
error.

## Tab topology mutation transactions

AppKit or the local HTML tab strip commits move, move-to-new-window, hide,
reorder, selection, and close intents directly to `LiveWindowTabStore`. Every
insert, replacement, removal, reorder, move, selection, audio, zoom, divider,
and placement change advances a monotonic live revision. Cross-window moves
lock both live windows in stable ID order and commit them together; there is no
post-commit memory rollback.

Move, hide, reorder, and selection do not emit a Core topology command. The
per-tab lifecycle lane remains only for destructive owner work such as stop,
where repeated requests join the same operation and role generation fences
prevent a second login surface. That owner receipt cannot define, reject, or
compensate the already committed tab UI.

The generated stop request retains identity and generation fences for owner
work and diagnostics. Expected Core order, SQLite state, and native chrome
readback are absent from the public mutation contract. Native chrome mismatch
is reconciled and logged in the background. A failed surface reparent retains
the live destination and schedules forward projection; it never moves the tab
back to an older owner snapshot.

## Native tab chrome projection

`RuntimeTabChromeProjectionRecord` is the complete native tab-chrome authority.
Presentation state supplies visible order, active tab, and hidden state; the
Core owner snapshot may refresh matching role metadata but cannot add, remove,
move, select, or hide a tab. The projection also carries the exact window generation, lifecycle
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

One process-wide persistence coordinator keeps only the newest dirty revision
for each saved live window. A 200 ms debounce coalesces revisions and writes the
current set of dirty windows in one SQLite transaction: placement,
ordered tabs, active tab, role-slot demand, zoom, hidden state, and audio state.
Runtime role ownership is never serialized. Core compares
`(windowId, windowGeneration, revision)` and returns `superseded` for an older or
duplicate write.

An applied live snapshot fences that saved tab order for the lifetime of the
window. Later Core owner or launch-phase projections may refresh matching tab
metadata, but they cannot replace the live order, selection, visibility, or
SQLite order. The fence retires when the live window generation closes.

A failed batch leaves every newest snapshot dirty. Retries use 250 ms, 1 s, 5 s,
then bounded exponential backoff up to 30 s. Failure never mutates
`LiveWindowTabStore` or native chrome. Snapshot construction reads only the
already-committed in-memory live tab and runtime metadata; it does not query
Core, SQLite, AppKit, or a WebView. `LiveWindowTabStore` itself retains complete
persistable tab and role-slot metadata, so teardown never reconstructs topology
from Core or a native host. Window close immediately enqueues that final live
revision before teardown, continues closing without waiting, and retains the
captured input so retries do not depend on a native window handle. Application
exit makes one immediate dirty-revision enqueue and records any remaining
revision without blocking shutdown.

“Save as New Game Window” captures the same complete live-window record and
writes it directly through domain validation to SQLite. A detached transient
window is not required to exist in Core's role-ownership snapshot, and Core
cannot reject the save because its launch-time window association differs.
Native title/menu refresh is a downstream projection: failure defers that
refresh and never deletes or rolls back the saved Game Window.

Saved-window restore seeds the complete `LiveWindowTabStore` and native tab
chrome in saved order before starting any role surface. Surface creation may
still prioritize the saved active tab for first paint and role ownership, but
that owner-priority sequence is never observable as tab-strip insertion order.
Each later create replaces the matching reserved presentation item in place;
there is no final corrective reorder after the window becomes visible.

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

A runtime tab drag has one stable tab identity and a lifecycle fence from
pointer-down to drop. Gesture completion is not receipt- or deadline-gated;
duplicate and late semantic events are silent `superseded`. A newer user gesture supersedes older background projection;
old source order, Core order, persistence revision, or native readback cannot
reject the final order currently visible in the UI. An accepted AppKit or HTML
drop is never visually compensated by a later Core, surface-transfer, or SQLite
failure. Core advances role ownership only, WebView transfer retries toward the
committed host, and the retained live-window revision retries durability
independently.

On macOS, AppKit owns the held gesture and updates in-strip reorder previews and
insertion indicators synchronously. Each changed preview reports its complete
visible order; the native callback commits that order under one short
`LiveWindowTabStore` lock and schedules persistence without querying Core,
SQLite, WebViews, or native readback. The equivalent Windows HTML preview emits
the same complete-order intent. Hover intents are coalesced and SQLite writes
are debounced latest-wins, so intermediate orders may be skipped on disk but
never applied backward to the UI. Leaving every tab-strip hit region uses the
original live native-window preview: coalesced pointer samples enter only the
in-memory SystemRuntime lane, which creates or positions the provisional native
window and moves the real WKWebView surface. It never captures a frozen game
viewport or tab bitmap and never consults Core or SQLite. The AppKit dragging
item stays transparent so only the current titlebar's real tab UI is visible.
Returning to a tab strip reparents
the same surface into the hovered live host. The macOS live-drag transfer never
hides a WKWebView before reparenting, never makes the held AppKit tab transparent
when it exits a strip, and promotes the target insertion slot to the real tab in
the same native layout pass. Full role/divider layout runs only after that visible
transfer; transient move and hover samples are latest-wins across both event
types. These native transitions run behind the AppKit callback, so no receipt,
persistence result, Core layout, or topology readback can block pointer delivery.
The terminal drop only closes the drag lifecycle and materializes any pending
cross-window surface transfer. It does not reorder AppKit again: the visible
order is already live and persistence continues on its independent latest-wins
background lane. Cancellation only releases drag cursor, motion, and
pointer-pass-through resources. The last topology already visible in AppKit or
HTML remains live; cancellation never restores a source snapshot.
Pointer pass-through is a session- and window-generation-scoped lease. A
terminal callback atomically retires only its own lease, immediately restores
mouse handling on every involved host, and reasserts a newer lease if another
drag started during the native call.

Activation, native tab-menu lookup, and close resolve a tab's window from
`LiveWindowTabStore`. A temporarily stale Core/surface owner can only schedule a
background surface move toward that live owner; it cannot move the live tab back
to the runtime's older window. Native close commits the live tombstone in the
AppKit callback turn before Core stop and controller release continue in the
background.

A newly observed native drag session supersedes an abandoned macOS session whose
terminal destination callback was not delivered. Late callbacks for a completed,
superseded, or never-accepted session are idempotent no-ops and never surface a
`TAURI_TAB_DRAG_STALE` user error.

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
- A navigation deadline belongs to one current deadline-bound main-frame or
  controlled-reload operation. Recovery is valid only while that operation ID,
  input epoch, and surface generation remain current; resource activity cannot
  start or reset it.
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

Additive fields remain compatible within version 12. The completion policy,
subsystem, status, and
completion-scope values are generated Rust/TypeScript enums shared by Core,
Tauri, renderer, and tests. `projection` and `tabMutation` remain diagnostic
subsystems, but topology has no convergence receipt and no native/Core sink can
complete or compensate a live UI commit. Changing a terminal status,
completion scope, identity fence, popup/security policy, or ordering guarantee
requires a contract-version bump and matching macOS and Windows behavior tests.
macOS checks run locally where available; Windows native reachability and SDK
integration remain mandatory in `windows-latest` CI.
