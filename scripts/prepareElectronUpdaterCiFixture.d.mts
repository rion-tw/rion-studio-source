export interface ElectronUpdaterCiFixture {
  fixtureRoot: string;
  priorV23Version: string;
  publicKey: string;
  tauriV22Version: string;
  version: string;
}

export function decodeTauriPublicKey(encodedPublicKey: string): string;

export function encodeEphemeralUpdaterCiPassword(entropy: Buffer): string;

export function prepareElectronUpdaterCiFixture(
  environment?: NodeJS.ProcessEnv
): Promise<ElectronUpdaterCiFixture>;
