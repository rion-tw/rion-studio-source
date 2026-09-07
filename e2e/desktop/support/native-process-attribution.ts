import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** Bounded, command-argument-free evidence for macOS Accessibility failures. */
export async function captureNativeProcessAttribution(): Promise<void> {
  const directory = process.env.RION_STUDIO_E2E_ARTIFACT_DIR;
  if (process.platform !== "darwin" || !directory || !isAbsolute(directory)) return;
  const ancestry: string[] = [];
  let processId = process.pid;
  try {
    for (let depth = 0; depth < 10 && processId > 1; depth += 1) {
      const { stdout } = await execute("/bin/ps", [
        "-p", String(processId), "-o", "pid=,ppid=,comm="
      ], { encoding: "utf8", timeout: 2_000 });
      const row = stdout.trim();
      ancestry.push(row);
      const parent = Number(row.split(/\s+/u)[1]);
      if (!Number.isSafeInteger(parent) || parent === processId) break;
      processId = parent;
    }
    await writeFile(join(directory, "native-process-attribution.json"), JSON.stringify({
      executable: process.execPath, processId: process.pid, ancestry
    }, null, 2));
  } catch {
    // Diagnostic failure cannot replace the primary native action error.
  }
}
