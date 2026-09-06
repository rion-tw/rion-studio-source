import { execFile } from "node:child_process";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
type Execute = (file: string, args: string[], options: {
  timeout: number; maxBuffer: number;
}) => Promise<{ stdout: string }>;
export type NativeFailureSampleResult = "captured" | "unavailable" | "identity-changed" | "unsupported";
export type NativeFailureSampler = (outputPath: string) => Promise<NativeFailureSampleResult>;

/** Read-only failure evidence, confined to the process admitted at test startup. */
export async function prepareNativeFailureSampler(input: {
  platform: NodeJS.Platform; processId: number;
}, execute: Execute = executeFile): Promise<NativeFailureSampler> {
  if (input.platform !== "darwin") return async () => "unsupported";
  if (!Number.isSafeInteger(input.processId) || input.processId <= 1) {
    throw new Error("Native failure sampling requires an admitted process PID.");
  }
  const readIdentity = async () => {
    const { stdout } = await execute("/bin/ps", [
      "-p", String(input.processId), "-o", "ppid=", "-o", "lstart=", "-o", "comm="
    ], { timeout: 5_000, maxBuffer: 16_384 });
    const identity = stdout.trim();
    if (!identity || identity.length > 4096 || identity.includes("\n")) {
      throw new Error("The exact native process identity is unavailable.");
    }
    return identity;
  };
  let identity: string;
  try {
    identity = await readIdentity();
  } catch {
    return async () => "unavailable";
  }
  return async (outputPath) => {
    try {
      if (await readIdentity() !== identity) return "identity-changed";
      // DeadlineBound: one OS stack sample after a failed test; no retries,
      // state reconciliation or product performance monitoring.
      await execute("/usr/bin/sample", [
        String(input.processId), "2", "10", "-file", outputPath
      ], { timeout: 10_000, maxBuffer: 16_384 });
      return "captured";
    } catch {
      // Diagnostic failure must not replace the original test failure.
      return "unavailable";
    }
  };
}

const preparedSamplerKey = Symbol.for("rion.desktop-e2e.native-failure-sampler");
type SamplerRegistry = typeof globalThis & { [preparedSamplerKey]?: NativeFailureSampler };

// WDIO may load hook functions through separate config-module instances.
export function registerNativeFailureSampler(sampler: NativeFailureSampler): void {
  (globalThis as SamplerRegistry)[preparedSamplerKey] = sampler;
}
export function capturePreparedNativeFailureSample(path: string): Promise<NativeFailureSampleResult> {
  return (globalThis as SamplerRegistry)[preparedSamplerKey]?.(path) ?? Promise.resolve("unavailable");
}
