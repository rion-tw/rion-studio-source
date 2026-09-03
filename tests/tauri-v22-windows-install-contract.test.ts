import { describe, expect, it } from "vitest";

import {
  assertTauriV22WindowsInstallContract,
  TAURI_V22_WINDOWS_INSTALL_REGISTRY_KEY,
  TAURI_V22_WINDOWS_UNINSTALL_REGISTRY_KEY
} from "../scripts/tauriV22WindowsInstallContract.mjs";
import type { TauriV22WindowsInstallSnapshot } from
  "../scripts/tauriV22WindowsInstallContract.mjs";

const INSTALL_DIRECTORY =
  "C:\\Users\\rionci-a1b2c3d4e5\\AppData\\Local\\Rion Studio";
const VERSION = "22.9.0";

describe("published Tauri v22 Windows install contract", () => {
  it("accepts only the exact currentUser registry schema and regular files", () => {
    const snapshot = validSnapshot();
    expect(assertTauriV22WindowsInstallContract(snapshot, {
      installDirectory: INSTALL_DIRECTORY,
      version: VERSION
    })).toEqual(snapshot);
  });

  it.each([
    ["installRegistryKey", "Software\\example\\Rion Studio"],
    ["installRegistryDefault", `${INSTALL_DIRECTORY}\\nested`],
    ["uninstallRegistryKey", `${TAURI_V22_WINDOWS_UNINSTALL_REGISTRY_KEY}-other`],
    ["displayName", "Rion Studio Legacy"],
    ["mainBinaryName", "Rion Studio.exe"],
    ["publisher", "example"],
    ["displayVersion", "22.9.1"],
    ["installLocation", INSTALL_DIRECTORY],
    ["displayIcon", `"${INSTALL_DIRECTORY}\\Rion Studio.exe"`],
    ["uninstallString", `"${INSTALL_DIRECTORY}\\other.exe"`],
    ["mainBinaryPath", `${INSTALL_DIRECTORY}\\other.exe`],
    ["uninstallerPath", `${INSTALL_DIRECTORY}\\other.exe`],
    ["mainBinaryRegular", false],
    ["uninstallerRegular", false],
    ["mainBinaryReparsePoint", true],
    ["uninstallerReparsePoint", true]
  ] as const)("fails closed when %s does not match", (key, value) => {
    expect(() => assertTauriV22WindowsInstallContract({
      ...validSnapshot(),
      [key]: value
    }, {
      installDirectory: INSTALL_DIRECTORY,
      version: VERSION
    })).toThrow(key);
  });

  it("rejects unknown snapshot fields and non-canonical expectations", () => {
    expect(() => assertTauriV22WindowsInstallContract({
      ...validSnapshot(),
      unexpected: true
    }, {
      installDirectory: INSTALL_DIRECTORY,
      version: VERSION
    })).toThrow("unexpected schema");
    expect(() => assertTauriV22WindowsInstallContract(validSnapshot(), {
      installDirectory: "C:\\Users\\rionci\\..\\Rion Studio",
      version: VERSION
    })).toThrow("canonical non-root");
    expect(() => assertTauriV22WindowsInstallContract(validSnapshot(), {
      installDirectory: INSTALL_DIRECTORY,
      version: "22.09.0"
    })).toThrow("strict SemVer");
  });
});

function validSnapshot(): TauriV22WindowsInstallSnapshot {
  const mainBinaryPath = `${INSTALL_DIRECTORY}\\rion-tauri.exe`;
  const uninstallerPath = `${INSTALL_DIRECTORY}\\uninstall.exe`;
  return {
    displayIcon: `"${mainBinaryPath}"`,
    displayName: "Rion Studio",
    displayVersion: VERSION,
    installLocation: `"${INSTALL_DIRECTORY}"`,
    installRegistryDefault: INSTALL_DIRECTORY,
    installRegistryKey: TAURI_V22_WINDOWS_INSTALL_REGISTRY_KEY,
    mainBinaryName: "rion-tauri.exe",
    mainBinaryPath,
    mainBinaryRegular: true,
    mainBinaryReparsePoint: false,
    publisher: "rionstudio",
    uninstallRegistryKey: TAURI_V22_WINDOWS_UNINSTALL_REGISTRY_KEY,
    uninstallerPath,
    uninstallerRegular: true,
    uninstallerReparsePoint: false,
    uninstallString: `"${uninstallerPath}"`
  };
}
