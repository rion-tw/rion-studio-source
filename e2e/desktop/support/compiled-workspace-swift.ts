import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

const executables = new Map<string, Promise<string>>();
/** Compile each native evidence/input helper once per isolated E2E phase. */
export async function runWorkspaceSwift(name: "workspace-window-resize" | "workspace-pixels", request: string): Promise<string> {
  let executable = executables.get(name);
  if (!executable) {
    executable = (async () => {
      const path = resolve(process.env.RION_STUDIO_E2E_ARTIFACT_DIR!, name);
      await promisify(execFile)("/usr/bin/xcrun", ["swiftc", resolve(import.meta.dirname, `${name}.swift`), "-o", path],
        { timeout: 30_000 });
      return path;
    })();
    executables.set(name, executable);
  }
  const result = await promisify(execFile)(await executable, [request], { timeout: 30_000 });
  return result.stdout;
}
