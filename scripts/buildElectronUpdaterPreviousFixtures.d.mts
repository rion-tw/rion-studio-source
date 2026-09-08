export function buildElectronUpdaterPreviousFixtures(
  environment?: NodeJS.ProcessEnv,
  dependencies?: Readonly<{
    platform?: NodeJS.Platform;
    executeFile?: (executable: string, argumentsList: string[], options: Readonly<{
      cwd: string;
      env: NodeJS.ProcessEnv;
      maxBuffer: number;
      windowsHide: boolean;
    }>) => Promise<unknown>;
  }>
): Promise<Record<string, string>>;
