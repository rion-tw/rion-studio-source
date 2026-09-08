import { describe, expect, it } from "vitest";

import { electronReleaseInputs } from "../scripts/buildElectronRelease.mjs";

const environment = {
  RION_STUDIO_UPDATER_PUBLIC_KEY: "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3",
  TAURI_SIGNING_PRIVATE_KEY: "test-only-placeholder-not-a-private-key",
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "test-only-password"
};

describe("sole Electron release configuration", () => {
  it.each([
    ["darwin", "Rion.Studio-mac.app.tar.gz"],
    ["win32", "Rion.Studio-win.exe"]
  ])("reuses the published endpoint and asset contract on %s", (platform, artifactName) => {
    expect(electronReleaseInputs({ platform, environment, version: "8.5.0" })).toEqual({
      artifactName,
      endpoint: "https://github.com/rion-tw/rion-studio/releases/latest/download/latest.json",
      version: "8.5.0"
    });
  });

  it.each(["darwin", "win32"])("rejects invalid configuration before packaging on %s", (platform) => {
    for (const version of ["01.2.3", "1.2.3-01", "1.2.3-.", "latest", "1.2"]) {
      expect(() => electronReleaseInputs({ platform, environment, version }))
        .toThrow("semantic version");
    }
    for (const endpoint of [
      "http://updates.example/latest.json",
      "https://user:password@updates.example/latest.json",
      "https://updates.example/latest.json?token=test",
      "https://updates.example/latest.json#ignored"
    ]) {
      expect(() => electronReleaseInputs({
        platform,
        version: "8.5.0",
        environment: { ...environment, RION_STUDIO_UPDATER_ENDPOINT: endpoint }
      })).toThrow("updater endpoint");
    }
    for (const name of Object.keys(environment)) {
      expect(() => electronReleaseInputs({
        platform,
        version: "8.5.0",
        environment: { ...environment, [name]: "" }
      })).toThrow(`${name} is required`);
    }
  });
});
