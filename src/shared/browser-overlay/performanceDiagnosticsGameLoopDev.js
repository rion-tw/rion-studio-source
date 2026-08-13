/* global __RION_PERFORMANCE_OPERATION_ID_JSON__ */
(() => {
  const operationId = __RION_PERFORMANCE_OPERATION_ID_JSON__;
  const registry = globalThis.__rionStudioPerformanceDiagnostics;
  const probe = registry?.[operationId];
  if (!probe) return JSON.stringify({ error: "Performance sample was not started." });
  probe.gameLoopEnabled = true;
  probe.gameLoopSamples = [];
  probe.gameLoopTimerDrifts = [];
  probe.contextLossCount = 0;
  const mainLoop = globalThis.MainLoop;
  const initialCounter = Number(mainLoop?.currentFrameNumber);
  const initialAt = performance.now();
  probe.gameLoopStartedAt = initialAt;
  probe.gameLoopLastAt = initialAt;
  probe.gameLoopStartedCounter = Number.isFinite(initialCounter) ? initialCounter : undefined;
  probe.gameLoopLastCounter = Number.isFinite(initialCounter) ? initialCounter : undefined;
  probe.gameLoopTimingMode = Number.isFinite(Number(mainLoop?.timingMode))
    ? Number(mainLoop.timingMode)
    : undefined;
  probe.gameLoopTimingValue = Number.isFinite(Number(mainLoop?.timingValue))
    ? Number(mainLoop.timingValue)
    : undefined;
  const primaryCanvas = [...document.querySelectorAll("canvas")]
    .map((canvas) => ({ canvas, rect: canvas.getBoundingClientRect() }))
    .filter(({ rect }) => rect.width > 0 && rect.height > 0)
    .sort((left, right) => right.rect.width * right.rect.height - left.rect.width * left.rect.height)
    .at(0)?.canvas;
  if (primaryCanvas) {
    probe.contextLossCanvas = primaryCanvas;
    probe.contextLossListener = () => { probe.contextLossCount += 1; };
    primaryCanvas.addEventListener("webglcontextlost", probe.contextLossListener);
  }
  const overlayHost = document.createElement("div");
  overlayHost.dataset.rionPerformanceOverlay = operationId;
  overlayHost.style.cssText = [
    "position:fixed", "left:12px", "bottom:12px", "z-index:2147483647",
    "pointer-events:none", "font:12px/1.45 ui-monospace,monospace",
    "color:#e8f4ff", "background:rgba(4,10,20,.86)",
    "border:1px solid rgba(130,190,255,.5)", "border-radius:6px",
    "padding:7px 9px", "white-space:pre"
  ].join(";");
  const shadow = overlayHost.attachShadow({ mode: "closed" });
  const output = document.createElement("span");
  output.textContent = "Rion WebGL probe: waiting for Emscripten MainLoop";
  shadow.append(output);
  document.documentElement.append(overlayHost);
  probe.overlayHost = overlayHost;
  let previousAt = initialAt;
  let previousCounter = initialCounter;
  let nextAt = initialAt + 100;
  const sampleGameLoop = (now) => {
    if (!probe.running) return;
    if (now < nextAt) return;
    const currentMainLoop = globalThis.MainLoop;
    const counter = Number(currentMainLoop?.currentFrameNumber);
    const timingMode = Number(currentMainLoop?.timingMode);
    const timingValue = Number(currentMainLoop?.timingValue);
    probe.gameLoopTimingMode = Number.isFinite(timingMode) ? timingMode : undefined;
    probe.gameLoopTimingValue = Number.isFinite(timingValue) ? timingValue : undefined;
    const scheduledAt = nextAt;
    const elapsedSamplePeriods = Math.max(1, Math.floor((now - nextAt) / 100) + 1);
    nextAt += elapsedSamplePeriods * 100;
    if (
      timingMode === 0
      && Number.isFinite(counter)
      && !Number.isFinite(probe.gameLoopStartedCounter)
    ) {
      probe.gameLoopStartedCounter = counter;
      probe.gameLoopLastCounter = counter;
      probe.gameLoopStartedAt = now;
      probe.gameLoopLastAt = now;
      previousAt = now;
      previousCounter = counter;
    }
    if (
      timingMode === 0
      && Number.isFinite(counter)
      && Number.isFinite(previousCounter)
      && now > previousAt
    ) {
      const fps = (counter - previousCounter) * 1000 / (now - previousAt);
      if (Number.isFinite(fps) && fps >= 0 && probe.gameLoopSamples.length < 2048) {
        probe.gameLoopSamples.push(fps);
      }
      probe.gameLoopLastCounter = counter;
      probe.gameLoopLastAt = now;
    }
    if (probe.gameLoopTimerDrifts.length < 2048) {
      probe.gameLoopTimerDrifts.push(now - scheduledAt);
    }
    output.textContent = timingMode === 0
      ? `Rion WebGL probe\nGame loop ${probe.gameLoopSamples.at(-1)?.toFixed(1) ?? "—"} FPS\nTimer ${timingValue ?? "—"} ms`
      : `Rion WebGL probe\nMainLoop mode ${Number.isFinite(timingMode) ? timingMode : "unknown"}\nRead-only; scheduler unchanged`;
    previousAt = now;
    previousCounter = counter;
  };
  probe.gameLoopSample = sampleGameLoop;
  return JSON.stringify({ gameLoopProbeStarted: true });
})()
