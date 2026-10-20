/**
 * Collection codes every Electron diagnostics capture reports by design: legacy
 * producers that do not exist yet, and the cached Core snapshot that replaces a
 * blocking live read. They describe the bundle's shape, not a capture failure.
 */
export const DESIGNED_DIAGNOSTIC_GAP_CODES = Object.freeze([
  "ELECTRON_RUNTIME_SURFACE_PHASE_DIAGNOSTICS_UNAVAILABLE",
  "ELECTRON_RUNTIME_HEALTH_DIAGNOSTICS_UNAVAILABLE",
  "ELECTRON_RUNTIME_RECOVERY_DIAGNOSTICS_UNAVAILABLE",
  "ELECTRON_RUNTIME_MACRO_DIAGNOSTICS_UNAVAILABLE",
  "ELECTRON_RUNTIME_LAUNCH_DIAGNOSTICS_UNAVAILABLE",
  "ELECTRON_RUNTIME_NATIVE_CREATION_DIAGNOSTICS_UNAVAILABLE",
  "ELECTRON_RUNTIME_OPERATION_DIAGNOSTICS_UNAVAILABLE",
  "ELECTRON_RUNTIME_KERNEL_DIAGNOSTICS_UNAVAILABLE"
] as const);

export const CACHED_CORE_SNAPSHOT_COLLECTION_CODE = "ELECTRON_RUNTIME_CORE_SNAPSHOT_CACHED";

const DESIGNED_CODES: ReadonlySet<string> = new Set([
  ...DESIGNED_DIAGNOSTIC_GAP_CODES,
  CACHED_CORE_SNAPSHOT_COLLECTION_CODE
]);

/** True when an export lost live data beyond the designed gaps. */
export function hasDiagnosticCollectionFailure(codes: readonly string[] | undefined): boolean {
  return (codes ?? []).some((code) => !DESIGNED_CODES.has(code));
}
