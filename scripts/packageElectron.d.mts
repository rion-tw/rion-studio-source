export function electronPackageScript(platform: string): "package:electron:mac" | "package:electron:win";
export function packageElectron(input?: {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
}): Promise<void>;
