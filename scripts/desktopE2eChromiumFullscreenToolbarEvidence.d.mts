export const chromiumFullscreenToolbarPhaseDependencies: ReadonlyArray<readonly [
  string, readonly string[]
]>;
export const chromiumFullscreenToolbarPhaseNamespaces: ReadonlyArray<readonly [string, string]>;
export function isChromiumFullscreenToolbarPhase(phase: string): boolean;
export function validateChromiumFullscreenToolbarRuntimeEvidence(input: Readonly<{
  phase: string;
  phaseDirectory: string;
  platform: "macos" | "windows";
}>): Promise<unknown | undefined>;
export function validateChromiumFullscreenToolbarSqliteEvidence(
  phase: string,
  entities: Readonly<Record<string, readonly unknown[]>>,
  settings: readonly unknown[]
): unknown;
