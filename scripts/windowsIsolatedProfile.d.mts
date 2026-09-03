export interface WindowsProfileIsolation {
  readonly kind: "temporary-local-windows-user-profile-v1";
  readonly localAppDataDirectory: string;
  readonly profileDirectory: string;
  readonly roamingAppDataDirectory: string;
  readonly sid: string;
  readonly userDataDirectory: string;
  readonly userProgramFilesDirectory: string;
}

export function resolveVerifiedWindowsProfileIsolation(
  environment: NodeJS.ProcessEnv
): WindowsProfileIsolation;
