# WebView Policy and Performance

This document is part of [System WebView Runtime Contract version 13](../../system-webview-runtime-contract.md). The entry document owns the contract version and routes readers to the minimum normative section required for a task.

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
five cells while reusing only that isolated login store. Their overlay reads Emscripten's
public `MainLoop` counters every approximately 100 ms from the existing rAF
observer, does not replace timers or WebGL methods, and is removed on read,
cancel, supersede, or navigation. STP frameworks and experiment environment
switches are absent from production behavior.

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


