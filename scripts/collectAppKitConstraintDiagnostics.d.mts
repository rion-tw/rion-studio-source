export const appKitConstraintPrefixes: readonly string[];
export function assembleAppKitConstraintFragments(fragments: readonly {
  timestamp?: string; processId: number; eventMessage: string;
}[], processIds: readonly number[]): {
  rows: { timestamp?: string; processId: number; prefix: string; id: string; data: Record<string, unknown> }[];
  summary: {
    fragmentCount: number; completedSnapshotCount: number; failedSnapshotCount: number;
    errorCount: number; errors: string[];
    snapshots: { processId: number; prefix: string; id: string; expectedCount: number; receivedCount: number; status: string }[];
  };
};
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
  fragmentCount: number;
  prefixCounts: Record<string, number>;
}>;
