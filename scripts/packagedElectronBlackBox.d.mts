export type PackagedElectronPlatform = "darwin" | "win32";

export interface PackagedElectronRoleIdentity {
  readonly appVersion: string;
  readonly gameId: string;
  readonly roleId: string;
}

export interface PackagedPngArtifact {
  readonly byteLength: number;
  readonly path: string;
  readonly sha256: string;
}

export const MACOS_ACCESSIBILITY_TRAVERSAL_HANDLERS: string;
export const MACOS_RETAINED_APPKIT_HANDLERS: string;

export function seedPackagedElectronRole(input: {
  gameName: string;
  launchUrl: string;
  platform: PackagedElectronPlatform;
  resourcesPath: string;
  roleName: string;
  userDataDirectory: string;
}): Promise<PackagedElectronRoleIdentity>;

export function runPackagedCoreOperation<Result>(
  core: {
    shutdown(): Promise<void>;
  },
  operation: () => Promise<Result>
): Promise<Result>;

export function launchRoleThroughNativeInput(input: {
  platform: PackagedElectronPlatform;
  processId: number;
  roleName: string;
}): Promise<void>;

export function pressPackagedRoleContent(input: {
  buttonName: string;
  platform: PackagedElectronPlatform;
  processId: number;
  roleName: string;
}): Promise<"appkit-chromium" | "bundled-chromium">;

export function closePackagedRoleWindow(input: {
  buttonName: string;
  platform: PackagedElectronPlatform;
  processId: number;
  roleName: string;
}): Promise<void>;

export function quitPackagedApplication(input: {
  platform: PackagedElectronPlatform;
  processId: number;
}): Promise<void>;

export function capturePackagedScreen(input: {
  buttonName: string;
  outputPath: string;
  platform: PackagedElectronPlatform;
  processId: number;
  roleName: string;
}): Promise<PackagedPngArtifact>;

export function parsePackagedScreenRectangle(value: string): string;

export function validatePackagedPngArtifact(
  outputPath: string
): Promise<PackagedPngArtifact>;
