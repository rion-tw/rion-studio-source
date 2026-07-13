export interface AfterPackContext {
  electronPlatformName: string;
  appOutDir: string;
  packager: {
    appInfo: {
      productFilename: string;
    };
  };
}

export function assertNoBundledPlaywrightBrowsers(
  context: AfterPackContext
): void;

export default assertNoBundledPlaywrightBrowsers;
