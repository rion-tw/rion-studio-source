import type { PackagedElectronPackageManifestSummary } from
  "./packagedElectronPackageManifest.mjs";

export const PACKAGED_ELECTRON_BLACK_BOX_KIND:
  "rion-packaged-electron-black-box-smoke";
export const PACKAGED_ELECTRON_BLACK_BOX_REPORT_NAME:
  "packaged-black-box-report.json";
export const PACKAGED_ELECTRON_BLACK_BOX_SOURCE_REPORT_NAME:
  "packaged-smoke-report.json";
export const PACKAGED_ELECTRON_BLACK_BOX_SCREENSHOT_NAME:
  "packaged-role-native-host.png";
export const PACKAGED_ELECTRON_BLACK_BOX_FIELDS: readonly [
  "appAsar",
  "appVersion",
  "application",
  "executable",
  "exitCode",
  "fixtureInteraction",
  "gameId",
  "isolationKind",
  "kind",
  "nativeAddon",
  "nativeHostKind",
  "packageManifest",
  "platform",
  "remoteDebugging",
  "roleId",
  "runtimeHomeDirectory",
  "runtimeTarget",
  "schemaVersion",
  "screenshot",
  "userDataDirectory",
  "verdict"
];

export interface PackagedElectronBlackBoxReport {
  readonly appAsar: Readonly<{ path: string; sha256: string }>;
  readonly appVersion: string;
  readonly application: Readonly<{ path: string }>;
  readonly executable: Readonly<{ path: string; sha256: string }>;
  readonly exitCode: 0;
  readonly fixtureInteraction: "visible-os-accessibility-click";
  readonly gameId: string;
  readonly isolationKind:
    | "fixed-macos-home"
    | "temporary-local-windows-user-profile-v1";
  readonly kind: "rion-packaged-electron-black-box-smoke";
  readonly nativeAddon: Readonly<{ path: string; sha256: string }>;
  readonly nativeHostKind: "appkit-chromium" | "bundled-chromium";
  readonly packageManifest: PackagedElectronPackageManifestSummary;
  readonly platform: "darwin" | "win32";
  readonly remoteDebugging: false;
  readonly roleId: string;
  readonly runtimeHomeDirectory: string;
  readonly runtimeTarget:
    | "chromium-v23-macos-appkit"
    | "chromium-v23-windows";
  readonly schemaVersion: 1;
  readonly screenshot: Readonly<{
    byteLength: number;
    path: string;
    sha256: string;
  }>;
  readonly userDataDirectory: string;
  readonly verdict: "passed";
}

export function serializePackagedElectronBlackBoxReport(
  report: PackagedElectronBlackBoxReport
): Buffer;
