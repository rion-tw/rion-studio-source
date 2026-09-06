export type MacWebKitExperimentMode =
  | "system-default"
  | "system-gpu-process"
  | "system-direct"
  | "stp-gpu-process"
  | "stp-direct"
  | "stp-gpu-process-dom-rendering"
  | "stp-gpu-process-all-rendering";

export type MacWebKitExperimentSelection =
  | MacWebKitExperimentMode
  | "matrix";

export const MAC_WEBKIT_EXPERIMENT_MODES: readonly MacWebKitExperimentMode[];

export interface MacWebKitExperimentOptions {
  dataDir: string;
  gameMode: "off" | "on";
  mode: MacWebKitExperimentSelection;
  modes: MacWebKitExperimentMode[];
  stpApp?: string;
  stpFrameworkPath?: string;
  usesStp: boolean;
}

export function parseMacWebKitExperimentArguments(
  args: string[],
  context?: { cwd?: string; platform?: NodeJS.Platform }
): MacWebKitExperimentOptions;

export function macWebKitExperimentEnvironment(
  options: MacWebKitExperimentOptions,
  inherited?: NodeJS.ProcessEnv
): NodeJS.ProcessEnv;

export function macGameModeMetadataEnabled(
  inherited?: NodeJS.ProcessEnv
): boolean;

export function macWebKitExperimentExecutableEnvironment(
  inherited?: NodeJS.ProcessEnv
): NodeJS.ProcessEnv;
