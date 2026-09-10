export interface MacosGameModeInfo {
  readonly CFBundleDisplayName?: string;
  readonly CFBundleIdentifier?: string;
  readonly CFBundleName?: string;
  readonly LSApplicationCategoryType: string;
  readonly LSSupportsGameMode: boolean;
  readonly [key: string]: unknown;
}

export interface MacosGameModeDevelopmentBundle {
  readonly applicationPath: string;
  readonly cleanup: () => Promise<void>;
  readonly executablePath: string;
  readonly info: MacosGameModeInfo;
  readonly privateRoot: string;
  readonly sourceApplicationPath: string;
}

export const MACOS_GAME_MODE_CATEGORY: "public.app-category.games";
export const MACOS_GAME_MODE_DEVELOPMENT_BUNDLE_ID:
  "com.rionstudio.launcher.dev";
export const MACOS_GAME_MODE_DEVELOPMENT_NAME: "Rion Studio Dev";

export function resolveElectronMacosApplicationPath(
  electronExecutable: string
): string;
export function assertMacosGameModeInfo(
  info: unknown,
  options?: { readonly development?: boolean }
): Readonly<Record<string, string | boolean>>;
export function readMacosApplicationInfo(
  applicationPath: string
): Promise<MacosGameModeInfo>;
export function inspectMacosGameModeExecutable(
  electronExecutable: string,
  options?: { readonly development?: boolean }
): Promise<Readonly<{
  applicationPath: string;
  executablePath: string;
  info: MacosGameModeInfo;
}>>;
export function createMacosGameModeDevelopmentBundle(
  electronExecutable: string
): Promise<MacosGameModeDevelopmentBundle>;
export function removeMacosGameModePrivateRoot(
  privateRoot: string,
  temporaryDirectory: string
): void;
