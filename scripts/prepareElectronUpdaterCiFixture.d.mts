export interface ElectronUpdaterCiFixture {
  fixtureRoot: string;
  publicKey: string;
  version: string;
}

export function decodeTauriPublicKey(encodedPublicKey: string): string;

export function prepareElectronUpdaterCiFixture(
  environment?: NodeJS.ProcessEnv
): Promise<ElectronUpdaterCiFixture>;
