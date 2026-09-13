export interface ElectronExtensionCompatibilityBundleVerification {
  readonly mainBytes: number;
  readonly preloadBytes: number;
}

export function verifyElectronExtensionCompatibilityBundle(
  root?: string
): Promise<ElectronExtensionCompatibilityBundleVerification>;
