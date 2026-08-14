export interface WebGlFixtureSample {
  canvas: {
    cssHeight: number;
    cssWidth: number;
    devicePixelRatio: number;
    pixelHeight: number;
    pixelWidth: number;
  };
  context: {
    attributes: { antialias: boolean };
    renderer?: string;
  };
  gameLoop: { fps: number; p10Fps: number };
  presentation: { fps: number; missedFrameRatio: number };
  workloadProfile: "flyff-like";
}

export interface WebGlFixtureRun {
  fixture: "rion-webgl1-120";
  samples: WebGlFixtureSample[];
  sampleMs: number;
  soak: { contextLosses: number; durationMs: number };
  warmupMs: number;
}

export function summarizeWebGlRun(run: WebGlFixtureRun): Record<string, unknown>;

export function compareMacWebGlAcceptance(input: {
  brave: WebGlFixtureRun;
  compatibility: WebGlFixtureRun;
  extreme: WebGlFixtureRun;
  visualOutputMatched: boolean;
}): { passed: boolean; gates: Record<string, unknown>; runs: Record<string, unknown> };

export function compareWindowsWebGlAcceptance(input: {
  brave: WebGlFixtureRun;
  edge: WebGlFixtureRun;
  gpuProcessPresent?: boolean;
  hardwareAccelerationEnabled?: boolean;
  productionGraphicsFlags?: string[];
  rion: WebGlFixtureRun;
  visualOutputMatched: boolean;
  webGlExecutionPath?: string;
}): { passed: boolean; gates: Record<string, unknown>; runs: Record<string, unknown> };
