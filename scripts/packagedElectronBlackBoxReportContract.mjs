export const PACKAGED_ELECTRON_BLACK_BOX_KIND =
  "rion-packaged-electron-black-box-smoke";
export const PACKAGED_ELECTRON_BLACK_BOX_REPORT_NAME =
  "packaged-black-box-report.json";
export const PACKAGED_ELECTRON_BLACK_BOX_SOURCE_REPORT_NAME =
  "packaged-smoke-report.json";
export const PACKAGED_ELECTRON_BLACK_BOX_SCREENSHOT_NAME =
  "packaged-role-native-host.png";

export const PACKAGED_ELECTRON_BLACK_BOX_FIELDS = Object.freeze([
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
]);

export function serializePackagedElectronBlackBoxReport(report) {
  const canonical = {
    schemaVersion: report.schemaVersion,
    kind: report.kind,
    verdict: report.verdict,
    appVersion: report.appVersion,
    application: { path: report.application?.path },
    executable: {
      path: report.executable?.path,
      sha256: report.executable?.sha256
    },
    appAsar: {
      path: report.appAsar?.path,
      sha256: report.appAsar?.sha256
    },
    nativeAddon: {
      path: report.nativeAddon?.path,
      sha256: report.nativeAddon?.sha256
    },
    exitCode: report.exitCode,
    fixtureInteraction: report.fixtureInteraction,
    gameId: report.gameId,
    isolationKind: report.isolationKind,
    nativeHostKind: report.nativeHostKind,
    packageManifest: {
      directoryCount: report.packageManifest?.directoryCount,
      entryCount: report.packageManifest?.entryCount,
      regularFileBytes: report.packageManifest?.regularFileBytes,
      regularFileCount: report.packageManifest?.regularFileCount,
      schemaVersion: report.packageManifest?.schemaVersion,
      sha256: report.packageManifest?.sha256,
      symlinkCount: report.packageManifest?.symlinkCount
    },
    platform: report.platform,
    remoteDebugging: report.remoteDebugging,
    roleId: report.roleId,
    runtimeHomeDirectory: report.runtimeHomeDirectory,
    runtimeTarget: report.runtimeTarget,
    screenshot: {
      byteLength: report.screenshot?.byteLength,
      path: report.screenshot?.path,
      sha256: report.screenshot?.sha256
    },
    userDataDirectory: report.userDataDirectory
  };
  return Buffer.from(`${JSON.stringify(canonical, null, 2)}\n`, "utf8");
}
