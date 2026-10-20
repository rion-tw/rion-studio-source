export const DESKTOP_E2E_PHASE_WEIGHTS: Readonly<Record<string, number>>;

export function parseDesktopE2eShard(
  argument: string | undefined
): Readonly<{ count: number; index: number }> | undefined;

export function partitionDesktopE2ePhases(input: Readonly<{
  phases: readonly string[];
  dependencies: ReadonlyMap<string, readonly string[]>;
  namespaces: ReadonlyMap<string, string>;
  prerequisites?: (phase: string) => readonly string[];
  count: number;
  weights?: Readonly<Record<string, number>>;
}>): string[][];
