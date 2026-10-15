import { execFile } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const nativeFocusScript = fileURLToPath(new URL("./macos-native-focus.swift", import.meta.url));
const executables = new Map<string, Promise<string>>();

export function boundedNativeProcessFailure(error: unknown): string {
  if (typeof error !== "object" || error === null) return "unknown failure";
  const failure = error as Readonly<{
    code?: unknown; killed?: unknown; signal?: unknown; stderr?: unknown; stdout?: unknown;
  }>;
  const fields = [
    `code=${String(failure.code ?? "unknown")}`,
    `killed=${String(failure.killed ?? false)}`,
    `signal=${String(failure.signal ?? "none")}`
  ];
  const output = [failure.stderr, failure.stdout]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n").trim();
  if (output.length > 0) fields.push(`output=${JSON.stringify(output.slice(-2_000))}`);
  return fields.join(", ");
}

async function execute(stage: string, file: string, args: readonly string[], timeout: number): Promise<void> {
  const started = Date.now();
  try {
    await executeFile(file, args, { encoding: "utf8", timeout });
  } catch (cause) {
    throw new Error(`${stage} failed after ${Date.now() - started}ms ` +
      `(${boundedNativeProcessFailure(cause)})`, { cause });
  }
}

/** Compile before a journey captures its native input eligibility; this submits no input. */
export async function prepareMacosNativeFocus(): Promise<string> {
  const artifactDirectory = process.env.RION_STUDIO_E2E_ARTIFACT_DIR;
  if (!artifactDirectory || !isAbsolute(artifactDirectory)) {
    throw new Error("The compiled macOS focus helper requires its absolute phase artifact directory");
  }
  const path = resolve(artifactDirectory, "macos-native-focus");
  let executable = executables.get(path);
  if (!executable) {
    executable = (async () => {
      // Match the existing Workspace helper's separate cold SDK compilation bound.
      // A failed promise remains authoritative for this isolated phase; no retry.
      await execute("Compile macos-native-focus", "/usr/bin/xcrun",
        ["swiftc", nativeFocusScript, "-o", path], 120_000);
      return path;
    })();
    executables.set(path, executable);
  }
  return executable;
}

/** Separate cold compilation from each exact, single-invocation native action. */
export async function runMacosNativeFocus(
  args: readonly [string, string, string, "focus" | "observe" | "shortcut" | "roleKey", string],
  timeout: 15_000 | 30_000
): Promise<void> {
  await execute(`Run macos-native-focus ${args[3]}`, await prepareMacosNativeFocus(), args, timeout);
}
