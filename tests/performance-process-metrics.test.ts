import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  classifyProcess,
  processCategoryTotals,
  summarizeProcessCategories
} from "../scripts/performanceProcessMetrics.mjs";
import {
  compareMacWebGlAcceptance,
  compareWindowsWebGlAcceptance
} from "../scripts/webGlPerformanceGates.mjs";

function webGlRun(fps: number, p10Fps = fps - 5) {
  return {
    fixture: "rion-webgl1-120" as const,
    sampleMs: 10_000,
    samples: Array.from({ length: 5 }, () => ({
      canvas: {
        cssHeight: 720,
        cssWidth: 1280,
        devicePixelRatio: 2,
        pixelHeight: 1440,
        pixelWidth: 2560
      },
      context: { attributes: { antialias: false }, renderer: "Test GPU" },
      gameLoop: { fps, p10Fps },
      presentation: { fps: 60, missedFrameRatio: 0 },
      workloadProfile: "flyff-like" as const
    })),
    soak: { contextLosses: 0, durationMs: 600_000 },
    warmupMs: 30_000
  };
}

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

  it("provides a native-resolution 120 Hz WebGL1 game-loop fixture", async () => {
    const fixture = await readFile("scripts/performanceFixtureServer.mjs", "utf8");
    expect(fixture).toContain('"/webgl-120"');
    expect(fixture).toContain('canvas.getContext("webgl"');
    expect(fixture).toContain("antialias:false");
    expect(fixture).toContain("const targetFps=120");
    expect(fixture).toContain('url.searchParams.get("busyMs")');
    expect(fixture).toContain('url.searchParams.get("profile")');
    expect(fixture).toContain('workloadProfile==="flyff-like"');
    expect(fixture).toContain("gl.uniformMatrix4fv");
    expect(fixture).toContain("gl.uniform3fv");
    expect(fixture).toContain("gl.vertexAttribPointer");
    expect(fixture).toContain("gl.drawElements");
    expect(fixture).toContain('if(workloadProfile==="draw")gl.flush()');
    expect(fixture).toContain("const busyUntil=performance.now()+fixedBusyMs");
    expect(fixture).toContain("setTimeout(gameTick");
    expect(fixture).toContain("requestAnimationFrame(presentationTick)");
    expect(fixture).toContain("__rionWebGlPerformanceSnapshot");
    expect(fixture).toContain("__rionWebGlPerformanceRun");
    expect(fixture).toContain("options.warmupMs??30000");
    expect(fixture).toContain("options.sampleCount??5");
    expect(fixture).toContain("options.sampleMs??10000");
    expect(fixture).toContain("options.soakMs??600000");
    expect(fixture).toContain("contextLosses");
    expect(fixture).toContain("devicePixelRatio");
  });

  it("enforces the macOS WebGL improvement, parity, quality, and soak gates", () => {
    const comparison = compareMacWebGlAcceptance({
      brave: webGlRun(120, 112),
      compatibility: webGlRun(96, 90),
      extreme: webGlRun(112, 105),
      visualOutputMatched: true
    });
    expect(comparison.passed).toBe(true);
    expect(comparison.gates).toMatchObject({
      nativeSurfaceMatched: true,
      presentationMissedFrameRatio: 0,
      visualOutputMatched: true
    });
    expect(compareMacWebGlAcceptance({
      brave: webGlRun(120, 112),
      compatibility: webGlRun(96, 90),
      extreme: webGlRun(112, 105),
      visualOutputMatched: false
    }).passed).toBe(false);
    expect(() => compareMacWebGlAcceptance({
      brave: webGlRun(120, 112),
      compatibility: webGlRun(96, 90),
      extreme: {
        ...webGlRun(112, 105),
        samples: webGlRun(112, 105).samples.map((sample) => ({
          ...sample,
          workloadProfile: "draw" as unknown as "flyff-like"
        }))
      },
      visualOutputMatched: true
    })).toThrow("Flyff-like");
  });

  it("rejects Windows WebGL runs without the managed GPU process policy", () => {
    const passing = {
      brave: webGlRun(118, 108),
      edge: webGlRun(120, 110),
      gpuProcessPresent: true,
      hardwareAccelerationEnabled: true,
      maximumModeStatus: "engineManaged",
      productionGraphicsFlags: [],
      rion: webGlRun(113, 104),
      visualOutputMatched: true,
      webGlExecutionPath: "engineManaged"
    };
    expect(compareWindowsWebGlAcceptance(passing).passed).toBe(true);
    expect(compareWindowsWebGlAcceptance({
      ...passing,
      productionGraphicsFlags: ["--disable-gpu-vsync"]
    }).passed).toBe(false);
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
