export function assertStableTauriV22PublicReleaseAssets(
  directory: string
): Promise<void>;
export function assertElectronPublicReleaseAssets(directory: string): Promise<void>;
export function identifyPublicReleaseRuntime(directory: string): Promise<"electron-v23" | "tauri-v22">;
