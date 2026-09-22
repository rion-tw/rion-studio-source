export interface ElectronRuntimeProbe {
  arch: string;
  appKitRuntimeAbi: number;
  chrome: string;
  cdmComponentApi: boolean;
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
export const EXPECTED_ECS_PROTOTYPE_RUNTIME: typeof EXPECTED_ELECTRON_RUNTIME;
export const EXPECTED_APPKIT_RUNTIME_ABI: number;
export const EXPECTED_PACKAGE_ELECTRON_SPEC: string;

export function assertElectronRuntimeProbe(
  probe: ElectronRuntimeProbe,
  packageElectronVersion: string | undefined,
  expectedCoreVersion?: string,
  variant?: "official" | "ecs-prototype"
): void;

export function verifyElectronRuntime(options?: { variant?: "official" | "ecs-prototype" }): Promise<void>;

export function runElectronRuntimeProbe(
  electronExecutable: string,
  probePath: string,
  addonPath: string,
  isolatedUserData: string
): Promise<ElectronRuntimeProbe>;
