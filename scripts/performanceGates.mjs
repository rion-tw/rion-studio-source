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
  const latencyGates = [
    gates.ipcCommandP95RegressionPercent,
    gates.macroScheduleToDispatchP95RegressionPercent,
    gates.tabActivationP95RegressionPercent
  ];
  return {
    gates,
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
