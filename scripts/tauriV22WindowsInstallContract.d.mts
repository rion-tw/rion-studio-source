export interface TauriV22WindowsInstallSnapshot {
  displayIcon: string;
  displayName: string;
  displayVersion: string;
  installLocation: string;
  installRegistryDefault: string;
  installRegistryKey: string;
  mainBinaryName: string;
  mainBinaryPath: string;
  mainBinaryRegular: boolean;
  mainBinaryReparsePoint: boolean;
  publisher: string;
  uninstallRegistryKey: string;
  uninstallerPath: string;
  uninstallerRegular: boolean;
  uninstallerReparsePoint: boolean;
  uninstallString: string;
}

export const TAURI_V22_WINDOWS_INSTALL_REGISTRY_KEY:
  "Software\\rionstudio\\Rion Studio";
export const TAURI_V22_WINDOWS_UNINSTALL_REGISTRY_KEY:
  "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Rion Studio";

export function assertTauriV22WindowsInstallContract(
  snapshot: unknown,
  input: { installDirectory: string; version: string }
): Readonly<TauriV22WindowsInstallSnapshot>;
