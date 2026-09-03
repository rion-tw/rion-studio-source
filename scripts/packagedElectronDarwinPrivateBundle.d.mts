export interface DarwinPrivatePackagedElectronBundle {
  readonly applicationPath: string;
  readonly exclusiveBundleRoot: string;
  readonly privateRoot: string;
  readonly sourceApplicationPath: string;
  cleanup(): Promise<void>;
}

export function createDarwinPrivatePackagedElectronBundle(
  sourceApplicationPath: string
): Promise<DarwinPrivatePackagedElectronBundle>;

export function requireDarwinPrivatePackagedElectronBundle(
  value: unknown
): DarwinPrivatePackagedElectronBundle;
