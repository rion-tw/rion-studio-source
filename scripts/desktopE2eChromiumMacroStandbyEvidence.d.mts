export const chromiumMacroStandbyPhaseDependencies: ReadonlyArray<readonly [
  string,
  readonly string[]
]>;
export const chromiumMacroStandbyPhaseNamespaces: ReadonlyArray<readonly [string, string]>;

export function isChromiumMacroStandbyPhase(phase: string): boolean;
export function validateChromiumMacroStandbyRuntimeEvidence(input: Readonly<{
  phase: string;
  phaseDirectory: string;
  platform: "macos" | "windows";
}>): Promise<unknown | undefined>;
export function validateChromiumMacroStandbySqliteEvidence(input: Readonly<{
  entities: Readonly<Record<string, readonly unknown[]>>;
  phase: string;
  phaseDirectory: string;
  settings: readonly unknown[];
}>): unknown | undefined;
