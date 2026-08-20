# Lifecycle and Recovery

This document is part of [System WebView Runtime Contract version 17](../../system-webview-runtime-contract.md). The entry document owns the contract version and routes readers to the minimum normative section required for a task.

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
- On macOS the native navigation delegate requires a non-null
  `targetFrame.isMainFrame` and excludes new-window, same-URL, and fragment-only
  actions. Tauri's generic macOS navigation callback enforces URL-scheme policy
  only. Windows continues to use WebView2's top-level navigation event.
- macOS and Windows share the observable ordering: synchronously close Core and
  native input before allowing the main-frame navigation, asynchronously drain
  that epoch once, then wait for the matching generation's page finish and new
  document proof. Platform adapters may use different native APIs to provide it.
- A navigation deadline belongs to one current deadline-bound main-frame or
  controlled-reload operation. Failure marks the exact input epoch
  `restart-required`; it never reloads, navigates, closes, replaces, or otherwise
  mutates the still-live page. Resource activity cannot start or reset it.
- Timeouts never silently become success. A newer operation becomes
  `superseded`; an unknown native result becomes `indeterminate`.
- Page-finish timeout, initial page-ready failure, Core or native input-resume
  rejection, popup input-fence failure, layout-channel loss, and WebView2
  renderer unresponsiveness all preserve the current URL, DOM, session, surface
  identity, and generation. They isolate automatic input and publish a
  non-blocking restart-required warning; direct player keyboard and pointer
  input remain available. Only role stop followed by relaunch clears this state.
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

## Process-death surface recovery

An authoritative native process-termination event is the only legal source of
automatic surface replacement: `webViewWebContentProcessDidTerminate` on macOS,
or WebView2 browser/render process-exited on Windows. Renderer unresponsive is
not process termination and cannot enter this contract. Every recovery request,
including a retry deferred across sleep/wake, carries the original verified
termination evidence; no navigation, layout, popup, readiness, input, or generic
runtime failure may manufacture it.

Verified process death creates one `SurfaceRecoveryAttemptRecord` and one optionally
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

### Indeterminate macro-input recovery

An actually focused iframe is a temporary non-game automatic-input context.
The overlay reports only focus, pointer-lock, and Canvas focus/pointer events as
the authoritative `game`, `embedded-frame`, or `document` context stream. It
does not inspect frame URLs, providers, or DOM content, and frame presence alone
does not pause input. Every event is fenced by role capability, WebView label,
surface generation, document instance, and monotonic context revision.

Before normal Focus, Key, or Click native submission, the runtime reads the
same context snapshot. `embedded-frame` fails admission with
`SYSTEM_AUTOMATIC_INPUT_CONTEXT_BLOCKED` before native input is sent; cleanup
keyup and mouseup remain admissible. Core captures restart intent before the
blocked action wakes its invocation, drains the old tree, and remains
event-bound until the same document and generation report `game`. A `document`
context never resumes automatically. Eligible toggle and loop roots restart
once from their beginning; while-held roots remain stopped. Multi-role restart
intent remains deferred until every involved role is input-admissible.

Role, tab, and window teardown advances the native input epoch and drains the
exact per-role input lane before native surface isolation. An input callback
that was already admitted must terminalize while its WebView is still attached;
cleanup from an older Core epoch that has not started is superseded. Native
surface release never overtakes either outcome.

This context recovery never reloads or replaces the live page, changes surface
generation, or marks the role restart-required. Main-frame navigation
supersedes it and invalidates old-document context events. Only a rejected Core
or native resume converts the live role to restart-required.

An indeterminate native key or pointer acknowledgement starts one recovery
transaction keyed by the failing browser-action request ID and role ID. Core is
the owner of restart intent: before the failed result wakes the old invocation,
it advances the role input epoch, marks every affected root invocation
`recovering`, captures eligible root starts in original invocation order, and
cancels the old invocation tree. Repeated failure delivery for the same role
replays the active ticket rather than scheduling another restart.

The System Runtime immediately disables the role's native input lane and drains
the matching Core epoch. The indeterminate action result and proof of a neutral
input state are tracked separately. An acknowledged guarded `keyup` or
`mouseup` compensation proves neutrality. Otherwise, an already-fenced
main-frame navigation must finish on the same surface generation with a changed
document instance before recovery may continue. Pending navigation waits for its
existing page-finished event and document-instance readback; popup close keeps
using the popup input fence. No URL, provider, or authentication-domain rule is
part of this decision.

Once every navigation ticket is complete, only the exact input epoch and surface
generation may resume Core and the native input lane. The runtime then claims
the restart ticket and Core re-resolves the current macro configuration and
active roles before restarting each still-eligible root once. It never resumes
an old worker or replays an in-flight step. Zero-interval loops are eligible.
While-held invocations are excluded because their physical hold lease cannot be
reconstructed. A visible Stop action, a relevant macro mutation, role close, or
role restart cancels pending restart intent.

Macro-input recovery never schedules surface recovery, reloads the page, or
rebuilds the role WebView. If cleanup, document readback, Core resume, or native
resume cannot be proven, the current page remains authoritative, automatic input
stays quarantined, and Core marks the role restart-required until it is
explicitly relaunched. Independent WebView process failure remains governed by
the surface-recovery contract above and may complete an already-active macro
ticket after its replacement surface is proven. Diagnostics distinguish
`in-place` from `manual-restart-required` and retain the recovery ID and pending
root count on active and recent input-fence records. This flow adds no
reconciliation poll or success timer: browser-action result, compensation
receipt, Core drain, page-finished/document-instance readback, input resume, and
restart claim are the authoritative ordered events.

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
