import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  classifyProcess,
  processCategoryTotals,
  summarizeProcessCategories
} from "../scripts/performanceProcessMetrics.mjs";

describe("performance process metrics", () => {
  it.each([
    [{ pid: 10, command: "Rion Studio" }, 10, "app"],
    [{ pid: 11, command: "msedgewebview2.exe --type=renderer" }, 10, "renderer"],
    [{ pid: 12, command: "msedgewebview2.exe --type=gpu-process" }, 10, "gpu"],
    [{ pid: 13, command: "msedgewebview2.exe --type=utility" }, 10, "browserUtility"],
    [{ pid: 14, command: "com.apple.WebKit.WebContent" }, 10, "renderer"],
    [{ pid: 15, command: "com.apple.WebKit.GPU" }, 10, "gpu"]
  ])("classifies %s", (entry, rootPid, expected) => {
    expect(classifyProcess(entry, rootPid)).toBe(expected);
  });

  it("summarizes median, p95, peak, and process counts by category", () => {
    const first = processCategoryTotals([
      { pid: 10, command: "Rion Studio", cpuPercent: 2, rssKiB: 100 },
      { pid: 11, command: "WebKit.WebContent", cpuPercent: 20, rssKiB: 400 },
      { pid: 12, command: "WebKit.GPU", cpuPercent: 5, rssKiB: 200 }
    ], 10);
    const second = processCategoryTotals([
      { pid: 10, command: "Rion Studio", cpuPercent: 4, rssKiB: 120 },
      { pid: 11, command: "WebKit.WebContent", cpuPercent: 40, rssKiB: 500 },
      { pid: 13, command: "WebKit.WebContent", cpuPercent: 10, rssKiB: 300 }
    ], 10);
    const summary = summarizeProcessCategories([
      { processCategories: first },
      { processCategories: second }
    ]);

    expect(summary.app).toMatchObject({
      medianCpuPercent: 3,
      p95CpuPercent: 4,
      peakCpuPercent: 4,
      peakProcessCount: 1
    });
    expect(summary.renderer).toMatchObject({
      medianCpuPercent: 35,
      p95CpuPercent: 50,
      peakCpuPercent: 50,
      peakProcessCount: 2
    });
    expect(summary.gpu.peakRssBytes).toBe(200 * 1024);
  });

  it("keeps a deterministic Canvas text and OffscreenCanvas workload in the fixture", async () => {
    const fixture = await readFile("scripts/performanceFixtureServer.mjs", "utf8");
    expect(fixture).toContain('url.searchParams.get("text")');
    expect(fixture).toContain("context.measureText(label)");
    expect(fixture).toContain("context.strokeText(label");
    expect(fixture).toContain("new OffscreenCanvas");
    expect(fixture).toContain("glyphContext.fillText");
    expect(fixture).toContain("context.font=fixtureFont");
    expect(fixture).toContain("glyphContext.font=glyphFont");
  });

  it("requires schema version 2 for direct and aggregated comparisons", async () => {
    const [benchmark, aggregate] = await Promise.all([
      readFile("scripts/benchmarkProcessTree.mjs", "utf8"),
      readFile("scripts/aggregatePerformanceRuns.mjs", "utf8")
    ]);
    expect(benchmark).toContain("schemaVersion: 2");
    expect(benchmark).toContain("baseline.schemaVersion !== 2");
    expect(aggregate).toContain("schemaVersion: 2");
    expect(aggregate).toContain("run?.schemaVersion !== 2");
  });
});
