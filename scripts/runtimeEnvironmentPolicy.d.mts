export function isUpdaterPrivateEnvironmentName(name: string): boolean;

export function sanitizeUpdaterRuntimeEnvironment(
  environment: NodeJS.ProcessEnv
): NodeJS.ProcessEnv;

export function createUpdaterProbeRuntimeEnvironment(
  environment: NodeJS.ProcessEnv,
  overrides?: NodeJS.ProcessEnv
): NodeJS.ProcessEnv;

export function createPackagedElectronRuntimeEnvironment(
  environment: NodeJS.ProcessEnv,
  overrides?: NodeJS.ProcessEnv
): NodeJS.ProcessEnv;
