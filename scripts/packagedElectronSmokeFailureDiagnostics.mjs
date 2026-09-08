import { lstat, open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { summarizeNativeProbeError } from "./nativeProbeFailureDiagnostics.mjs";
import { packagedSmokeFailure } from "./packagedElectronProcessCleanup.mjs";

export async function throwPackagedSmokeFailureWithDiagnostics(input) {
  const cleanupErrors = [...input.cleanupErrors];
  try {
    if (!isAbsolute(input.artifactDirectory)) {
      throw new Error("Packaged failure diagnostics require an absolute artifact directory.");
    }
    const parent = await lstat(input.artifactDirectory);
    if (!parent.isDirectory() || parent.isSymbolicLink()) {
      throw new Error("Packaged failure diagnostics require a real artifact directory.");
    }
    const observation = {
      kind: "packaged-electron-smoke-failure-diagnostics",
      authoritative: false,
      productionTerminalReceipt: false,
      verdict: "failed",
      platform: input.platform,
      stage: input.stage,
      processId: input.processId ?? null,
      packageHashes: input.packageHashes,
      completedAt: new Date().toISOString(),
      error: summarizeNativeProbeError(
        packagedSmokeFailure(input.error, cleanupErrors), input.privateValues ?? []
      )
    };
    const file = await open(join(input.artifactDirectory, "packaged-smoke-failure.json"), "wx", 0o600);
    const writeErrors = [];
    try {
      await file.writeFile(JSON.stringify(observation, null, 2) + "\n");
      await file.sync();
    } catch (error) {
      writeErrors.push(error);
    }
    try {
      await file.close();
    } catch (error) {
      writeErrors.push(error);
    }
    if (writeErrors.length === 1) throw writeErrors[0];
    if (writeErrors.length > 1) throw new AggregateError(writeErrors, "Packaged diagnostic write/close failed.");
  } catch (error) {
    cleanupErrors.push(new Error("Packaged smoke failure evidence could not be persisted.", { cause: error }));
  }
  throw packagedSmokeFailure(input.error, cleanupErrors);
}
