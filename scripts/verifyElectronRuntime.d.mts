export interface ElectronRuntimeProbe {
  arch: string;
  appKitRuntimeAbi: number;
  chrome: string;
  core: string;
  electron: string;
  modules: string | undefined;
  napi: string | undefined;
  node: string;
  platform: string;
}

export const EXPECTED_ELECTRON_RUNTIME: Readonly<{
  chrome: string;
  electron: string;
  modules: string;
  napi: string;
  node: string;
}>;
export const EXPECTED_APPKIT_RUNTIME_ABI: number;

export function assertElectronRuntimeProbe(
  probe: ElectronRuntimeProbe,
  packageElectronVersion: string | undefined,
  expectedCoreVersion?: string
): void;

export function verifyElectronRuntime(): Promise<void>;
