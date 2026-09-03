export interface ElectronProductionCandidateVerification {
  assets: Readonly<Record<string, Readonly<{ bytes: number; sha256: string }>>>;
  receipt: Readonly<Record<string, unknown>>;
  receiptSha256: string;
  sourceSha: string;
  updaterBaseUrl: string;
  updaterEndpoint: string;
  version: string;
}

export function verifyElectronProductionCandidateBundle(input: Readonly<{
  candidateDirectory: string;
  candidateReceiptPath: string;
  candidateReceiptSha256: string;
  macDirectory: string;
  publicKey: string;
  sourceSha: string;
  version: string;
  windowsDirectory: string;
}>): Promise<ElectronProductionCandidateVerification>;
