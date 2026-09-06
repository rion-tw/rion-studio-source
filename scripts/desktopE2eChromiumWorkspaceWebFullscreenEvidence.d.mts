export const chromiumWorkspaceWebFullscreenPhaseDependencies: ReadonlyArray<readonly [
  string,
  readonly string[]
]>;
export const chromiumWorkspaceWebFullscreenPhaseNamespaces: ReadonlyArray<readonly [
  string,
  string
]>;

export function isChromiumWorkspaceWebFullscreenPhase(phase: string): boolean;
export function validPopupParentRevisionSequence(before: unknown, during: unknown, after: unknown): boolean;
export function validateChromiumWorkspaceWebPopupLifecycleEvidence(
  journal: unknown,
  workspace: unknown,
  visiblePopup: unknown
): Readonly<{
  openOperationId: string;
  popupId: string;
  terminalSequence: number;
}>;
export function validateChromiumWorkspaceWebFullscreenRuntimeEvidence(input: Readonly<{
  phase: string;
  phaseDirectory: string;
  platform: "macos" | "windows";
}>): Promise<unknown | undefined>;
export function validateChromiumWorkspaceWebFullscreenSqliteEvidence(
  phase: string,
  entities: Readonly<Record<string, readonly unknown[]>>,
  settings: readonly unknown[]
): unknown | undefined;
