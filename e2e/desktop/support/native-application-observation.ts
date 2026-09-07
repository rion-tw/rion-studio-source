import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { browser } from "@wdio/globals";
import { electronDesktopE2eProbe } from "./electron-driver";

const execute = promisify(execFile);

/** Read-only focus evidence at a specific UI boundary; never changes the test outcome. */
export async function captureNativeApplicationObservation(stage: string): Promise<void> {
  if (process.platform !== "darwin" || !/^[a-z0-9-]+$/u.test(stage)) return;
  const directory = process.env.RION_STUDIO_E2E_ARTIFACT_DIR;
  if (!directory || !isAbsolute(directory)) return;
  try {
    const { processId } = await electronDesktopE2eProbe();
    // DeadlineBound: one read-only OS observation, with no retry or state repair.
    const { stdout } = await execute("/usr/bin/xcrun", ["swift",
      fileURLToPath(new URL("./macos-application-observation.swift", import.meta.url)),
      String(processId)
    ], { timeout: 10_000, maxBuffer: 64 * 1024 });
    const rendererFocused = await browser.execute(() => document.hasFocus());
    await writeFile(join(directory, `native-application-${stage}.json`), JSON.stringify({
      stage, rendererFocused, native: JSON.parse(stdout)
    }, null, 2));
  } catch {
    // Observation failure must not replace an authoritative journey failure.
  }
}
