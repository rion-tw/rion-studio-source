# macOS WKWebView Game Mode A/B

Use this runbook to measure whether the production-default macOS Game Mode
metadata materially improves a fixed Flyff Universe Effects-on workload. It does
not authorize new WebKit preferences.

## Preconditions

- Use the same Apple Silicon Mac, display, native resolution, refresh rate, power
  adapter, Flyff account, map, character, camera, and game settings for every cell.
- Disable Low Power Mode and record macOS, WebKit, display, power-mode, and thermal
  diagnostics. If High Power Mode is available, keep it unchanged within an A/B.
- Match Rion and Brave viewport, canvas backing dimensions, DPR, and WebGL context
  attributes. Do not lower visual quality or modify page scripts.
- Use native Rion window fullscreen. A Game Mode `on` sample is invalid unless
  macOS visibly reports that Game Mode is active.

## Launch cells

Use the production-default System WebKit path and the same isolated login store:

```bash
pnpm run performance:webkit:experiment --mode=system-default --game-mode=off
pnpm run performance:webkit:experiment --mode=system-default --game-mode=on
```

The first command produces an isolated control bundle without Game Mode metadata.
The second matches production by adding `LSSupportsGameMode=true` and
`LSApplicationCategoryType=public.app-category.games` to the generated debug
bundle under `target/rion-dev`.

The launcher configures the isolated v22 comparison bundle; it does not collect
performance samples. Rion's built-in FPS/power/thermal diagnostics and the
`--sample-ms` option have been removed. Obtain measurements from the game's
own HUD or separately operated system profiling tools, record each source, and
mark unavailable metrics explicitly. An unavailable required metric leaves the
corresponding acceptance gate unproven. These measurements do not reopen the
removed product feature or authorize a v23 WebKit runtime.

## Procedure

1. Test Flyff Effects off and Effects on separately. Warm the fixed scene for 30
   seconds before collecting a sample.
2. Alternate Game Mode off/on and Brave reference runs to reduce temperature and
   ordering bias. Collect at least five 10-second samples per cell.
3. Record game-loop mean, median and p10 FPS; presentation rAF and missed frames;
   UI, WebContent, and GPU process CPU; GPU utilization/power; memory; context
   losses; and independently captured visual parity.
4. Run the winning candidate for 10 minutes and repeat any cell invalidated by a
   power-mode, thermal, viewport, scene, or Game Mode activation change.

## Acceptance

Game Mode establishes a measured performance benefit only when Effects-on FPS
improves by at least 15% over the off control, median FPS is at least 110, p10 is
at least 100, and Rion is no more than 10% behind the matched Brave reference. It
must also preserve visual output, input, focus, fullscreen behavior, native
surface health, and WebGL context stability.

If it fails any gate, report that the default metadata has no proven performance
benefit and keep WebKit preferences unchanged. Retain the exact build identifiers,
same-workload results, and process profiles as evidence for a focused upstream
WebKit performance report.
