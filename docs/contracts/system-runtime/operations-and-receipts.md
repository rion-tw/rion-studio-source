# Operations and Receipts

This document is part of [System WebView Runtime Contract version 13](../../system-webview-runtime-contract.md). The entry document owns the contract version and routes readers to the minimum normative section required for a task.

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

Additive fields remain compatible within version 13. The completion policy,
subsystem, status, and
completion-scope values are generated Rust/TypeScript enums shared by Core,
Tauri, renderer, and tests. `projection` and `tabMutation` remain diagnostic
subsystems, but topology has no convergence receipt and no native/Core sink can
complete or compensate a live UI commit. Changing a terminal status,
completion scope, identity fence, popup/security policy, or ordering guarantee
requires a contract-version bump and matching macOS and Windows behavior tests.
macOS checks run locally where available; Windows native reachability and SDK
integration remain mandatory in `windows-latest` CI.

