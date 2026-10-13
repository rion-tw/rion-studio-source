import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

const executables = new Map<string, Promise<string>>();
async function execute(stage: string, file: string, args: string[], timeout: number): Promise<string> {
  const started = Date.now();
  try {
    return (await promisify(execFile)(file, args, { timeout })).stdout;
  } catch (cause) {
    const error = cause as Error & { code?: string | number; signal?: string; killed?: boolean; stderr?: string };
    throw new Error(`${stage} failed after ${Date.now() - started}ms ` +
      `(code=${error.code ?? "unknown"}, signal=${error.signal ?? "none"}, killed=${error.killed ?? false}): ` +
      (error.stderr || error.message), { cause });
  }
}

/** Compile each native evidence/input helper once per isolated E2E phase. */
export async function runWorkspaceSwift(name: "workspace-window-resize" | "workspace-pixels", request: string): Promise<string> {
  let executable = executables.get(name);
  if (!executable) {
    executable = (async () => {
      const path = resolve(process.env.RION_STUDIO_E2E_ARTIFACT_DIR!, name);
      // Cold SDK/module compilation has its own failure bound. Native input and
      // screen observation keep their shorter bound and exact ownership checks.
      await execute(`Compile ${name}`, "/usr/bin/xcrun",
        ["swiftc", resolve(import.meta.dirname, `${name}.swift`), "-o", path], 120_000);
      return path;
    })();
    executables.set(name, executable);
  }
  return execute(`Run ${name}`, await executable, [request], 30_000);
}
