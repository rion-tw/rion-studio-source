import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
type Execute = (file: string, args: readonly string[], options: Readonly<{
  encoding: "utf8"; timeout: number;
}>) => Promise<Readonly<{ stdout: string }>>;
interface MacosLauncherActivationReceipt {
  processId: number;
  ownerProcessId: number;
  foregroundProcessId: number;
  role: "AXWindow";
  main: true;
  launcherCount: 1;
  retainedOwner: true;
}

/** Exact native activation precedes DOM focus; this submits no control input. */
export async function activateMacosLauncherForVisibleControl(
  input: Readonly<{ platform: "macos" | "windows"; processId: number }>,
  dependencies: Readonly<{ hostPlatform?: NodeJS.Platform; execute?: Execute }> = {}
): Promise<MacosLauncherActivationReceipt> {
  if (input.platform !== "macos" || (dependencies.hostPlatform ?? process.platform) !== "darwin") {
    throw new Error("Visible Mac launcher activation requires the explicit macOS platform and host");
  }
  if (!Number.isSafeInteger(input.processId) || input.processId <= 1 || input.processId > 2_147_483_647) {
    throw new Error("Visible Mac launcher activation requires one exact positive app PID");
  }
  const { stdout } = await (dependencies.execute ?? executeFile)("/usr/bin/xcrun", [
    "swift", fileURLToPath(new URL("./macos-launcher-activation.swift", import.meta.url)), String(input.processId)
  ], { encoding: "utf8", timeout: 10_000 });
  const receipt = JSON.parse(stdout) as Partial<MacosLauncherActivationReceipt> | null;
  const keys = ["processId", "ownerProcessId", "foregroundProcessId", "role", "main", "launcherCount", "retainedOwner"];
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt) ||
      Object.keys(receipt).length !== keys.length || !keys.every(key => key in receipt) ||
      receipt.processId !== input.processId || receipt.ownerProcessId !== input.processId ||
      receipt.foregroundProcessId !== input.processId || receipt.role !== "AXWindow" ||
      receipt.main !== true || receipt.launcherCount !== 1 || receipt.retainedOwner !== true) {
    throw new Error("The retained exact Mac launcher activation receipt is invalid");
  }
  return Object.freeze(receipt as MacosLauncherActivationReceipt);
}
