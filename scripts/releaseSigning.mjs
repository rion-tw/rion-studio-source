export function releasePlatformBundle(platform, environment) {
  const requireEnvironment = (name) => {
    const value = environment[name]?.trim();
    if (!value) throw new Error(`${name} is required for signed release artifacts.`);
    return value;
  };

  if (platform === "darwin") {
    const signingIdentity = requireEnvironment("APPLE_SIGNING_IDENTITY");
    requireEnvironment("APPLE_ID");
    requireEnvironment("APPLE_PASSWORD");
    requireEnvironment("APPLE_TEAM_ID");
    if (!signingIdentity.startsWith("Developer ID Application:")) {
      throw new Error("APPLE_SIGNING_IDENTITY must be a Developer ID Application certificate.");
    }
    return { macOS: { signingIdentity } };
  }

  if (platform === "win32") {
    const certificateThumbprint = requireEnvironment("WINDOWS_CERTIFICATE_THUMBPRINT")
      .replaceAll(" ", "")
      .toUpperCase();
    if (!/^[0-9A-F]{40}$/.test(certificateThumbprint)) {
      throw new Error("WINDOWS_CERTIFICATE_THUMBPRINT must be a SHA-1 certificate thumbprint.");
    }
    const timestampUrl = new URL(requireEnvironment("WINDOWS_TIMESTAMP_URL"));
    if (timestampUrl.protocol !== "https:") {
      throw new Error("WINDOWS_TIMESTAMP_URL must use HTTPS.");
    }
    return {
      windows: {
        certificateThumbprint,
        digestAlgorithm: "sha256",
        timestampUrl: timestampUrl.href
      }
    };
  }

  throw new Error("Tauri releases are supported only on macOS and Windows builders.");
}
