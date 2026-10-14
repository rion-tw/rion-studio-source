export interface AdmittedExtensionMetadata {
  readonly id: string;
  readonly version: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly directory: string;
}
export const ADMITTED_EXTENSION: Readonly<Omit<AdmittedExtensionMetadata, "directory">>;
export const DIAGNOSTIC_STAGES: readonly string[];
export const GENERATED_RULESET_CACHE: string;
export function containedDiagnosticPath(root: string, candidate: string, allowRoot?: boolean): string;
export function admittedExtensionMetadata(query: unknown): AdmittedExtensionMetadata;
export function admittedManifestIdentity(manifest: unknown): Readonly<{ id: string; version: string; worker: string }>;
export function isGeneratedRulesetCachePath(directory: string, path: string): boolean;
export function assertDiagnosticTree(directory: string, excludeGeneratedRulesets?: boolean): Promise<Readonly<{ files: number; bytes: number }>>;
export function findAdmittedMacExtensionInput(artifactBase: string): Promise<Readonly<{
  sourceDirectory: string;
  metadata: AdmittedExtensionMetadata;
  manifest: Readonly<{ id: string; version: string; worker: string }>;
  tree: Readonly<{ files: number; bytes: number }>;
  copyTree: Readonly<{ files: number; bytes: number }>;
  generatedRulesetCache: Readonly<{ relativePath: string; present: boolean; excluded: true; files: number; bytes: number }>;
  manifestSha256: string;
  reportPath: string;
  report: Readonly<{ commit: unknown; startedAt: string; runtimeTarget: string }>;
}>>;
export function redactDiagnosticText(text: unknown, environment?: Readonly<Record<string, string | undefined>>): string;
export function instrumentDiagnosticPreload(source: string): string;
export function strictDiagnosticResultPassed(exitCode: number | null, result: unknown): boolean;
