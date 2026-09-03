export interface DesktopE2eRuntimeTargetManifest {
  profiles?: Record<string, { runtimeTarget?: string }>;
  runtimeTargets?: Record<string, {
    driver?: string;
    platforms?: string[];
  }>;
}

export interface DesktopE2eRuntimeTargetPlan {
  applicationPath: string;
  architecture: string;
  buildScriptPath: string;
  driver: "electron" | "tauri";
  platform: "macos" | "windows";
  runtimeTargetName: string;
  wdioConfigPath: string;
}

export function resolveDesktopE2eRuntimeTarget(input: {
  architecture: string;
  manifest: DesktopE2eRuntimeTargetManifest;
  platform: NodeJS.Platform;
  profileName: string;
  repositoryRoot: string;
}): DesktopE2eRuntimeTargetPlan;
