const CHROMIUM_E2E_RUNTIME_TARGETS = new Set([
  "chromium-v23-macos-appkit",
  "chromium-v23-windows"
]);

export function preserveWebDriverUserDataDirectory(input: {
  driverUserDataSwitchPresent: boolean;
  packaged: boolean;
  runtimeTarget?: string;
}): boolean {
  return !input.packaged &&
    input.driverUserDataSwitchPresent &&
    typeof input.runtimeTarget === "string" &&
    CHROMIUM_E2E_RUNTIME_TARGETS.has(input.runtimeTarget);
}
