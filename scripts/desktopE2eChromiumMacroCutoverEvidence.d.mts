export const chromiumMacroCutoverPhaseDependencies: readonly (
  readonly [string, readonly string[]]
)[];

export const chromiumMacroCutoverPhaseNamespaces: readonly (
  readonly [string, string]
)[];

export const chromiumMacroCutoverReplacementPlan: readonly Readonly<{
  feature: "macros" | "roles";
  id: string;
  kind: "native";
  outcomes: readonly ("failure" | "restart" | "success")[];
  phases: readonly string[];
  platform: "macos" | "windows";
  priority: "P0" | "P1";
  replaces: readonly string[];
  risk: "native";
}>[];

export function isChromiumMacroCutoverPhase(candidate: string): boolean;

export function validateChromiumMacroCutoverRuntimeEvidence(input: Readonly<{
  phase: string;
  phaseDirectory: string;
  platform: "macos" | "windows";
}>): Promise<unknown | undefined>;

export function validateChromiumMacroCutoverSqliteEvidence(input: Readonly<{
  entities: Record<string, readonly Readonly<{
    id: string;
    name: string;
    payload?: Record<string, unknown>;
  }>[]>;
  phase: string;
  settings: readonly Readonly<{ key: string; payload?: Record<string, unknown> }>[];
}>): unknown | undefined;
