export const chromiumMacroBackgroundTabPhaseDependencies: ReadonlyArray<readonly [
  string,
  readonly string[]
]>;
export const chromiumMacroBackgroundTabPhaseNamespaces: ReadonlyArray<
  readonly [string, string]
>;

export function isChromiumMacroBackgroundTabPhase(phase: string): boolean;
export function validateChromiumMacroBackgroundTabRuntimeEvidence(input: Readonly<{
  phase: string;
  phaseDirectory: string;
  platform: "macos" | "windows";
}>): Promise<unknown | undefined>;
export function validateChromiumMacroBackgroundTabSqliteEvidence(input: Readonly<{
  entities: Readonly<Record<string, readonly unknown[]>>;
  phase: string;
  phaseDirectory: string;
  settings: readonly unknown[];
}>): unknown | undefined;
