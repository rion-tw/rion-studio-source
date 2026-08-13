/* global __RION_PERFORMANCE_ACTION_JSON__, __RION_PERFORMANCE_OPERATION_ID_JSON__ */
(() => {
  const action = __RION_PERFORMANCE_ACTION_JSON__;
  const operationId = __RION_PERFORMANCE_OPERATION_ID_JSON__;
  const registryKey = "__rionStudioPerformanceDiagnostics";
  const registry = globalThis[registryKey] ??= Object.create(null);
  const stopProbe = (probe) => {
    if (!probe) return;
    probe.running = false;
    if (typeof probe.rafId === "number") cancelAnimationFrame(probe.rafId);
    probe.gameLoopSample = undefined;
    try {
      globalThis.removeEventListener("pagehide", probe.pageHideListener);
    } catch { /* Cleanup is best effort. */ }
    try { probe.longTaskObserver?.disconnect(); } catch { /* Cleanup is best effort. */ }
    try {
      probe.contextLossCanvas?.removeEventListener(
        "webglcontextlost",
        probe.contextLossListener
      );
    } catch { /* Cleanup is best effort. */ }
    try { probe.overlayHost?.remove(); } catch { /* Cleanup is best effort. */ }
  };
  if (action === "cancel") {
    stopProbe(registry[operationId]);
    delete registry[operationId];
    return JSON.stringify({ cancelled: true });
  }
  if (action === "start") {
    stopProbe(registry[operationId]);
    const probe = {
      contextLossCount: undefined,
      frameCount: 0,
      intervals: [],
      lastFrameAt: undefined,
      longTaskDurations: [],
      longTaskObserver: undefined,
      longTaskObserverSupported: false,
      pageHideListener: undefined,
      rafId: undefined,
      running: true,
      startedAt: performance.now()
    };
    registry[operationId] = probe;
    probe.pageHideListener = () => {
      stopProbe(probe);
      if (registry[operationId] === probe) delete registry[operationId];
    };
    globalThis.addEventListener("pagehide", probe.pageHideListener, { once: true });
    try {
      const supported = Array.isArray(globalThis.PerformanceObserver?.supportedEntryTypes)
        && globalThis.PerformanceObserver.supportedEntryTypes.includes("longtask");
      if (supported) {
        probe.longTaskObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (probe.longTaskDurations.length >= 2048) break;
            if (Number.isFinite(entry.duration) && entry.duration >= 0) {
              probe.longTaskDurations.push(entry.duration);
            }
          }
        });
        probe.longTaskObserver.observe({ type: "longtask", buffered: false });
        probe.longTaskObserverSupported = true;
      }
    } catch {
      try { probe.longTaskObserver?.disconnect(); } catch { /* Cleanup is best effort. */ }
      probe.longTaskObserver = undefined;
      probe.longTaskObserverSupported = false;
    }
    const tick = (now) => {
      if (!probe.running) return;
      if (typeof probe.lastFrameAt === "number" && probe.intervals.length < 2048) {
        probe.intervals.push(now - probe.lastFrameAt);
      }
      probe.lastFrameAt = now;
      probe.frameCount += 1;
      probe.gameLoopSample?.(now);
      probe.rafId = requestAnimationFrame(tick);
    };
    probe.rafId = requestAnimationFrame(tick);
    return JSON.stringify({ started: true });
  }
  const probe = registry[operationId];
  if (!probe) {
    return JSON.stringify({ error: "Performance sample was not started." });
  }
  stopProbe(probe);
  try {
    for (const entry of probe.longTaskObserver?.takeRecords?.() || []) {
      if (probe.longTaskDurations.length >= 2048) break;
      if (Number.isFinite(entry.duration) && entry.duration >= 0) {
        probe.longTaskDurations.push(entry.duration);
      }
    }
  } catch { /* Observer readback is optional. */ }
  const duration = Math.max(0, performance.now() - probe.startedAt);
  const intervals = [...probe.intervals].filter(Number.isFinite).sort((a, b) => a - b);
  const intervalDuration = intervals.reduce((total, interval) => total + interval, 0);
  const longTaskDurations = [...probe.longTaskDurations]
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const percentile = (values, fraction) => values.length
    ? values[Math.min(values.length - 1, Math.floor((values.length - 1) * fraction))]
    : undefined;
  const activeContext = globalThis.GLctx;
  const graphics = {
    webgl: activeContext ? "available" : "unknown",
    webgl2: activeContext && globalThis.WebGL2RenderingContext
      && activeContext instanceof globalThis.WebGL2RenderingContext
      ? "available"
      : activeContext ? "unavailable" : "unknown",
    webgpu: navigator.gpu ? "available" : "unavailable"
  };
  try {
    if (activeContext) {
      const extension = activeContext.getExtension?.("WEBGL_debug_renderer_info");
      if (extension) {
        graphics.renderer = String(
          activeContext.getParameter(extension.UNMASKED_RENDERER_WEBGL) || ""
        );
        graphics.vendor = String(
          activeContext.getParameter(extension.UNMASKED_VENDOR_WEBGL) || ""
        );
      }
    }
  } catch (error) {
    graphics.error = error instanceof Error ? error.message : String(error);
  }
  let webGlContextAttributes;
  try {
    webGlContextAttributes = activeContext?.getContextAttributes?.() ?? undefined;
  } catch { /* Existing context attributes are optional. */ }
  const visibility = ["visible", "hidden", "prerender"].includes(document.visibilityState)
    ? document.visibilityState
    : "unknown";
  const presentationFps = intervalDuration > 0 && intervals.length > 0
    ? intervals.length * 1000 / intervalDuration
    : undefined;
  const primaryCanvas = [...document.querySelectorAll("canvas")]
    .map((canvas) => ({ canvas, rect: canvas.getBoundingClientRect() }))
    .filter(({ rect }) => rect.width > 0 && rect.height > 0)
    .sort((left, right) => right.rect.width * right.rect.height - left.rect.width * left.rect.height)
    .map(({ canvas, rect }) => ({
      cssWidth: rect.width,
      cssHeight: rect.height,
      pixelWidth: canvas.width,
      pixelHeight: canvas.height,
      devicePixelRatio: Number.isFinite(globalThis.devicePixelRatio)
        ? globalThis.devicePixelRatio
        : 1,
      megapixels: canvas.width * canvas.height / 1000000
    }))[0];
  const gameLoopSamples = [...(probe.gameLoopSamples || [])]
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const gameLoopDuration = probe.gameLoopLastAt - probe.gameLoopStartedAt;
  const gameLoopFrames = probe.gameLoopLastCounter - probe.gameLoopStartedCounter;
  const gameLoopFps = probe.gameLoopTimingMode === 0
    && Number.isFinite(gameLoopDuration) && gameLoopDuration > 0
    && Number.isFinite(gameLoopFrames) && gameLoopFrames >= 0
    ? gameLoopFrames * 1000 / gameLoopDuration
    : undefined;
  const timerDrifts = [...(probe.gameLoopTimerDrifts || [])]
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  delete registry[operationId];
  return JSON.stringify({
    documentVisibilityState: visibility,
    documentHasFocus: document.hasFocus(),
    viewportWidth: Number.isFinite(innerWidth) ? innerWidth : 0,
    viewportHeight: Number.isFinite(innerHeight) ? innerHeight : 0,
    devicePixelRatio: Number.isFinite(globalThis.devicePixelRatio)
      ? globalThis.devicePixelRatio
      : 1,
    hardwareConcurrency: Number.isFinite(navigator.hardwareConcurrency)
      ? navigator.hardwareConcurrency
      : 0,
    frameCount: probe.frameCount,
    observedDurationMs: duration,
    presentationFps,
    frameIntervalsMs: intervals,
    p50FrameIntervalMs: percentile(intervals, 0.5),
    p95FrameIntervalMs: percentile(intervals, 0.95),
    p99FrameIntervalMs: percentile(intervals, 0.99),
    longestFrameIntervalMs: intervals.at(-1),
    ...(probe.longTaskObserverSupported ? {
      longTaskCount: longTaskDurations.length,
      longTaskTotalDurationMs: longTaskDurations.reduce((total, value) => total + value, 0),
      longestTaskMs: longTaskDurations.at(-1) || 0
    } : {}),
    graphics,
    primaryCanvas,
    webGlContextAttributes,
    ...(probe.gameLoopEnabled ? {
      gameLoopFps,
      gameLoopP10Fps: percentile(gameLoopSamples, 0.1),
      gameLoopTimingMode: probe.gameLoopTimingMode,
      gameLoopTimingValue: probe.gameLoopTimingValue,
      gameLoopTimerDriftP95Ms: percentile(timerDrifts, 0.95),
      contextLossCount: probe.contextLossCount
    } : {})
  });
})()
