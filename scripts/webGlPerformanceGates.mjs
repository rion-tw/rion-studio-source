const REQUIRED_SAMPLE_COUNT = 5;
const REQUIRED_SAMPLE_MS = 10_000;
const REQUIRED_SOAK_MS = 600_000;
const REQUIRED_WARMUP_MS = 30_000;

export function summarizeWebGlRun(run) {
  validateRun(run);
  return {
    contextLosses: run.soak.contextLosses,
    medianGameLoopFps: median(run.samples.map((sample) => sample.gameLoop.fps)),
    medianGameLoopP10Fps: median(run.samples.map((sample) => sample.gameLoop.p10Fps)),
    medianPresentationFps: median(run.samples.map((sample) => sample.presentation.fps)),
    medianPresentationMissedFrameRatio: median(
      run.samples.map((sample) => sample.presentation.missedFrameRatio)
    ),
    nativeSurface: nativeSurface(run.samples[0]),
    renderer: run.samples[0].context.renderer,
    sampleCount: run.samples.length,
    soakMs: run.soak.durationMs,
    warmupMs: run.warmupMs,
    workloadProfile: run.samples[0].workloadProfile
  };
}

export function compareMacWebGlAcceptance({
  brave,
  compatibility,
  extreme,
  visualOutputMatched
}) {
  const runs = {
    brave: summarizeWebGlRun(brave),
    compatibility: summarizeWebGlRun(compatibility),
    extreme: summarizeWebGlRun(extreme)
  };
  const improvementPercent = percentageIncrease(
    runs.compatibility.medianGameLoopFps,
    runs.extreme.medianGameLoopFps
  );
  const braveGapPercent = trailingGapPercent(
    runs.extreme.medianGameLoopFps,
    runs.brave.medianGameLoopFps
  );
  const nativeSurfaceMatched = sameNativeSurface(
    runs.extreme.nativeSurface,
    runs.compatibility.nativeSurface
  ) && sameNativeSurface(runs.extreme.nativeSurface, runs.brave.nativeSurface);
  const presentationGapPercent = trailingGapPercent(
    runs.extreme.medianPresentationFps,
    runs.brave.medianPresentationFps
  );
  const gates = {
    braveGapPercent,
    contextLosses: runs.extreme.contextLosses,
    improvementPercent,
    medianGameLoopFps: runs.extreme.medianGameLoopFps,
    medianGameLoopP10Fps: runs.extreme.medianGameLoopP10Fps,
    nativeSurfaceMatched,
    presentationGapPercent,
    presentationMissedFrameRatio: runs.extreme.medianPresentationMissedFrameRatio,
    visualOutputMatched: visualOutputMatched === true
  };
  return {
    gates,
    passed:
      gates.improvementPercent >= 15
      && gates.medianGameLoopFps >= 110
      && gates.medianGameLoopP10Fps >= 100
      && gates.braveGapPercent <= 10
      && gates.presentationGapPercent <= 5
      && gates.presentationMissedFrameRatio <= 0.01
      && gates.contextLosses === 0
      && gates.nativeSurfaceMatched
      && gates.visualOutputMatched,
    runs
  };
}

export function compareWindowsWebGlAcceptance({
  brave,
  edge,
  hardwareAccelerationEnabled,
  productionGraphicsFlags = [],
  rion,
  webGlExecutionPath,
  gpuProcessPresent,
  visualOutputMatched
}) {
  const runs = {
    brave: summarizeWebGlRun(brave),
    edge: summarizeWebGlRun(edge),
    rion: summarizeWebGlRun(rion)
  };
  const referenceFps = Math.max(
    runs.brave.medianGameLoopFps,
    runs.edge.medianGameLoopFps
  );
  const nativeSurfaceMatched = sameNativeSurface(
    runs.rion.nativeSurface,
    runs.brave.nativeSurface
  ) && sameNativeSurface(runs.rion.nativeSurface, runs.edge.nativeSurface);
  const gates = {
    contextLosses: runs.rion.contextLosses,
    gpuProcessPresent: gpuProcessPresent === true,
    hardwareAccelerationEnabled: hardwareAccelerationEnabled === true,
    medianGameLoopFps: runs.rion.medianGameLoopFps,
    medianGameLoopP10Fps: runs.rion.medianGameLoopP10Fps,
    nativeSurfaceMatched,
    productionGraphicsFlagsAbsent: productionGraphicsFlags.length === 0,
    referenceGapPercent: trailingGapPercent(runs.rion.medianGameLoopFps, referenceFps),
    visualOutputMatched: visualOutputMatched === true,
    webGlExecutionPath
  };
  return {
    gates,
    passed:
      gates.medianGameLoopFps >= 110
      && gates.medianGameLoopP10Fps >= 100
      && gates.referenceGapPercent <= 10
      && gates.contextLosses === 0
      && gates.gpuProcessPresent
      && gates.hardwareAccelerationEnabled
      && gates.webGlExecutionPath === "engineManaged"
      && gates.productionGraphicsFlagsAbsent
      && gates.nativeSurfaceMatched
      && gates.visualOutputMatched,
    runs
  };
}

function validateRun(run) {
  if (run?.fixture !== "rion-webgl1-120") {
    throw new Error("WebGL acceptance requires the Rion WebGL1 120 Hz fixture.");
  }
  if (!Array.isArray(run.samples) || run.samples.length < REQUIRED_SAMPLE_COUNT) {
    throw new Error(`WebGL acceptance requires at least ${REQUIRED_SAMPLE_COUNT} samples.`);
  }
  if (run.warmupMs < REQUIRED_WARMUP_MS || run.sampleMs < REQUIRED_SAMPLE_MS) {
    throw new Error("WebGL acceptance requires a 30 second warmup and 10 second samples.");
  }
  if (run.soak?.durationMs < REQUIRED_SOAK_MS) {
    throw new Error("WebGL acceptance requires a 10 minute soak.");
  }
  for (const sample of run.samples) {
    if (
      !Number.isFinite(sample?.gameLoop?.fps)
      || !Number.isFinite(sample?.gameLoop?.p10Fps)
      || !Number.isFinite(sample?.presentation?.fps)
      || !Number.isFinite(sample?.presentation?.missedFrameRatio)
    ) {
      throw new Error("WebGL acceptance sample is missing an FPS metric.");
    }
    if (sample.context?.attributes?.antialias !== false) {
      throw new Error("WebGL acceptance requires antialias:false.");
    }
    if (sample.workloadProfile !== "flyff-like") {
      throw new Error("WebGL acceptance requires the Flyff-like state workload.");
    }
  }
}

function nativeSurface(sample) {
  return {
    antialias: sample.context.attributes.antialias,
    cssHeight: sample.canvas.cssHeight,
    cssWidth: sample.canvas.cssWidth,
    devicePixelRatio: sample.canvas.devicePixelRatio,
    pixelHeight: sample.canvas.pixelHeight,
    pixelWidth: sample.canvas.pixelWidth
  };
}

function sameNativeSurface(left, right) {
  return Object.keys(left).every((key) => left[key] === right[key]);
}

function percentageIncrease(before, after) {
  if (!Number.isFinite(before) || !Number.isFinite(after) || before <= 0) return 0;
  return ((after - before) / before) * 100;
}

function trailingGapPercent(candidate, reference) {
  if (!Number.isFinite(candidate) || !Number.isFinite(reference) || reference <= 0) return Infinity;
  return Math.max(0, ((reference - candidate) / reference) * 100);
}

function median(values) {
  if (values.some((value) => !Number.isFinite(value))) {
    throw new Error("WebGL run contains an invalid numeric metric.");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}
