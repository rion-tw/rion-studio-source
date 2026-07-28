import type { ChildProcess, SpawnOptions } from "node:child_process";

export interface PlatformCommandOptions {
  environment?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
}

export interface PlatformCommandInvocation {
  args: string[];
  executable: string;
  windowsVerbatimArguments?: false;
}

export function platformCommandInvocation(
  executable: string,
  args: string[],
  options?: PlatformCommandOptions
): PlatformCommandInvocation;

export function spawnPlatformCommand(
  executable: string,
  args: readonly string[],
  options?: SpawnOptions
): ChildProcess;
