export const chromiumWorkspaceCutoverPhaseDependencies: ReadonlyArray<readonly [
  string,
  readonly string[]
]>;
export const chromiumWorkspaceCutoverPhaseNamespaces: ReadonlyArray<readonly [
  string,
  string
]>;

export function isChromiumWorkspaceCutoverPhase(phase: string): boolean;
export function validateChromiumWorkspaceCutoverRuntimeEvidence(input: Readonly<{
  phase: string;
  phaseDirectory: string;
  platform: "macos" | "windows";
}>): Promise<unknown | undefined>;
export function validateChromiumWorkspaceCutoverSqliteEvidence(
  phase: string,
  entities: Readonly<Record<string, readonly unknown[]>>,
  settings: readonly unknown[]
): unknown | undefined;
