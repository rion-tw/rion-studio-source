export function comparePerformanceSummaries(current, baseline) {
  const improvement = (before, after) => before === 0 ? 0 : ((before - after) / before) * 100;
  const latencyMetrics = ["ipcCommand", "macroScheduleToDispatch", "tabActivation"];
  const missingTelemetryMetrics = latencyMetrics.filter((metric) =>
    !hasSamples(baseline.runtimeTelemetry?.[metric]) ||
    !hasSamples(current.runtimeTelemetry?.[metric])
  );
  const latencyRegression = (metric) => {
    const before = baseline.runtimeTelemetry?.[metric]?.p95Ms;
    const after = current.runtimeTelemetry?.[metric]?.p95Ms;
    if (!Number.isFinite(before) || !Number.isFinite(after)) return undefined;
    if (before === 0) return after === 0 ? 0 : Number.MAX_VALUE;
    return ((after - before) / before) * 100;
  };
  const gates = {
    nonRendererCpuImprovementPercent: improvement(
      baseline.medianNonRendererCpuPercent,
      current.medianNonRendererCpuPercent
    ),
    nonRendererRssImprovementPercent: improvement(
      baseline.medianNonRendererRssBytes,
      current.medianNonRendererRssBytes
    ),
    treeCpuImprovementPercent: improvement(
      baseline.medianTreeCpuPercent,
      current.medianTreeCpuPercent
    ),
    treeRssImprovementPercent: improvement(
      baseline.medianTreeRssBytes,
      current.medianTreeRssBytes
    ),
    ipcCommandP95RegressionPercent: latencyRegression("ipcCommand"),
    macroScheduleToDispatchP95RegressionPercent: latencyRegression("macroScheduleToDispatch"),
    rssGrowthPercent: current.nonRendererRssGrowthPercent,
    tabActivationP95RegressionPercent: latencyRegression("tabActivation")
  };
  const coreEffects = current.runtimeTelemetry?.coreEffects;
  const napi = current.runtimeTelemetry?.napi;
  const diagnostics = {
    effectQueuePeak: coreEffects?.peakPendingEffectCount,
    effectQueueCapacity: coreEffects?.pendingEffectCapacity,
    effectAckP95Ms: coreEffects?.effectAckLatency?.p95Ms,
    launchEffectCount: coreEffects?.launchEffectCount,
    launchOperationCount: coreEffects?.launchOperationCount,
    effectsPerLaunch:
      coreEffects?.launchOperationCount > 0
        ? coreEffects.launchEffectCount / coreEffects.launchOperationCount
        : 0,
    napiCallCount: napi?.callCount,
    napiP95Ms: napi?.p95Ms
  };
  const latencyGates = [
    gates.ipcCommandP95RegressionPercent,
    gates.macroScheduleToDispatchP95RegressionPercent,
    gates.tabActivationP95RegressionPercent
  ];
  return {
    gates,
    diagnostics,
    missingTelemetryMetrics,
    passed:
      gates.nonRendererCpuImprovementPercent >= 30 &&
      gates.nonRendererRssImprovementPercent >= 20 &&
      gates.treeCpuImprovementPercent >= 10 &&
      gates.treeRssImprovementPercent >= 5 &&
      missingTelemetryMetrics.length === 0 &&
      latencyGates.every((regression) => Number.isFinite(regression) && regression <= 5) &&
      gates.rssGrowthPercent <= 5
  };
}

export function aggregatePerformanceSummaries(summaries) {
  if (!Array.isArray(summaries) || summaries.length !== 3) {
    throw new Error("Performance aggregation requires exactly three runs.");
  }
  const value = (key) => median(summaries.map((summary) => summary[key]));
  const runtimeTelemetry = Object.fromEntries(
    ["ipcCommand", "macroScheduleToDispatch", "tabActivation"].map((metric) => {
      const samples = summaries.map((summary) => summary.runtimeTelemetry?.[metric]);
      if (samples.some((sample) => !hasSamples(sample))) {
        return [metric, { maxMs: 0, p50Ms: 0, p95Ms: 0, sampleCount: 0 }];
      }
      return [metric, {
        maxMs: median(samples.map((sample) => sample.maxMs)),
        p50Ms: median(samples.map((sample) => sample.p50Ms)),
        p95Ms: median(samples.map((sample) => sample.p95Ms)),
        sampleCount: samples.reduce((count, sample) => count + sample.sampleCount, 0)
      }];
    })
  );
  const coreEffectSamples = summaries.map((summary) => summary.runtimeTelemetry?.coreEffects);
  if (coreEffectSamples.every(hasCoreEffectMetrics)) {
    const value = (key) => median(coreEffectSamples.map((sample) => sample[key]));
    const launchOperationCount = value("launchOperationCount");
    const launchEffectCount = value("launchEffectCount");
    runtimeTelemetry.coreEffects = {
      acknowledgedEffectCount: value("acknowledgedEffectCount"),
      activeOperationCount: value("activeOperationCount"),
      effectAckLatency: aggregateLatency(
        coreEffectSamples.map((sample) => sample.effectAckLatency)
      ),
      emittedEffectCount: value("emittedEffectCount"),
      launchEffectCount,
      launchOperationCount,
      operationCapacity: value("operationCapacity"),
      peakPendingEffectCount: value("peakPendingEffectCount"),
      pendingEffectCapacity: value("pendingEffectCapacity"),
      pendingEffectCount: value("pendingEffectCount")
    };
  }
  const napiSamples = summaries.map((summary) => summary.runtimeTelemetry?.napi);
  if (napiSamples.every(hasCountedLatency)) {
    runtimeTelemetry.napi = {
      ...aggregateLatency(napiSamples),
      callCount: median(napiSamples.map((sample) => sample.callCount))
    };
  }
  return {
    medianNonRendererCpuPercent: value("medianNonRendererCpuPercent"),
    medianNonRendererRssBytes: value("medianNonRendererRssBytes"),
    medianRootCpuPercent: value("medianRootCpuPercent"),
    medianRootRssBytes: value("medianRootRssBytes"),
    medianTreeCpuPercent: value("medianTreeCpuPercent"),
    medianTreeRssBytes: value("medianTreeRssBytes"),
    nonRendererRssGrowthPercent: value("nonRendererRssGrowthPercent"),
    runtimeTelemetry,
    sampleCount: summaries.reduce((count, summary) => count + (summary.sampleCount ?? 0), 0)
  };
}

function aggregateLatency(samples) {
  return {
    maxMs: median(samples.map((sample) => sample.maxMs)),
    p50Ms: median(samples.map((sample) => sample.p50Ms)),
    p95Ms: median(samples.map((sample) => sample.p95Ms)),
    sampleCount: samples.reduce((count, sample) => count + sample.sampleCount, 0)
  };
}

function hasCoreEffectMetrics(metrics) {
  return metrics && [
    "acknowledgedEffectCount",
    "activeOperationCount",
    "emittedEffectCount",
    "launchEffectCount",
    "launchOperationCount",
    "operationCapacity",
    "peakPendingEffectCount",
    "pendingEffectCapacity",
    "pendingEffectCount"
  ].every((key) => Number.isFinite(metrics[key])) &&
    hasLatencyShape(metrics.effectAckLatency);
}

function hasCountedLatency(metric) {
  return Number.isFinite(metric?.callCount) && hasLatencyShape(metric);
}

function hasLatencyShape(metric) {
  return metric && Number.isFinite(metric.maxMs) && Number.isFinite(metric.p50Ms) &&
    Number.isFinite(metric.p95Ms) && Number.isSafeInteger(metric.sampleCount);
}

function hasSamples(metric) {
  return Number.isSafeInteger(metric?.sampleCount) && metric.sampleCount > 0 &&
    Number.isFinite(metric.p95Ms);
}

function median(values) {
  if (values.some((value) => !Number.isFinite(value))) {
    throw new Error("Performance summaries contain a missing or invalid numeric metric.");
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}
