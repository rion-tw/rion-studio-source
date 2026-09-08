export function throwPackagedSmokeFailureWithDiagnostics(input: Readonly<{
  artifactDirectory: string;
  platform: "win32" | "darwin";
  stage: string;
  processId?: number;
  packageHashes: Readonly<Record<string, string>>;
  error: unknown;
  cleanupErrors: readonly unknown[];
  privateValues?: readonly (string | undefined)[];
}>): Promise<never>;
