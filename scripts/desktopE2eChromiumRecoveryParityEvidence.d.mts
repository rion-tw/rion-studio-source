export const chromiumRecoveryParityPhaseDependencies: ReadonlyArray<readonly [
  string,
  readonly string[]
]>;
export const chromiumRecoveryParityPhaseNamespaces: ReadonlyArray<readonly [string, string]>;

export function isChromiumRecoveryParityPhase(phase: string): boolean;
export function validateChromiumRecoveryParityRuntimeEvidence(input: Readonly<{
  phase: string;
  phaseDirectory: string;
  platform: "macos" | "windows";
}>): Promise<unknown | undefined>;
export function validateChromiumRecoveryParitySqliteEvidence(input: Readonly<{
  entities: Readonly<Record<string, readonly unknown[]>>;
  phase: string;
  phaseDirectory: string;
  settings: readonly unknown[];
}>): Promise<unknown | undefined>;
