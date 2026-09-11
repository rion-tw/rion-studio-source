import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

const forcedTerminationPhases = new Set([
  "chromium-app-recovery-force",
  "chromium-mixed-recovery-force",
  "chromium-window-recovery-force",
  "chromium-window-recovery-restore-force"
]);

export function isExpectedDesktopE2eForcedTermination(phase) {
  return forcedTerminationPhases.has(phase);
}

export function desktopE2eForcedTerminationEnvironment(phase) {
  return isExpectedDesktopE2eForcedTermination(phase)
    ? { RION_STUDIO_E2E_TERMINAL_NATIVE_QUIT: "1" }
    : {};
}

async function exactPosixProcessState(pid) {
  try {
    const { stdout } = await executeFile("/bin/ps", ["-p", String(pid), "-o", "state="]);
    return stdout.trim();
  } catch (error) {
    if (error?.code === 1) return undefined;
    throw error;
  }
}

/** Verifies the exact marked process is gone without broad process discovery. */
export async function acceptedDesktopE2eForcedTermination(phaseDirectory) {
  const markerPath = resolve(phaseDirectory, "forced-termination.json");
  let marker;
  try {
    marker = JSON.parse(await readFile(markerPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  if (!Number.isSafeInteger(marker.pid) || marker.pid <= 0) {
    throw new Error("Forced-termination marker did not contain a valid PID");
  }
  try {
    process.kill(marker.pid, 0);
  } catch (error) {
    if (error?.code === "ESRCH") return marker;
    throw error;
  }
  if (process.platform !== "win32") {
    const state = await exactPosixProcessState(marker.pid);
    if (!state || state.startsWith("Z")) return marker;
  }
  throw new Error(`Desktop E2E PID ${marker.pid} survived its forced-termination phase`);
}
