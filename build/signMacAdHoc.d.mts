import type { SignOptions } from "@electron/osx-sign";

export default function signMacAdHoc(
  configuration: SignOptions
): Promise<void>;
