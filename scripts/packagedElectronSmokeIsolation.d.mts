export interface PackagedElectronSmokeIsolation {
  environment: Readonly<Record<string, string>>;
  isolationKind?: "temporary-local-windows-user-profile-v1";
  runtimeHomeDirectory: string;
  userDataDirectory: string;
}

export function resolvePackagedElectronSmokeIsolation(
  artifactDirectory: string,
  platform: "darwin" | "win32",
  environment?: NodeJS.ProcessEnv
): PackagedElectronSmokeIsolation;
