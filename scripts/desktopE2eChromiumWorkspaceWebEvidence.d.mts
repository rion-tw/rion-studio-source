export const chromiumWorkspaceWebPhaseDependencies: ReadonlyArray<readonly [
  string,
  readonly string[]
]>;
export const chromiumWorkspaceWebPhaseNamespaces: ReadonlyArray<readonly [
  string,
  string
]>;

export function isChromiumWorkspaceWebPhase(phase: string): boolean;
export function validateChromiumWorkspaceWebRuntimeEvidence(input: Readonly<{
  phase: string;
  phaseDirectory: string;
  platform: "macos" | "windows";
}>): Promise<unknown | undefined>;
export function validateChromiumWorkspaceWebSqliteEvidence(
  phase: string,
  entities: Readonly<Record<string, readonly unknown[]>>,
  settings: readonly unknown[]
): Readonly<{
  cleanExit: boolean;
  gameWindowId: string;
  resizedWebWidth: number;
  restartVerified: boolean;
  workspaceId: string;
}>;
