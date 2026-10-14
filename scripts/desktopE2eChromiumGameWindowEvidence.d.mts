export function validateChromiumGameWindowRuntimeEvidence(input: Readonly<{
  phase: string;
  phaseDirectory: string;
  platform: "macos" | "windows";
}>): Promise<unknown | undefined>;

export function validateChromiumGameWindowSqliteEvidence(
  phase: string,
  entities: Readonly<Record<string, readonly unknown[]>>
): Readonly<{
  emptyTabSetPersisted: boolean;
  savedPresentation: "maximized" | "fullscreen";
  restartVerified: boolean;
  windowId: string;
}>;
