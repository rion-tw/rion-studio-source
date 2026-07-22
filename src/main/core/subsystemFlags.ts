export type RustSubsystem =
  | "cdn"
  | "external-chrome"
  | "layout-lifecycle"
  | "macro-timing"
  | "pressure"
  | "resource-policy";

export function isRustSubsystemEnabled(
  subsystem: RustSubsystem,
  environment: NodeJS.ProcessEnv = process.env
): boolean {
  const fallbacks = new Set(
    (environment.RION_STUDIO_RUST_FALLBACK_SUBSYSTEMS ?? "")
      .split(",")
      .map((value) => value.trim().toLocaleLowerCase())
      .filter(Boolean)
  );
  return !fallbacks.has("all") && !fallbacks.has(subsystem);
}
