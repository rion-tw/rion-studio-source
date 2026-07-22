import { describe, expect, it } from "vitest";

import {
  aggregatePerformanceSummaries,
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
      runtimeTelemetry: {
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
    expect(summary.sampleCount).toBe(15);
  });
});
