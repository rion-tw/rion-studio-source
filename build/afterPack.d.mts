import type { SignOptions } from "@electron/osx-sign";

export interface AfterPackContext {
  electronPlatformName: string;
  appOutDir: string;
  packager: {
    appInfo: {
      productFilename: string;
    };
  };
}

export type MacAppSigner = (options: SignOptions) => Promise<void>;

export function assertNoBundledPlaywrightBrowsers(
  context: AfterPackContext
): void;

export function signMacApp(
  context: AfterPackContext,
  signer?: MacAppSigner
): Promise<void>;

export default signMacApp;
