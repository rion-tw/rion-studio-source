import { describe, expect, it } from "vitest";

import { releasePlatformBundle } from "../scripts/releaseSigning.mjs";

describe("release platform signing", () => {
  it("fails closed when macOS signing or notarization credentials are incomplete", () => {
    expect(() => releasePlatformBundle("darwin", {})).toThrow(
      "APPLE_SIGNING_IDENTITY is required"
    );
    expect(() => releasePlatformBundle("darwin", {
      APPLE_ID: "release@example.test",
      APPLE_PASSWORD: "secret",
      APPLE_SIGNING_IDENTITY: "-",
      APPLE_TEAM_ID: "TEAM123"
    })).toThrow("must be a Developer ID Application certificate");
  });

  it("configures a Developer ID identity only with notarization credentials", () => {
    expect(releasePlatformBundle("darwin", {
      APPLE_ID: "release@example.test",
      APPLE_PASSWORD: "secret",
      APPLE_SIGNING_IDENTITY: "Developer ID Application: Rion Studio (TEAM123)",
      APPLE_TEAM_ID: "TEAM123"
    })).toEqual({
      macOS: { signingIdentity: "Developer ID Application: Rion Studio (TEAM123)" }
    });
  });

  it("normalizes a Windows signer and requires an HTTPS timestamp service", () => {
    expect(releasePlatformBundle("win32", {
      WINDOWS_CERTIFICATE_THUMBPRINT: "aa aa aa aa aa aa aa aa aa aa aa aa aa aa aa aa aa aa aa aa",
      WINDOWS_TIMESTAMP_URL: "https://timestamp.example.test"
    })).toEqual({
      windows: {
        certificateThumbprint: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        digestAlgorithm: "sha256",
        timestampUrl: "https://timestamp.example.test/"
      }
    });
    expect(() => releasePlatformBundle("win32", {
      WINDOWS_CERTIFICATE_THUMBPRINT: "A".repeat(40),
      WINDOWS_TIMESTAMP_URL: "http://timestamp.example.test"
    })).toThrow("WINDOWS_TIMESTAMP_URL must use HTTPS");
  });
});
