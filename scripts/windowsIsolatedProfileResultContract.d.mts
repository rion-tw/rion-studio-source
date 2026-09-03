export const WINDOWS_ISOLATED_PROFILE_RESULT_KIND:
  "rion-windows-isolated-profile-result";
export const WINDOWS_ISOLATED_PROFILE_RESULT_NAME:
  "windows-isolated-profile-result.json";
export const WINDOWS_ISOLATED_PROFILE_KIND:
  "temporary-local-windows-user-profile-v1";
export const WINDOWS_ISOLATED_PROFILE_COMMAND_INVOCATION_KIND:
  "rion-windows-isolated-command-invocation-v1";

export interface WindowsIsolatedProfileArtifactIdentity {
  readonly bytes: number;
  readonly fileName: string;
  readonly sha256: string;
}

export interface WindowsIsolatedProfileResult {
  readonly activeProcessesAfterRootExit: 0;
  readonly attemptNonce: string;
  readonly attestedInputs: {
    readonly commandExecutable: WindowsIsolatedProfileArtifactIdentity;
    readonly commandHarness: WindowsIsolatedProfileArtifactIdentity;
    readonly forbiddenSourceList: WindowsIsolatedProfileArtifactIdentity;
    readonly installer: WindowsIsolatedProfileArtifactIdentity;
  };
  readonly cleanupVerified: true;
  readonly commandExitCode: 0;
  readonly commandInvocationSha256: string;
  readonly expectedTotalProcesses: number;
  readonly isolationKind: "temporary-local-windows-user-profile-v1";
  readonly kind: "rion-windows-isolated-profile-result";
  readonly schemaVersion: 1;
  readonly totalProcesses: number;
}

export function assertWindowsIsolatedProfileResult(
  value: unknown
): WindowsIsolatedProfileResult;
export function createWindowsIsolatedProfileCommandInvocationSha256(input: {
  arguments: readonly string[];
  commandPath: string;
  workingDirectory: string;
}): string;
export function serializeWindowsIsolatedProfileResult(
  value: WindowsIsolatedProfileResult
): Buffer;
