export interface VerifyDesktopE2eBuildInput {
  driver: string;
  repositoryRoot: string;
}

export function verifyDesktopE2eBuild(
  input: VerifyDesktopE2eBuildInput
): Promise<void>;
