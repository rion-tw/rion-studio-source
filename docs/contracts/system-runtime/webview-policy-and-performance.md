# WebView Policy and Performance

This document is part of [System WebView Runtime Contract version 20](../../system-webview-runtime-contract.md). The entry document owns the contract version and routes readers to the minimum normative section required for a task.

## WebGL performance policy

Production does not expose a WebGL process-path setting. It never changes DPR,
canvas backing dimensions, WebGL context attributes, or page content.

On macOS, WKWebView owns the production WebGL execution path. Production leaves
`UseGPUProcessForWebGLEnabled`, `UseGPUProcessForDOMRenderingEnabled`, and
`UseGPUProcessForCanvasRenderingEnabled` untouched. The checked-in exact-build
catalog remains read-only evidence for WebGL command batching and never compares
version strings numerically. Explicit process-path and rendering-feature writes
exist only behind the isolated debug experiment gate.

The separate macOS high-refresh preference is `auto`, `enabled`, or `disabled`.
New or missing settings default to `disabled`; explicitly stored modes are not
migrated. `disabled` leaves WebKit's standard presentation preference untouched.
`auto` requests WebKit's high-refresh presentation feature when the selected
display is above 60 Hz. The preference is resolved before creating each role
WKWebView and takes effect after Rion Studio restarts.

On Windows, WebView2 owns the hardware-accelerated renderer and GPU-process path.
Production arguments never include GPU
VSync, frame-limit, in-process GPU, ANGLE selection, or sandbox-disabling flags.
Diagnostics enumerate renderer and GPU processes through
`ICoreWebView2Environment8::GetProcessInfos`, record the WebView2/Chromium runtime
version, and summarize `SystemInfo.getInfo` GPU evidence. The WebKit-specific
command-batching catalog is `notApplicable` on Windows. Missing supported evidence
is reported; it is never compensated by lower resolution or an
unsupported production flag.

Foreground diagnostics are operation-ID and revision fenced. Begin returns a
`waitingForFocus` operation, an exact runtime-window focus event starts the
1.5-second presentation sample, and terminal state is `completed`, `failed`, or
`cancelled`. Cancellation wakes the DeadlineBound sample and removes only the
matching operation's page probe. A readback deadline cannot become success. `presentationFps` is rAF
presentation cadence, not a page's timer/Wasm game-loop FPS counter. The probe
only reads dimensions and an already-exposed active `GLctx`; it never requests a
new context from a canvas.

Debug-only WebKit experiments run from an isolated Rion user-data directory.
They may load an explicitly supplied Safari Technology Preview framework and
select an exact WebGL/DOM-rendering A/B cell. The `matrix` launcher orders all
seven cells while reusing only that isolated login store. The `system-default`
cell leaves every WebKit feature preference untouched. Their overlay reads Emscripten's
public `MainLoop` counters every approximately 100 ms from the existing rAF
observer, does not replace timers or WebGL methods, and is removed on read,
cancel, supersede, or navigation. STP frameworks and experiment environment
switches are absent from production behavior.

Production macOS bundles and ordinary development bundles declare
`LSSupportsGameMode=true` and the games application category. macOS activates
Game Mode only after the user enters native fullscreen and deactivates it after
fullscreen exits; the metadata does not force a window state. The isolated
launcher may select `--game-mode=off|on`, defaulting to `off`, so an `off` control
omits both keys. A valid `on` sample requires native fullscreen and visible
confirmation that macOS activated Game Mode; metadata alone is not performance
evidence.

The loopback `/webgl-120` fixture supplies WebGL1 with `antialias:false`, native
DPR/backing size, a drift-corrected 120 Hz timer loop, a separate rAF loop, five
10-second samples after a 30-second warmup, and an optional 10-minute soak. The
acceptance helpers require FPS, presentation-frame pacing, reference-gap,
context-loss, native-surface, and
independently captured visual-output parity gates; no run passes merely by
reducing quality. The `flyff-like` profile reproduces the measured ratio of
draw, uniform, buffer, texture, and vertex-attribute state calls without adding
an artificial per-frame `gl.flush()`.


## Popup, security, and capability policy

### Workspace Web App surfaces

A workspace slot contains exactly one of a Role, a Web App, or nothing. A Web
App has a display name and an HTTP(S) start URL. Every launch starts at that URL;
last URL and history are not durable state. Main-frame HTTP(S) navigation may
cross origins. Each Web App owns a separate 34 logical-pixel local chrome WebView
above its website WebView. That sibling surface exposes Back, Forward, Reload,
Home, and an editable full HTTP(S) URL. A missing scheme becomes `https://`;
arbitrary search text and non-HTTP(S) schemes are rejected. The website DOM never
contains the Rion chrome, while tab audio and window zoom continue through the
shared native tab projection.

All workspace Web Apps and their controlled HTTP(S) popups share the single
Rion-owned `global-web` session. On Windows its WebView2 data directory is
`web-profiles/global-web/webview2`; on macOS it is the deterministic
`rion-studio:wkwebsite-data-store:global-web` WKWebsiteDataStore identifier.
This store is isolated from every Role store and from the renderer. Clearing it
is rejected while any owning surface or popup is live. Rion does not expose
profile CRUD or make Chrome profiles a runtime fallback.

Web App surfaces do not receive macro overlay or trusted-input features.
Permission requests are denied by default, certificate failures are fail-closed,
and unsupported navigation/popup schemes are denied. YouTube is the baseline
media compatibility target. Netflix and other DRM services are best-effort:
availability depends on the operating-system WebView's codec, EME, and account
policy and is not guaranteed by Rion Studio.

Website-initiated fullscreen on a Workspace Web App or its controlled popup is
contained to that WebView viewport. A document-start, all-frame policy owns the
standard Fullscreen API and WebKit compatibility aliases, promotes a requesting
child frame through an authenticated parent-frame relay, and presents the
requested element through the browser top layer or a fixed-position fallback.
The request Promise waits for the System Runtime to hide the sibling chrome and
expand the website WebView from its content bounds to the complete slot envelope.
While active it locks document scrolling. Site
exit, Escape, active-element removal, unload, and navigation restore the prior
document state from exact DOM events; no timer or polling loop establishes
fullscreen truth.

Contained fullscreen never changes the owning Rion native window state or the
geometry of sibling Workspace slots. macOS keeps
`isElementFullscreenEnabled` enabled so sites such as YouTube activate their own
fullscreen layout, while the document-start interposition prevents the request
from reaching native presentation. Before the first remote navigation, the
provisional `about:blank` document must pass a page-world wrapper and synthetic
enter/exit preflight while the native fullscreen state remains inactive. A
`WKWebView.fullscreenState` guard closes
unexpected media presentation and isolates the surface if an unintercepted path
enters native fullscreen. On Windows, interception occurs before WebView2 can
emit a host fullscreen transition. Role/Game WebViews
and user-initiated Rion window fullscreen are outside this policy. Sites that
depend exclusively on the engine's native `:fullscreen` pseudo-class or a
proprietary DRM fullscreen path remain best-effort and must not fall back to
owner-window fullscreen.

Popups without a managed Role/Web surface owner or with an unsupported scheme are denied before a
native window is created. A created popup must install security, lifecycle,
failure-monitor, zoom, ownership, and main-frame navigation handling before
registration. Popup resource and subframe activity never participates in the
role input-fence transaction. Failure at any stage closes the provisional window
and records a failed receipt.

`capabilityEvidence` reports each capability's runtime probe, policy mode,
evidence stage, and failure reason. `supported`, `degraded`, `unsupported`, and
`disabled` are explicit states; no feature may infer support solely from the
operating system name. `workspaceContainedFullscreen` uses the
`webview-bounded` policy mode and the
`documentStartPreflightHostGeometryAndNativeGuard` evidence stage.
