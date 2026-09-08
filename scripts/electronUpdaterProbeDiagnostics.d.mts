export function runUpdaterProbeWithDiagnostics<T>(input: Readonly<{
  run: () => Promise<T>;
  outputPath?: string;
  sourceSha?: string;
  platform: NodeJS.Platform;
  privateValues?: readonly (string | undefined)[];
}>): Promise<T>;
