export function assertMacosChromiumAddonLinkage(output: string): void;
export function assertMacosChromiumAddonLoadCommands(output: string): void;
export function assertMacosChromiumAddonArchitectures(output: string): void;
export function assertMacosAdHocSignature(
  output: string,
  expectedIdentifier?: string
): void;
export function assertMacosAdHocBundleSignatureRelationship(details: Readonly<{
  addon: string;
  application: string;
  framework: string;
}>): void;
export function verifyMacosChromiumAddonLinkage(addonPath: string): Promise<void>;
export function verifyMacosAdHocBundleSignature(
  applicationPath: string,
  frameworkPath: string,
  addonPath: string
): Promise<void>;
