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
  p95TreeCpuPercent?: number;
  p95TreeRssBytes?: number;
  peakTreeCpuPercent?: number;
  peakTreeRssBytes?: number;
  peakProcessCount?: number;
  processCategories?: Partial<Record<
    "app" | "renderer" | "gpu" | "browserUtility",
    {
      medianCpuPercent: number;
      p95CpuPercent: number;
      peakCpuPercent: number;
      medianRssBytes: number;
      p95RssBytes: number;
      peakRssBytes: number;
      medianProcessCount: number;
      peakProcessCount: number;
    }
  >>;
  processChurn?: {
    exitedProcessCount: number;
    startedProcessCount: number;
    uniqueProcessCount: number;
  };
  runtimeTelemetry?: Partial<Record<
    "ipcCommand" | "macroScheduleToDispatch" | "mainEventLoopDelay" | "rendererRaf" |
      "tabActivation" | "workspaceLaunch",
    LatencySummary
  >> & {
    layoutPassCount?: number;
    menuRefreshCount?: number;
    runtimePublishCount?: number;
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
    mainEventLoopP95Ms?: number;
    rssGrowthPercent: number;
    rendererRafP95RegressionPercent?: number;
    tabActivationP95RegressionPercent?: number;
    workspaceLaunchP95RegressionPercent?: number;
  };
  missingTelemetryMetrics: string[];
  diagnostics: {
    effectQueuePeak?: number;
    effectQueueCapacity?: number;
    effectAckP95Ms?: number;
    launchEffectCount?: number;
    launchOperationCount?: number;
    effectsPerLaunch: number;
    layoutPassCount?: number;
    menuRefreshCount?: number;
    runtimePublishCount?: number;
  };
  passed: boolean;
}

export interface PerformanceNonRegressionComparison {
  gates: {
    nonRendererCpuRegressionPercent?: number;
    nonRendererRssRegressionPercent?: number;
    treeCpuRegressionPercent?: number;
    treeRssRegressionPercent?: number;
    p95TreeCpuRegressionPercent?: number;
    p95TreeRssRegressionPercent?: number;
    ipcCommandP95RegressionPercent?: number;
    macroScheduleToDispatchP95RegressionPercent?: number;
    mainEventLoopP95Ms?: number;
    mainEventLoopP95RegressionPercent?: number;
    rendererRafP95RegressionPercent?: number;
    rssGrowthPercent: number;
    tabActivationP95RegressionPercent?: number;
    workspaceLaunchP95RegressionPercent?: number;
  };
  maximumRegressionPercent: number;
  missingTelemetryMetrics: string[];
  passed: boolean;
}

export function comparePerformanceSummaries(
  current: PerformanceSummary,
  baseline: PerformanceSummary
): PerformanceComparison;

export function comparePerformanceNonRegression(
  current: PerformanceSummary,
  baseline: PerformanceSummary,
  maximumRegressionPercent?: number
): PerformanceNonRegressionComparison;

export function aggregatePerformanceSummaries(
  summaries: [PerformanceSummary, PerformanceSummary, PerformanceSummary]
): PerformanceSummary;
