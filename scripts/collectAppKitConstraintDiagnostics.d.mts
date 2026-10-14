export const appKitConstraintPrefixes: readonly string[];
export function collectAppKitConstraintDiagnostics(input: {
  artifactRoot: string;
  nativeAddonPath?: string;
  platform?: NodeJS.Platform;
  inspectPrefixes?: (addon: string) => Promise<readonly string[]>;
  execute?: (file: string, args: string[], options: { timeout: number; maxBuffer: number }) => Promise<{ stdout: string }>;
}): Promise<{
  witnesses: { processId: number; phase: string }[];
  processIds: number[];
  rowCount: number;
  invalidPayloadCount: number;
  prefixCounts: Record<string, number>;
}>;
