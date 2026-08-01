import { describe, expect, it } from "vitest";

import {
  aggregatePerformanceSummaries,
  comparePerformanceNonRegression,
  comparePerformanceSummaries
} from "../scripts/performanceGates.mjs";

describe("performance benchmark release gates", () => {
  it("fails comparison when any required p95 telemetry stream has no samples", () => {
    const latency = { maxMs: 1, p50Ms: 1, p95Ms: 1, sampleCount: 1 };
    const missingLatency = { ...latency, sampleCount: 0 };
    const baseline = {
      medianNonRendererCpuPercent: 100,
      medianNonRendererRssBytes: 1_000,
      medianTreeCpuPercent: 100,
      medianTreeRssBytes: 1_000,
      nonRendererRssGrowthPercent: 0,
      runtimeTelemetry: {
        ipcCommand: missingLatency,
        macroScheduleToDispatch: latency,
        tabActivation: latency
      }
    };
    const current = {
      medianNonRendererCpuPercent: 50,
      medianNonRendererRssBytes: 500,
      medianTreeCpuPercent: 50,
      medianTreeRssBytes: 500,
      nonRendererRssGrowthPercent: 0,
      runtimeTelemetry: {
        ipcCommand: latency,
        macroScheduleToDispatch: latency,
        tabActivation: latency
      }
    };

    const comparison = comparePerformanceSummaries(current, baseline);
    expect(comparison.passed).toBe(false);
    expect(comparison.missingTelemetryMetrics).toEqual(["ipcCommand"]);
  });

  it("uses the median of exactly three complete runs", () => {
    const latency = (p95Ms: number) => ({ maxMs: p95Ms, p50Ms: p95Ms, p95Ms, sampleCount: 2 });
    const run = (cpu: number, p95Ms: number) => ({
      medianNonRendererCpuPercent: cpu,
      medianNonRendererRssBytes: cpu * 10,
      medianRootCpuPercent: cpu,
      medianRootRssBytes: cpu * 10,
      medianTreeCpuPercent: cpu,
      medianTreeRssBytes: cpu * 10,
      nonRendererRssGrowthPercent: cpu / 10,
      p95TreeCpuPercent: cpu + 1,
      p95TreeRssBytes: cpu * 10 + 1,
      peakTreeCpuPercent: cpu + 2,
      peakTreeRssBytes: cpu * 10 + 2,
      peakProcessCount: cpu,
      processCategories: Object.fromEntries(
        ["app", "renderer", "gpu", "browserUtility"].map((category) => [category, {
          medianCpuPercent: cpu,
          p95CpuPercent: cpu + 1,
          peakCpuPercent: cpu + 2,
          medianRssBytes: cpu * 10,
          p95RssBytes: cpu * 10 + 1,
          peakRssBytes: cpu * 10 + 2,
          medianProcessCount: 1,
          peakProcessCount: 2
        }])
      ),
      processChurn: {
        exitedProcessCount: cpu,
        startedProcessCount: cpu + 1,
        uniqueProcessCount: cpu + 2
      },
      runtimeTelemetry: {
        coreEffects: {
          acknowledgedEffectCount: 12,
          activeOperationCount: 0,
          effectAckLatency: latency(p95Ms + 1),
          emittedEffectCount: 12,
          launchEffectCount: 10,
          launchOperationCount: 2,
          operationCapacity: 128,
          peakPendingEffectCount: 3,
          pendingEffectCapacity: 512,
          pendingEffectCount: 0
        },
        ipcCommand: latency(p95Ms),
        macroScheduleToDispatch: latency(p95Ms),
        tabActivation: latency(p95Ms)
      },
      sampleCount: 5
    });

    const summary = aggregatePerformanceSummaries([run(30, 3), run(10, 1), run(20, 2)]);
    expect(summary.medianNonRendererCpuPercent).toBe(20);
    expect(summary.runtimeTelemetry?.ipcCommand?.p95Ms).toBe(2);
    expect(summary.runtimeTelemetry?.ipcCommand?.sampleCount).toBe(6);
    expect(summary.runtimeTelemetry?.coreEffects?.effectAckLatency.p95Ms).toBe(3);
    expect(summary.runtimeTelemetry?.coreEffects?.peakPendingEffectCount).toBe(3);
    expect(summary.p95TreeCpuPercent).toBe(21);
    expect(summary.processCategories?.renderer?.peakCpuPercent).toBe(22);
    expect(summary.processChurn?.uniqueProcessCount).toBe(22);
    expect(summary.sampleCount).toBe(15);
  });

  it("reports actor release diagnostics without inventing thresholds", () => {
    const latency = { maxMs: 3, p50Ms: 2, p95Ms: 3, sampleCount: 2 };
    const baseline = {
      medianNonRendererCpuPercent: 100,
      medianNonRendererRssBytes: 1_000,
      medianTreeCpuPercent: 100,
      medianTreeRssBytes: 1_000,
      nonRendererRssGrowthPercent: 0,
      runtimeTelemetry: {
        ipcCommand: latency,
        macroScheduleToDispatch: latency,
        tabActivation: latency
      }
    };
    const current = {
      medianNonRendererCpuPercent: 50,
      medianNonRendererRssBytes: 500,
      medianTreeCpuPercent: 50,
      medianTreeRssBytes: 500,
      nonRendererRssGrowthPercent: 0,
      runtimeTelemetry: {
        coreEffects: {
          acknowledgedEffectCount: 18,
          activeOperationCount: 0,
          effectAckLatency: latency,
          emittedEffectCount: 18,
          launchEffectCount: 16,
          launchOperationCount: 2,
          operationCapacity: 128,
          peakPendingEffectCount: 4,
          pendingEffectCapacity: 512,
          pendingEffectCount: 0
        },
        ipcCommand: latency,
        macroScheduleToDispatch: latency,
        tabActivation: latency
      }
    };

    const comparison = comparePerformanceSummaries(current, baseline);
    expect(comparison.diagnostics).toMatchObject({
      effectQueuePeak: 4,
      effectQueueCapacity: 512,
      effectAckP95Ms: 3,
      effectsPerLaunch: 8
    });
  });

  it("gates workspace launch regression and main event-loop delay when traced", () => {
    const latency = (p95Ms: number) => ({
      maxMs: p95Ms,
      p50Ms: p95Ms,
      p95Ms,
      sampleCount: 3
    });
    const summary = (workspaceLaunchMs: number, eventLoopMs: number) => ({
      medianNonRendererCpuPercent: 50,
      medianNonRendererRssBytes: 500,
      medianTreeCpuPercent: 50,
      medianTreeRssBytes: 500,
      nonRendererRssGrowthPercent: 0,
      runtimeTelemetry: {
        ipcCommand: latency(1),
        macroScheduleToDispatch: latency(1),
        mainEventLoopDelay: latency(eventLoopMs),
        rendererRaf: latency(10),
        tabActivation: latency(1),
        workspaceLaunch: latency(workspaceLaunchMs)
      }
    });

    expect(comparePerformanceSummaries(
      summary(104, 16),
      {
        ...summary(100, 12),
        medianNonRendererCpuPercent: 100,
        medianNonRendererRssBytes: 1_000,
        medianTreeCpuPercent: 100,
        medianTreeRssBytes: 1_000
      }
    ).passed).toBe(true);
    expect(comparePerformanceSummaries(
      summary(106, 17),
      {
        ...summary(100, 12),
        medianNonRendererCpuPercent: 100,
        medianNonRendererRssBytes: 1_000,
        medianTreeCpuPercent: 100,
        medianTreeRssBytes: 1_000
      }
    ).passed).toBe(false);
    expect(comparePerformanceSummaries(
      {
        ...summary(100, 12),
        runtimeTelemetry: {
          ...summary(100, 12).runtimeTelemetry,
          rendererRaf: latency(10.6)
        }
      },
      {
        ...summary(100, 12),
        medianNonRendererCpuPercent: 100,
        medianNonRendererRssBytes: 1_000,
        medianTreeCpuPercent: 100,
        medianTreeRssBytes: 1_000
      }
    ).passed).toBe(false);
  });

  it("accepts at most five percent regression in non-regression mode", () => {
    const latency = (p95Ms: number) => ({
      maxMs: p95Ms,
      p50Ms: p95Ms,
      p95Ms,
      sampleCount: 3
    });
    const summary = (scale: number) => ({
      medianNonRendererCpuPercent: 100 * scale,
      medianNonRendererRssBytes: 1_000 * scale,
      medianTreeCpuPercent: 100 * scale,
      medianTreeRssBytes: 1_000 * scale,
      nonRendererRssGrowthPercent: 5,
      p95TreeCpuPercent: 200 * scale,
      p95TreeRssBytes: 2_000 * scale,
      runtimeTelemetry: {
        ipcCommand: latency(10 * scale),
        macroScheduleToDispatch: latency(10 * scale),
        mainEventLoopDelay: latency(10 * scale),
        rendererRaf: latency(10 * scale),
        tabActivation: latency(10 * scale),
        workspaceLaunch: latency(10 * scale)
      }
    });

    const comparison = comparePerformanceNonRegression(summary(1.05), summary(1));
    expect(comparison.passed).toBe(true);
    expect(comparison.maximumRegressionPercent).toBe(5);
    expect(comparison.gates.treeRssRegressionPercent).toBeCloseTo(5);
    expect(comparePerformanceNonRegression(summary(1.051), summary(1)).passed).toBe(false);
  });

  it("requires core telemetry samples in non-regression mode", () => {
    const latency = { maxMs: 1, p50Ms: 1, p95Ms: 1, sampleCount: 1 };
    const summary = {
      medianNonRendererCpuPercent: 1,
      medianNonRendererRssBytes: 1,
      medianTreeCpuPercent: 1,
      medianTreeRssBytes: 1,
      nonRendererRssGrowthPercent: 0,
      runtimeTelemetry: {
        ipcCommand: latency,
        macroScheduleToDispatch: latency,
        tabActivation: latency
      }
    };
    const baseline = {
      ...summary,
      runtimeTelemetry: {
        ...summary.runtimeTelemetry,
        tabActivation: { ...latency, sampleCount: 0 }
      }
    };

    const comparison = comparePerformanceNonRegression(summary, baseline);
    expect(comparison.passed).toBe(false);
    expect(comparison.missingTelemetryMetrics).toEqual(["tabActivation"]);
  });
});
