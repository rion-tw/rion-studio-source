export function electronReleaseInputs(input: {
  platform: string;
  environment: NodeJS.ProcessEnv;
  version: string;
}): {
  artifactName: "Rion.Studio-mac.app.tar.gz" | "Rion.Studio-win.exe";
  endpoint: string;
  version: string;
};

export function buildElectronRelease(input?: {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
}): Promise<void>;
