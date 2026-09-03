export interface TauriV22UpdaterInputReceipt {
  schemaVersion: 2;
  evidenceKind: "tauri-v22-published-input";
  runtime: "tauri-v22";
  repository: "rion-tw/rion-studio";
  releaseTag: string;
  releaseVersion: string;
  sourceSha: string;
  targetSha: string;
  updaterPublicKeySha256: string;
  platform: "darwin-aarch64" | "windows-x86_64";
  artifactName: string;
  artifactBytes: number;
  artifactSha256: string;
  signatureName: string;
  signatureSha256: string;
  manifestName: "latest.json";
  manifestSha256: string;
  checksumName: "SHA256SUMS.txt";
  checksumSha256: string;
}

export function verifyTauriV22UpdaterInput(
  argumentsList: readonly string[],
  environment?: NodeJS.ProcessEnv
): Promise<TauriV22UpdaterInputReceipt>;
