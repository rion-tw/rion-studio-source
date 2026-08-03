# System WebView Runtime Contract

Contract version 3 defines the shared semantics for WKWebView on macOS and
WebView2 on Windows. It does not pretend that the native APIs are identical.
Rust orchestration owns the contract, while the AppKit/WKWebView and
Win32/WebView2 adapters implement it. Existing macOS behavior is the observable
reference for user-visible ordering, focus, visibility, and navigation behavior;
WKWebView APIs themselves are not an implementation template for Windows.

## Operation envelope and receipt

Every contract operation has one monotonic operation ID created before it is
submitted, plus a platform, subsystem, trigger, start time, deadline, explicit
completion scope, and any available revision, window, tab, role, or
surface-generation fence. Planning, coalescing, failure handling, diagnostics,
and public API responses retain that same ID and completion scope. A terminal
receipt uses one of these statuses:

- `applied`: the declared completion scope was reached.
- `superseded`: a newer revision, epoch, or surface generation replaced it.
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
passes its deadline is cancelled as `failed`; an operation whose native call
started but did not confirm before its deadline is `indeterminate`. The first
terminal receipt wins, so a late native callback cannot replace a timeout,
supersede, actor-stop, queue-full, or shutdown result.

## Shared subsystem semantics

| Subsystem | Shared guarantee | Native mechanism |
| --- | --- | --- |
| Surface lifecycle | Generation-fenced register, isolate, release, retire, or quarantine | WKWebView lifecycle callbacks / WebView2 controller callbacks |
| Navigation | Only a permitted main-frame HTTP(S) navigation or controlled reload can create an input-fence operation; the latest operation reaches page finish or is superseded, and automatic input resumes only after drain plus new-document proof | WKNavigation callbacks / WebView2 main-frame navigation callbacks |
| Input | Epoch- and generation-fenced native submission with bounded cleanup | AppKit event delivery / WebView2 native input |
| Presentation | Latest-only revisions coalesce tab surfaces and focus; a bounded per-window FIFO preserves non-idempotent visibility/fullscreen/maximized controls and returns native acknowledgement for the submitted native transaction | AppKit window and view APIs / Win32 and WebView2 controller APIs |
| Geometry and layout | Per-window serialized revision applies logical bounds, DPI conversion, child-surface layout, readback, and reverse-order compensation; asynchronous window modes declare native submission | AppKit content-layout geometry / Win32 window and WebView2 controller bounds |
| Popup | Owner-scoped, fail-closed policy; only `about`, `http`, and `https` are eligible | WKUIDelegate-backed Tauri callback / WebView2 NewWindowRequested-backed callback |
| Security | Policy installation succeeds before a role or popup becomes live | WKWebView policy adapter / WebView2 settings and event handlers |
| Session | Bounded cookie and LocalStorage transfer with readback and rollback | WKWebsiteDataStore / WebView2 profile data |
| Audio and zoom | Reversible fan-out followed by an atomic runtime-state commit | Per-view System WebView APIs |
| Metadata | Native tab metadata batch is submitted or reported degraded | AppKit tab controller / Windows tab-strip WebView evaluation |
| Performance and capability | Probe result carries evidence and policy mode, never inferred support | Platform runtime probe plus bounded foreground sampling |
| Shutdown | Idempotent drain rejects new work, fences input, isolates all managed surfaces under one deadline, and reports incomplete release or unknown isolation | Shared lifecycle registry plus platform release callbacks |

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
`showGameWindowTab` guarantees that native presentation has completed; it does
not wait for or claim page readiness. Persistent active-tab metadata is committed
separately and cannot turn an acknowledged presentation into a false failure.

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
capability evidence, active lifecycle/navigation counts, and at most 80 recent
operation summaries from the same registry used by API waiters. Summaries may
include stable IDs and error codes, but never
URLs, origins, session values, tokens, or native error messages.
Input-fence log contexts include the owning operation ID together with the input
epoch and surface generation, so every recovery event can be traced to its
main-frame or controlled-reload transaction without exposing page data.

Additive fields remain compatible within version 3. Changing a terminal status,
completion scope, identity fence, popup/security policy, or ordering guarantee
requires a contract-version bump and matching macOS and Windows behavior tests.
macOS checks run locally where available; Windows native reachability and SDK
integration remain mandatory in `windows-latest` CI.
