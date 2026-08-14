# WebGL performance validation — 2026-08-13

This report records the local macOS investigation behind the System WebView
contract version 13. It is an engineering result, not a claim that the product
has reached the acceptance target.

## Test host and reference

- macOS host with a 60 Hz Studio Display.
- Rion Studio Dev using the system WKWebView.
- Brave Browser `150.1.92.144` as the Chromium reference.
- Rion cells reused one isolated role and scene with the in-game 120 FPS setting
  and VSync disabled. The Brave reference used the user's separate live role in
  a comparable field, so it is evidence of the engine gap rather than formal
  same-account parity. The page's public Emscripten frame counter is recorded
  as game-loop FPS; it is not treated as presentation FPS.
- Brave's running browser, renderer, and GPU process command lines did not
  contain `--disable-gpu-vsync`, `--disable-frame-rate-limit`, `--in-process-gpu`,
  or `--use-angle`. Its renderer did use Chromium's normal zero-copy, GPU memory
  buffer compositor, and four raster-thread path. ANGLE selected Metal without a
  user flag.

The live `brave://gpu` report additionally showed hardware-accelerated Canvas,
Compositing, Rasterization, and WebGL; multiple raster threads; Skia Graphite
with `GraphiteDawnMetal`; an out-of-process sandboxed GPU service; and the
passthrough command decoder. Its browser command line had an empty user
`flag-switches` section. The only listed Canvas workaround was
`disable_2d_canvas_auto_flush`, which applies to Chromium's 2D Canvas path and
does not explain Flyff's WebGL call stream.

## Results

| Case | Native canvas | Game-loop FPS | p10 | Presentation/tail result | Decision |
| --- | ---: | ---: | ---: | --- | --- |
| Brave, ANGLE Metal reference | 5.44 MP | 115.26 | — | in-game loop probe | Reference |
| System WebKit GPU process, matched large canvas | 8.91 MP | 88.86 | 80.0 | 59.80 FPS; 3 missed; 57 ms max | Failed |
| STP 249 GPU process, matched large canvas | 8.91 MP | 87.01 | 80.0 | 59.98 FPS; 0 missed; 21 ms max | Smoother tail, FPS failed |
| System WebKit direct, earlier native window | 6.28 MP | 88.90 | 80.8 | 60.0 FPS; timer drift 7 ms | Failed; no 15% gain |
| STP 249 direct | — | — | — | Flyff remained on `Loading... Please wait` for over one minute | Compatibility failure |
| STP 249 GPU + DOM rendering override | 5.61 MP | 90.16 | 80.8 | 59.48 FPS; 8 missed; 78 ms max | Failed |
| STP 249 GPU + DOM + Canvas + high refresh | 8.91 MP | 89.8 | 89.1 | 60.1 FPS; 0 missed | Failed; retained dev baseline |

The final same-canvas comparison is the system GPU-process row against STP 249
GPU-process: both used a 4096 × 2176 backing canvas at DPR 2. Command batching
reduced timer drift from 16 ms to 7 ms and removed the observed missed-vsync
tail, matching the subjective report that STP could feel slightly smoother.
It did not raise Flyff's game loop: the mean decreased by about 2.1%, and both
p10 results were 80 FPS. Batching is therefore useful upstream tail-latency
work, but is not the cause or solution for the 90 FPS game-loop ceiling.

The direct-WebGL result likewise did not meet the planned requirement of at
least 15% improvement, median FPS at least 110, p10 at least 100, and no more
than 10% behind the better reference browser. The previous provisional direct
certification is withdrawn; it must not be presented as a complete performance
fix or selected by production policy.

An experiment explicitly set both
`UseGPUProcessForWebGLEnabled` and
`UseGPUProcessForDOMRenderingEnabled` to `YES`, a clean dev restart reported
`maximum-webgl=applied`. The processes created with that run included the
WebKit GPU, Networking, and WebContent XPC services. In the same visible scene,
two warmed foreground observations showed 84–86 FPS in Rion while the
already-running Brave reference showed 115 FPS. This confirms that the requested
paired GPU-process configuration was applied, but it did not close the engine
gap and was retracted before further Canvas-path investigation.

The follow-up dev-only `stp-gpu-process-all-rendering` cell uses the exact STP
249 feature key `UseGPUProcessForCanvasRenderingEnabled` (not the nonexistent
`UseGPUProcessForCanvasEnabled`) and explicitly enables it together with WebGL
and DOM rendering in the GPU process. A clean role creation reported all three
feature writes as `applied`, high refresh as `applied`, WebKit `21626.1.1`, and
command batching as `VerifiedAvailable`. Command batching is part of that WebKit
build's `RemoteGraphicsContextGL` implementation and has no separate runtime
preference. The real-page sample still failed the 120 FPS target and remains a
development baseline rather than a production policy change.

A controlled loopback WebGL1 fixture confirmed that both engines can reach the
120 FPS timer target for a light workload. With 80 fixed draw calls and 6 ms of
fixed per-tick CPU work, Rion measured about 83.4–83.6 FPS and Brave about
93.9 FPS. Canvas CSS size, backing pixel size, DPR, and WebGL context attributes
were held constant.

## Canvas-path follow-up

Flyff renders into an HTML canvas, but its measured hot path is WebGL rather than
the 2D Canvas API. WebKit keeps these paths separate:

- `UseGPUProcessForCanvasRenderingEnabled` controls `RenderingPurpose::Canvas`
  ImageBuffers.
- `UseGPUProcessForWebGLEnabled` independently selects either
  `RemoteGraphicsContextGLProxy` or a WebContent-process `GraphicsContextGL`.
- `UseGPUProcessForDOMRenderingEnabled` controls DOM, layer-backing, and snapshot
  ImageBuffers; it does not choose the WebGL context implementation.

Those branches are explicit in WebKit's
[`UnifiedWebPreferences.yaml`](https://github.com/WebKit/WebKit/blob/main/Source/WTF/Scripts/Preferences/UnifiedWebPreferences.yaml),
[`WebProcess::shouldUseRemoteRenderingFor()`](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/WebProcess/WebProcess.cpp),
and
[`WebChromeClient::createGraphicsContextGL()`](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/WebProcess/WebCoreSupport/WebChromeClient.cpp).
`HTMLCanvasElement` also creates 2D and WebGL contexts through distinct branches
in [WebKit's canvas implementation](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/html/HTMLCanvasElement.cpp).

A same-scene development A/B retained direct WebGL and changed only Canvas
ImageBuffer placement. With WebKit's default GPU-process Canvas path, Rion
showed 86–88 FPS; forcing Canvas ImageBuffers into WebContent showed 84–86 FPS,
while the same-moment Brave reference showed 116 FPS. The experimental Canvas
override was reverted. It neither owns Flyff's WebGL calls nor improves the
observed result.

The Safari Technology Preview 185 WebGPU recipe was also reproduced as a
development-only A/B by enabling `WebGPUEnabled`,
`UseGPUProcessForCanvasRenderingEnabled`, and
`UseGPUProcessForDOMRenderingEnabled`. Flyff continued to render through its
existing WebGL context; WebGPU availability does not translate WebGL commands
or replace the page's rendering API. With direct WebGL, four same-scene samples
were 90, 87, 90, and 88 FPS (median 89), which was within the baseline's normal
variation. Enabling GPU-process WebGL as well produced 84, 84, 84, and 86 FPS
(median 84). Both combinations were rejected and every WebGPU/Canvas/DOM
override was removed. The experiment follows the flag combination documented
in [WebKit's STP 185 announcement](https://webkit.org/blog/14879/webgpu-now-available-for-testing-in-safari-technology-preview/),
but it is not an optimization for a page that never requests a `webgpu` canvas
context.

A later isolation test copied the existing 4096 × 2176 WebGL canvas into a
second `GPUCanvasContext` once per presentation frame. Against the same STP 249
GPU + DOM + Canvas baseline, game-loop FPS fell from 89.8 (p10 89.1) to 25.8,
and presentation fell from 60.1 to 26.2 FPS. It introduced a full-resolution
WebGL-to-WebGPU copy and did not remove the underlying WebGL command path. The
mirror implementation, contract fields, launcher mode, and UI were removed.

## WebGL-to-WebGPU overlay feasibility

A development-only document-start experiment then tested the stronger proposal:
intercept Flyff's `canvas.getContext("webgl", ...)` calls and return a WebGL API
implemented on WebGPU. The experiment bundled the current main branch of
[ByeGL](https://github.com/software-mansion/byegl), used its synchronous
document-start interception path, and exposed a visible in-page trace instead
of attaching Safari Inspector to the anti-debugging production page. No part of
this injection is retained in Rion.

The first run successfully created a WebGPU device and returned translated
contexts, but Flyff failed before its first GL method call. The trace isolated
the caller to Emscripten's `GL.createContext` in Flyff's public
[`main-wasm32.js`](https://cdn-universe.flyff.com/client/program/web/main-wasm32.js).
That runtime applies a Safari-specific brand check requiring the returned value
to be an instance of `WebGLRenderingContext`. ByeGL's translated object was
branded only as `WebGL2RenderingContext`. Preserving the required WebGL brand
crossed that boundary and allowed Flyff to enter shader and draw setup.

The deeper run established that this is an incomplete renderer port, not a
configuration switch:

- Flyff calls `getContext("webgl", { majorVersion: 2, ... })`; ByeGL selected its
  version only from the context-name string. A diagnostic patch was required to
  honor Emscripten's `majorVersion` attribute.
- Flyff immediately reached ByeGL methods that its current source marks as
  unimplemented. `bindAttribLocation()` and `detachShader()` threw until
  diagnostic no-ops were substituted. A correct implementation must preserve
  explicit attribute locations rather than ignore them.
- After shader setup, Flyff reached `compressedTexImage2D()`. ByeGL currently
  throws `NotImplementedYetError` for both compressed texture upload methods;
  the resulting canvas was black. Correct support requires compressed-format
  capability negotiation, WebGPU texture features or transcoding, upload
  semantics, and output validation.
- ByeGL's current `getExtension()` returns `null` and
  `getSupportedExtensions()` returns an empty list, while Flyff's Emscripten
  runtime initializes and depends on the WebGL extension surface.

The experiment therefore proves that an overlay can intercept Flyff and begin
translating its real command stream to WebGPU, but the available translation
layer cannot run the game correctly and cannot be benchmarked for FPS. Shipping
it would require maintaining a substantial WebGL compatibility implementation,
then performing image-equivalence, context-loss, soak, and performance testing.
It is rejected as a Rion runtime optimization unless a mature translator first
passes the existing native-resolution fixture and Flyff acceptance gates.

## Cause isolated on macOS

Direct WebGL removed the previous hot stack through
`RemoteGraphicsContextGLProxyCocoa::prepareForDisplay`, synchronous IPC, and
`waitForSyncReply`. A subsequent stack sample instead showed the WebContent
timer/Wasm callback issuing many small WebGL calls directly through WebCore,
`GraphicsContextGLANGLE`, and ANGLE's Metal backend. The remaining gap is
consistent with per-call WebCore/ANGLE validation and state setup versus
Chromium's command-buffer batching architecture.

The following controlled experiments did not materially improve Flyff and were
not retained: high-refresh mode on a 60 Hz display, App Nap changes, background
throttling changes, Canvas/DOM GPU-process changes, removing Rion page
injections, matching visible viewport size, process latency priority, and an
unsafe private minimum-DOM-timer setter. The timer setter could prevent WKWebView
creation and is unsuitable for production.

An injected-bundle development harness was also used to ensure ANGLE environment
overrides ran inside the WebContent XPC process rather than merely being set on
the Rion UI process. The same existing process pool remained in use; an empty
bundle was the control. None of the candidates beat the direct-WebGL control:

| Development-only A/B | Warm Flyff observation | Decision |
| --- | ---: | --- |
| Empty ANGLE override control | about 92 FPS | Control |
| `preferCpuForBuffersubdata` | about 88 FPS | Rejected |
| `alwaysUseSharedStorageModeForBuffers` | about 83 FPS | Rejected |
| `hasCheapRenderPass` | about 86 FPS | Rejected |
| `alwaysPreferStagedTextureUploads` | about 80 FPS | Rejected |

The final item deliberately reversed one of WebKit's explicit ANGLE overrides;
the result matched WebKit's source warning about excess staging-buffer
allocations. `enableInMemoryMtlLibraryCache` was not promoted to a runtime test:
it affects shader-library creation rather than steady-state draw submission, and
WebKit disables it because it retains all program binary objects. No injected
bundle or ANGLE environment override is retained in the product.

JSC configuration was delivered through WebKit's process-pool configuration
directory so the settings were known to reach WebContent. Earlier OMG tier-up,
a doubled Wasm inlining budget, and `wasmOMGOptimizationLevel=3` all failed to
improve the steady state; aggressive tiering or optimization also introduced
compile stalls. DOM timer throttling, RunningBoard background throttling, direct
Canvas rendering, and the applied high-refresh feature were each tested
separately. They observed roughly 84–90 FPS and were not retained. Disabling
both Canvas and DOM GPU-process rendering produced a black surface and was
immediately rejected.

## Retained implementation policy

- Keep native resolution, DPR, canvas backing dimensions, WebGL attributes, and
  page content unchanged.
- Leave the production WebGL process path at the System WebView engine default
  on macOS and Windows. Keep direct/GPU-process feature writes isolated to the
  debug experiment harness.
- Retain exact-build WebGL command-batching evidence and performance-target
  status independently. Numeric version ordering is never used as a capability
  guess, and batching evidence does not mean a performance target passed.
- Do not add Chromium development graphics flags to production.
- Report rAF cadence as `presentationFps`, separately from a page's game-loop
  counter.
- Keep the event-fenced foreground diagnostic operation and the loopback fixture
  so future WebKit releases can be re-evaluated against the same gates.

## Post-26.5 WebKit batching follow-up

The host loads WebKit `21624.2.5.11.4`, corresponding to the public
`WebKit-7624.2.5.11.4` source tag. That tag already uses a 2 MiB
`IPC::StreamClientConnection` command stream, but its
`RemoteGraphicsContextGL.messages.in` does not mark the high-frequency Flyff
state commands as batched. The same absence was confirmed in the public 26.6
branch through `WebKit-7624.4.5.14.1`.

WebKit revision
[`314547@main`](https://github.com/WebKit/WebKit/commit/74b74c4672ee8a942687c52f88700970a78799ef),
committed on 2026-06-04, changed `RemoteGraphicsContextGLProxy` to batch state
changes specifically to avoid an IPC semaphore signal for commands that do no
immediate GPU work. The affected commands include the Flyff sample's repeated
`BindBuffer`, `BindTexture`, `Uniform*`, `UniformMatrix*`, and
`VertexAttribPointer` calls. Draw and presentation commands remain submission
boundaries, and Cocoa `prepareForDisplay()` remains synchronous; the correct
acceptance condition is therefore that it no longer dominates the stack, not
that the symbol disappears.

Safari Technology Preview 249 loads WebKit `21626.1.1` and contains the batching
change. A native-resolution loopback stress probe confirmed that Rion can load
that framework only under an explicit development environment. Its generic
state-churn run reduced the worst observed callback interval from approximately
26 ms to 13 ms, but did not produce a median-FPS separation on the light fixture.
This is evidence for a tail-latency hypothesis, not proof that Flyff passes.

The repository now contains a debug-only launcher for the six system/STP and
WebGL/DOM-rendering cells. It uses an isolated Rion user-data directory and a
read-only overlay that samples Flyff's public Emscripten `MainLoop` counters
without attaching Inspector, replacing timers, creating another graphics
context, or modifying WebGL calls. The first real-page pass completed with STP
249 (`21626.1.1`): GPU batching failed the FPS gate, direct failed to load the
game, and the DOM-rendering override failed the FPS gate. Five interleaved
samples and a 10-minute soak are deferred because no candidate qualified for
the winning-candidate stage; they remain mandatory before any future system
WebKit build can enter the production strategy catalog.

Run the six cells in the fixed order with one isolated login store by closing
Rion Studio after exporting each cell's diagnostic result:

```bash
pnpm run performance:webkit:experiment --mode=matrix --sample-ms=10000 --stp-app="/Applications/Safari Technology Preview.app"
```

To repeat one cell independently, use:

```bash
pnpm run performance:webkit:experiment --mode=system-direct --sample-ms=10000
pnpm run performance:webkit:experiment --mode=stp-gpu-process --sample-ms=10000 --stp-app="/Applications/Safari Technology Preview.app"
```

The other exact mode names are `system-gpu-process`, `stp-direct`,
`stp-gpu-process-dom-rendering`, and `stp-gpu-process-all-rendering`. The matrix
preserves the same isolated role store across restarts, so the test account is
entered there once and never copied from production. A 10-minute soak uses
`--sample-ms=600000`.

If that matrix fails, the upstream-ready report should attach the exact system
and STP WebKit versions, the `flyff-like` fixture profile, WebContent/GPU stack
samples, native canvas/DPR/attribute evidence, timer and presentation tails, and
context-loss results. It should cite the remaining synchronous
`prepareForDisplay()` path and revision 314547 without claiming that command
batching alone is sufficient. Public submission still requires owner approval.

## Windows status

WebView2 remains engine-managed and uses its supported Chromium GPU-process
path. Shared contract and process-enumeration tests pass locally, but the native
Windows build and the Rion/Edge/Brave performance gate still require Windows CI
and a physical Windows host. A macOS cross-check cannot establish that result.
