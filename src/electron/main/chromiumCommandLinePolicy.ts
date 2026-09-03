import { posix, win32 } from "node:path";

import { RionBridgeError } from "../ipc/errors";

export const CHROMIUM_REMOTE_DEBUGGING_SWITCHES = Object.freeze([
  "remote-debugging-port",
  "remote-debugging-pipe"
] as const);

export interface ChromiumCommandLinePort {
  hasSwitch(name: string): boolean;
}

export interface ChromiumCommandLinePolicyInput {
  readonly commandLine: ChromiumCommandLinePort;
  readonly desktopE2eEntryAuthorized?: boolean;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly isPackaged: boolean;
  readonly platform: NodeJS.Platform;
}

let desktopE2eEntryAuthorized = false;

export function authorizeDesktopE2eChromiumCommandLine(): void {
  desktopE2eEntryAuthorized = true;
}

export function enforceChromiumCommandLinePolicy(
  input: ChromiumCommandLinePolicyInput
): "desktop-e2e" | "not-requested" {
  const requested = CHROMIUM_REMOTE_DEBUGGING_SWITCHES.filter((name) =>
    input.commandLine.hasSwitch(name)
  );
  if (requested.length === 0) return "not-requested";
  if (
    requested.length === 1 &&
    hasExactDesktopE2eCapability({
      ...input,
      desktopE2eEntryAuthorized: input.desktopE2eEntryAuthorized ??
        desktopE2eEntryAuthorized
    })
  ) {
    return "desktop-e2e";
  }
  throw new RionBridgeError({
    code: "ELECTRON_REMOTE_DEBUGGING_FORBIDDEN",
    message: "Chromium remote debugging is unavailable outside the isolated desktop E2E capability."
  });
}

function hasExactDesktopE2eCapability(
  input: Required<Pick<
    ChromiumCommandLinePolicyInput,
    "desktopE2eEntryAuthorized"
  >> & Omit<ChromiumCommandLinePolicyInput, "desktopE2eEntryAuthorized">
): boolean {
  const environment = input.environment;
  if (input.isPackaged || !input.desktopE2eEntryAuthorized) return false;
  const expectedTarget = input.platform === "darwin"
    ? "chromium-v23-macos-appkit"
    : input.platform === "win32"
      ? "chromium-v23-windows"
      : undefined;
  const sessionToken = environment.RION_STUDIO_E2E_SESSION_TOKEN;
  if (
    expectedTarget === undefined ||
    environment.RION_STUDIO_E2E_RUNTIME_TARGET !== expectedTarget ||
    typeof sessionToken !== "string" ||
    !/^[a-f0-9]{64}$/u.test(sessionToken) ||
    !isAbsoluteForPlatform(
      environment.RION_STUDIO_E2E_ARTIFACT_DIR,
      input.platform
    )
  ) {
    return false;
  }
  return environment.RION_STUDIO_E2E_PACKAGED !== "1" &&
    isAbsoluteForPlatform(
      environment.RION_STUDIO_USER_DATA_DIR,
      input.platform
    );
}

function isAbsoluteForPlatform(
  value: string | undefined,
  platform: NodeJS.Platform
): value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    return false;
  }
  return platform === "win32" ? win32.isAbsolute(value) : posix.isAbsolute(value);
}
