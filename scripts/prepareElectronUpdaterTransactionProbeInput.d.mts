import type { ElectronUpdaterPreparedProbeInput } from
  "./electronUpdaterPreparedProbeInput.mjs";

export function prepareElectronUpdaterTransactionProbeInput(
  argumentsList: string[],
  environment?: NodeJS.ProcessEnv,
  runtime?: Readonly<{
    arch: "arm64" | "x64";
    platform: "darwin" | "win32";
  }>
): Promise<ElectronUpdaterPreparedProbeInput>;
