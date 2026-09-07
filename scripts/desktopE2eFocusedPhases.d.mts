export function resolveDesktopE2eFocusedPhases(input: {
  configuredPhases: readonly string[];
  dependencies: ReadonlyMap<string, readonly string[]>;
  phase: string;
}): string[];
