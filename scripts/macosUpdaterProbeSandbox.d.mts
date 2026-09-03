export interface MacosUpdaterProbeSandboxInput {
  cargoTargetDirectory: string;
  runtimeHome: string;
  runtimeRoot: string;
  runtimeTemp: string;
}

export function createMacosUpdaterProbeSandboxProfile(
  input: MacosUpdaterProbeSandboxInput
): Promise<string>;
