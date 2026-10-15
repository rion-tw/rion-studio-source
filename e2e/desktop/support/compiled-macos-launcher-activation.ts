import { execFile } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { boundedNativeProcessFailure } from "./compiled-macos-native-focus";

const executeFile = promisify(execFile);
const script = fileURLToPath(new URL("./macos-launcher-activation.swift", import.meta.url));
const executables = new Map<string, Promise<string>>();

/** Prepare the phase-local launcher helper before any AX or input eligibility is captured. */
export async function prepareMacosLauncherActivation(): Promise<string> {
  const directory = process.env.RION_STUDIO_E2E_ARTIFACT_DIR;
  if (!directory || !isAbsolute(directory)) {
    throw new Error("The compiled macOS launcher helper requires its absolute phase artifact directory");
  }
  const executable = resolve(directory, "macos-launcher-activation");
  let pending = executables.get(executable);
  if (!pending) {
    pending = (async () => {
      const started = Date.now();
      try {
        // Match the existing native-focus helper's separate cold SDK compilation bound.
        await executeFile("/usr/bin/xcrun", ["swiftc", script, "-o", executable],
          { encoding: "utf8", timeout: 120_000 });
      } catch (cause) {
        throw new Error(`Compile macos-launcher-activation failed after ${Date.now() - started}ms ` +
          `(${boundedNativeProcessFailure(cause)})`, { cause });
      }
      return executable;
    })();
    // A failed compile remains authoritative for this exact phase; never retry it.
    executables.set(executable, pending);
  }
  return pending;
}
