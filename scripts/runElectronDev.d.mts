import type { ChildProcess } from "node:child_process";

import type { MacosGameModeDevelopmentBundle } from
  "./electronMacosGameModeBundle.mjs";

export interface ElectronDevLaunchSpec {
  readonly args: readonly string[];
  readonly command: string;
  readonly environment: NodeJS.ProcessEnv;
}

export function electronDevLaunchSpec(input: {
  readonly arguments?: readonly string[];
  readonly electronExecutable?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}): ElectronDevLaunchSpec;

export function runElectronDev(
  forwardedArguments?: readonly string[],
  dependencies?: {
    readonly environment?: NodeJS.ProcessEnv;
    readonly platform?: NodeJS.Platform;
    readonly prepareBundle?: (
      electronExecutable: string
    ) => Promise<MacosGameModeDevelopmentBundle>;
    readonly resolveElectronExecutable?: () => string;
    readonly signalEmitter?: Pick<NodeJS.Process, "off" | "on">;
    readonly spawnCommand?: (
      command: string,
      args: readonly string[],
      options: object
    ) => ChildProcess;
  }
): Promise<number>;
