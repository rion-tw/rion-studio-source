import { readFile, watch } from "node:fs/promises";
import { basename, resolve } from "node:path";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required by terminal native quit`);
  return value;
}

async function readFinalFlushMarker(path: string): Promise<boolean> {
  try {
    const marker = JSON.parse(await readFile(path, "utf8")) as {
      complete?: boolean;
      phase?: string;
      runtimeTarget?: string;
    };
    return marker.complete === true &&
      marker.phase === required("RION_STUDIO_E2E_PHASE") &&
      marker.runtimeTarget === required("RION_STUDIO_E2E_RUNTIME_TARGET");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Waits on the exact main-process flush marker without another WebDriver call. */
export async function waitForElectronDesktopE2eTerminalNativeQuit(): Promise<void> {
  const directory = required("RION_STUDIO_E2E_ARTIFACT_DIR");
  const markerPath = resolve(directory, "electron-final-flush.json");
  if (await readFinalFlushMarker(markerPath)) return;
  const changes = watch(directory, { signal: AbortSignal.timeout(45_000) });
  if (await readFinalFlushMarker(markerPath)) {
    await changes.return?.();
    return;
  }
  try {
    for await (const change of changes) {
      if (change.filename === "electron-final-flush.json" &&
          await readFinalFlushMarker(markerPath)) return;
    }
  } catch (error) {
    if ((error as Error).name !== "AbortError") throw error;
  }
  throw new Error("The AppKit terminal event did not reach final flush");
}

export async function readElectronDesktopE2eTerminalJson(
  fileName: string
): Promise<unknown> {
  if (basename(fileName) !== fileName || !/^electron-[a-z0-9-]+\.json$/u.test(fileName)) {
    throw new Error("The terminal E2E artifact name is invalid");
  }
  return JSON.parse(await readFile(
    resolve(required("RION_STUDIO_E2E_ARTIFACT_DIR"), fileName),
    "utf8"
  ));
}
