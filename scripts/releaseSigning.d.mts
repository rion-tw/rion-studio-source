export function releasePlatformBundle(
  platform: string,
  environment: Record<string, string | undefined>
): {
  macOS?: { signingIdentity: string };
  windows?: {
    certificateThumbprint: string;
    digestAlgorithm: "sha256";
    timestampUrl: string;
  };
};
