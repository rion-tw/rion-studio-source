export interface LatencySummary {
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
  sampleCount: number;
}

export interface PerformanceSummary {
  medianNonRendererCpuPercent: number;
  medianNonRendererRssBytes: number;
  medianTreeCpuPercent: number;
  medianTreeRssBytes: number;
  nonRendererRssGrowthPercent: number;
  medianRootCpuPercent?: number;
  medianRootRssBytes?: number;
  sampleCount?: number;
  runtimeTelemetry?: Partial<Record<
    "ipcCommand" | "macroScheduleToDispatch" | "tabActivation",
    LatencySummary
  >> & {
    coreEffects?: {
      acknowledgedEffectCount: number;
      activeOperationCount: number;
      effectAckLatency: LatencySummary;
      emittedEffectCount: number;
      launchEffectCount: number;
      launchOperationCount: number;
      operationCapacity: number;
      peakPendingEffectCount: number;
      pendingEffectCapacity: number;
      pendingEffectCount: number;
    };
    napi?: LatencySummary & { callCount: number };
  };
}

export interface PerformanceComparison {
  gates: {
    nonRendererCpuImprovementPercent: number;
    nonRendererRssImprovementPercent: number;
    treeCpuImprovementPercent: number;
    treeRssImprovementPercent: number;
    ipcCommandP95RegressionPercent?: number;
    macroScheduleToDispatchP95RegressionPercent?: number;
    rssGrowthPercent: number;
    tabActivationP95RegressionPercent?: number;
  };
  missingTelemetryMetrics: string[];
  diagnostics: {
    effectQueuePeak?: number;
    effectQueueCapacity?: number;
    effectAckP95Ms?: number;
    launchEffectCount?: number;
    launchOperationCount?: number;
    effectsPerLaunch: number;
    napiCallCount?: number;
    napiP95Ms?: number;
  };
  passed: boolean;
}

export function comparePerformanceSummaries(
  current: PerformanceSummary,
  baseline: PerformanceSummary
): PerformanceComparison;

export function aggregatePerformanceSummaries(
  summaries: [PerformanceSummary, PerformanceSummary, PerformanceSummary]
): PerformanceSummary;
