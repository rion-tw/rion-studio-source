# macOS Flyff Brave/Rion Same-Scene A/B

Use this runbook to reproduce and quantify the reported Flyff Universe
Effects-on performance difference between Brave and Rion Studio on macOS. The
comparison is observational: it does not authorize an external-browser runtime,
page injection, lower visual quality, or new WebKit preferences.

## Test question

Does Brave sustain materially better frame rate, frame pacing, or memory
stability than production-default Rion System WebKit when both render the same
Flyff scene with the same visible settings?

Effects on is the primary workload. Effects off is a control and must not replace
the primary result.

## Large-gap triage

Exact scene parity is optional when the immediate goal is to localize a large,
obvious engine-path difference rather than calculate an acceptance ratio. In
this mode, record the visible workload difference, keep both runtimes focused
during their samples, and compare process CPU/RSS plus renderer and GPU stack
samples. A heavier visible scene in the apparently faster runtime is useful
directional evidence, but different scenes must not be converted into a claimed
FPS percentage or used to pass the acceptance gates below.

Use triage to decide which engine boundary to investigate. Return to the locked
same-scene sequence only before accepting an optimization or claiming a measured
Brave/Rion performance ratio.

## Preconditions

- Use the same Apple Silicon Mac, display, native resolution, refresh rate, power
  mode, Flyff account and character, server and channel, map, position, camera,
  zoom, crowd density, and game settings for every paired sample.
- Record the exact macOS, Brave, Rion, and System WebKit versions. In Brave,
  record hardware-acceleration, Energy Saver, Memory Saver, and Shields state;
  do not change them within a run.
- Match native fullscreen or windowed state, visible viewport, canvas backing
  dimensions, device-pixel ratio, FPS cap, VSync, and WebGL context attributes.
  Do not use browser zoom or a lower canvas resolution to create parity.
- Keep the Mac on AC power. Keep Low Power Mode, High Power Mode, display refresh
  rate, and Rion Game Mode state unchanged throughout a paired run. Record Game
  Mode rather than treating it as the tested variable; use the dedicated
  [Game Mode A/B](macos-wkwebview-game-mode.md) runbook for that question.
- Close or idle unrelated GPU-heavy applications. Do not attach DevTools or an
  inspector to the game during measured samples because it changes the workload.
- Use a non-sensitive alias for the account or character in notes. Never record
  credentials, cookies, tokens, or browser profile data.

## Scene lock

Before sampling either runtime, fill this record and capture one reference
screenshot:

| Field | Locked value |
| --- | --- |
| Date and local time | |
| Mac, macOS, power and thermal state | |
| Display resolution and refresh rate | |
| Rion and System WebKit versions | |
| Brave version and performance settings | |
| Account/character alias, server and channel | |
| Map, coordinates and facing direction | |
| Camera yaw, pitch and zoom | |
| Window/fullscreen and Game Mode state | |
| CSS viewport, canvas backing size and DPR | |
| Resolution, quality, Effects, FPS cap and VSync | |

The scene is invalid after a material player-density change, weather or lighting
change, character displacement, camera movement, focus or visibility change,
settings change, WebGL context loss, GPU-process restart, power-mode change, or
thermal warning. Restore the scene and restart the paired sample.

## Short paired run

1. Quit or fully idle the runtime that is not being measured. Launch Rion on its
   production-default System WebKit path; launch Brave with its normal profile
   and recorded performance settings.
2. Load the locked scene with Effects on. After assets settle, keep the character
   stationary and warm the focused runtime for 30 seconds.
3. Capture a start screenshot and one 10-second sample. Record the Flyff HUD or
   game-loop mean, median, and p10 FPS when available; presentation rAF and
   missed frames; renderer/UI and GPU CPU; GPU utilization; renderer and GPU
   resident memory; and any visible hitch, context loss, or input failure.
4. Alternate five samples per runtime in this order to reduce ordering bias:
   `Rion A1, Brave B1, Brave B2, Rion A2, Rion A3, Brave B3, Brave B4, Rion A4,
   Rion A5, Brave B5`. Re-establish the scene lock and warm for 30 seconds after
   every switch.
5. Capture an end screenshot for each runtime. Compare character pose, particles,
   shadows, lighting, nameplates, crowd, viewport, and canvas size before using
   the numbers.
6. Repeat the sequence with Effects off as a control only after the Effects-on
   sequence is complete.

Use Activity Monitor or read-only process sampling for corroboration. For Rion,
separate the UI, game WebContent, networking, and GPU processes. For Brave,
separate the game renderer and GPU process; use the highest sustained game-tab
renderer only after confirming it belongs to the focused Flyff tab. Do not sum
unrelated Brave extensions or tabs into the game renderer result.

## Ten-minute stability run

If the short paired run reproduces a gap, run each runtime for ten minutes in the
locked Effects-on scene. Record one-minute windows after the initial warmup. The
last minute must not lose more than 5% median or p10 FPS relative to the first
measured minute, combined game-renderer plus GPU resident memory must not grow by
more than 5%, and no WebGL context loss, GPU-process restart, visual corruption,
or input/focus failure is allowed.

## Result table

| Runtime/cell | Effects | Median FPS | p10 FPS | Presentation FPS | Missed frames | Renderer CPU/RSS | GPU CPU/RSS | Valid? |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- | --- |
| Rion A1-A5 | On | | | | | | | |
| Brave B1-B5 | On | | | | | | | |
| Rion A1-A5 | Off | | | | | | | |
| Brave B1-B5 | Off | | | | | | | |

Report the Brave lead as `(Brave - Rion) / Rion * 100`. A Brave advantage is
reproduced only when visual parity holds across all five Effects-on samples and
Brave exceeds Rion by at least 15% in median FPS and 10% in p10 FPS. Otherwise
the result is inconclusive or not reproduced. A short run may establish the
performance gap, but an optimization claim additionally requires the ten-minute
stability run and an identified, independently varied cause.

When reporting, include invalidated samples and their reasons, screenshots,
exact versions, process evidence, the Effects-off control, and any remaining
measurement limitation. Do not infer a WebKit fix solely from Brave being faster.


## Measurement sources after diagnostics removal

Rion no longer provides the built-in presentation FPS, process/GPU or thermal
sample collector. Use game-owned HUD output and separately operated system
profilers, recording the source beside each metric. Do not interpret a missing
rAF, missed-frame or process measurement as zero. Leave any acceptance criterion
that depends on unavailable evidence unproven; this runbook does not require
restoring the removed diagnostics UI or bridge.
