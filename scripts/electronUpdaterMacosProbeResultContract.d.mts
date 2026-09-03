export const ELECTRON_UPDATER_MACOS_BUNDLE_PROBE_RESULT_NAME:
  "macos-bundle-replacement-result.json";

export interface ElectronUpdaterMacosVersionTransition {
  readonly sourceVersion: string;
  readonly targetVersion: string;
}

export interface ElectronUpdaterMacosBundleCase
  extends ElectronUpdaterMacosVersionTransition {
  readonly outcome: "applied";
  readonly probe: "macos-bundle-replacement";
  readonly sourceRuntime: "electron-v23";
}

export function assertElectronUpdaterMacosBundleCase(
  value: unknown,
  label: string
): Readonly<ElectronUpdaterMacosBundleCase>;

export function assertElectronUpdaterMacosVersionTransition(
  value: unknown,
  label: string
): Readonly<ElectronUpdaterMacosVersionTransition>;

export function readElectronUpdaterMacosBundleProbeResult(
  input: Readonly<{
    fixtureRoot: string;
    resultPath: string;
  }>
): Promise<Readonly<{
  cases: readonly Readonly<ElectronUpdaterMacosBundleCase>[];
  identity: Readonly<{ bytes: number; sha256: string }>;
}>>;
