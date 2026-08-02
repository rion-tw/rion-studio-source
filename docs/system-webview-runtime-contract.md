# System WebView Runtime Contract

Contract version 2 defines the shared semantics for WKWebView on macOS and
WebView2 on Windows. It does not pretend that the native APIs are identical.
Rust orchestration owns the contract, while the AppKit/WKWebView and
Win32/WebView2 adapters implement it. Existing macOS behavior is the reference
for user-visible ordering, focus, visibility, and navigation behavior.

## Operation envelope and receipt

Every contract operation has a monotonic operation ID, platform, subsystem,
trigger, start time, deadline, and any available revision, window, tab, role,
or surface-generation fence. A terminal receipt uses one of these statuses:

- `applied`: the declared completion scope was reached.
- `superseded`: a newer revision, epoch, or surface generation replaced it.
- `degraded`: the operation completed with a weaker verified guarantee.
- `failed`: the declared completion scope was not reached.
- `indeterminate`: native mutation may have occurred and compensation could not
  restore a known state.

The receipt's `completionScope` is part of the guarantee. In particular,
`nativeSubmission` does not claim that page JavaScript handled an input event,
and `stateCommit` does not claim that a later queued native paint has completed.

## Shared subsystem semantics

| Subsystem | Shared guarantee | Native mechanism |
| --- | --- | --- |
| Surface lifecycle | Generation-fenced register, isolate, release, retire, or quarantine | WKWebView lifecycle callbacks / WebView2 controller callbacks |
| Navigation | Latest operation reaches HTTP(S) page finish or is superseded; automatic input resumes only after drain plus new-document proof | WKNavigation callbacks / WebView2 navigation callbacks |
| Input | Epoch- and generation-fenced native submission with bounded cleanup | AppKit event delivery / WebView2 native input |
| Presentation | Latest-only revision applies tab surfaces, window visibility, focus, restore, and requested fullscreen/maximized mode; mode changes declare native submission because both shells may animate them asynchronously | AppKit window and view APIs / Win32 and WebView2 controller APIs |
| Popup | Owner-scoped, fail-closed policy; only `about`, `http`, and `https` are eligible | WKUIDelegate-backed Tauri callback / WebView2 NewWindowRequested-backed callback |
| Security | Policy installation succeeds before a role or popup becomes live | WKWebView policy adapter / WebView2 settings and event handlers |
| Session | Bounded cookie and LocalStorage transfer with readback and rollback | WKWebsiteDataStore / WebView2 profile data |
| Audio and zoom | Reversible fan-out followed by an atomic runtime-state commit | Per-view System WebView APIs |
| Metadata | Native tab metadata batch is submitted or reported degraded | AppKit tab controller / Windows tab-strip WebView evaluation |
| Performance and capability | Probe result carries evidence and policy mode, never inferred support | Platform runtime probe plus bounded foreground sampling |

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

## Lifecycle and readiness rules

- A surface identity is `(instanceId, generation, windowId)`. Stale generations
  cannot receive navigation, input, presentation, or recovery work.
- Closing first fences input, then proves isolation. An unverified close becomes
  `indeterminate`, quarantines the role, and blocks relaunch until recovery.
- `pageFinished` means the engine completed an HTTP(S) navigation callback.
- `inputReady` is stronger: Core input drained, a different completed document
  instance was observed, and the native input epoch resumed.
- Timeouts never silently become success. A newer operation becomes
  `superseded`; an unknown native result becomes `indeterminate`.

## Popup, security, and capability policy

Popups without a role owner or with an unsupported scheme are denied before a
native window is created. A created popup must install security, lifecycle,
failure-monitor, zoom, ownership, and input-fence handling before registration.
Failure at any stage closes the provisional window and records a failed receipt.

`capabilityEvidence` reports each capability's runtime probe, policy mode,
evidence stage, and failure reason. `supported`, `degraded`, `unsupported`, and
`disabled` are explicit states; no feature may infer support solely from the
operating system name.

## Diagnostics and compatibility

`SystemRuntimeDiagnosticsRecord` publishes the contract version, capability
evidence, active lifecycle/navigation counts, and at most 80 recent operation
summaries. Summaries may include stable IDs and error codes, but never URLs,
origins, session values, tokens, or native error messages.

Additive fields remain compatible within version 2. Changing a terminal status,
completion scope, identity fence, popup/security policy, or ordering guarantee
requires a contract-version bump and matching macOS and Windows behavior tests.
macOS checks run locally where available; Windows native reachability and SDK
integration remain mandatory in `windows-latest` CI.
