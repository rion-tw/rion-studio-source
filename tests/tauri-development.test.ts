import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("Tauri development and release commands", () => {
  it("uses an attested Tauri dev launcher with an explicit degraded mode", async () => {
    const [packageSource, launcher] = await Promise.all([
      readFile("package.json", "utf8"),
      readFile("scripts/devTauri.mjs", "utf8")
    ]);
    const packageJson = JSON.parse(packageSource) as { scripts: Record<string, string> };

    expect(packageJson.scripts.dev).toBe("node scripts/devTauri.mjs");
    expect(packageJson.scripts["dev:degraded"]).toBe("node scripts/devTauri.mjs --degraded");
    expect(launcher).toContain("environmentWithCargoExecutable");
    expect(launcher).toContain("target\", \"rion-attestation");
    expect(launcher).toContain("attestationFingerprint(attestationVersion)");
    expect(launcher).toContain("readAttestation(attestationPath");
    expect(launcher).toContain('platform === "darwin" ? osVersion.split(".")[0] : osVersion');
    expect(launcher).toContain('RION_STUDIO_MACOS_INPUT_ATTESTED_MAJOR = osVersion.split(".")[0]');
    expect(launcher).toContain('RION_STUDIO_WINDOWS_INPUT_ATTESTED = "1"');
    expect(launcher).toContain('["run", "test:native:system-input"]');
    expect(launcher).toContain('["exec", "tauri", "dev"]');
  });

  it("uses semantic release version synchronization for every public version source", async () => {
    const script = await readFile("scripts/applyReleaseVersion.mjs", "utf8");
    expect(script).toContain('updateJson("package.json"');
    expect(script).toContain('updateJson("src-tauri/tauri.conf.json"');
    expect(script).toContain("[workspace\\.package\\]");
    expect(script).toContain('["rion-core", "rion-platform", "rion-tauri"]');
    expect(script).toContain('await write("Cargo.lock", cargoLock)');
  });

  it("keeps canonical build, package, and updater-signed distribution entry points", async () => {
    const [packageSource, packageLauncher] = await Promise.all([
      readFile("package.json", "utf8"),
      readFile("scripts/packageTauri.mjs", "utf8")
    ]);
    const packageJson = JSON.parse(packageSource) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts.build).toContain("cargo build -p rion-tauri");
    expect(packageJson.scripts.package).toBe("node scripts/packageTauri.mjs");
    expect(packageLauncher).toContain('"verify:system-only"');
    expect(packageLauncher).toContain('"test:native:system-input"');
    expect(packageLauncher).toContain('"test:native:runtime-restore"');
    expect(packageLauncher).toContain('"test:native:file-operations"');
    expect(packageLauncher).toContain('"--require-compiled-attestation"');
    expect(packageLauncher).toContain("createUpdaterArtifacts: false");
    expect(packageLauncher).toContain('signingIdentity: "-"');
    expect(packageLauncher).toContain('if (args[0] === "--") args.shift()');
    expect(packageJson.scripts.dist).toBe("node scripts/buildTauriRelease.mjs");
    const releaseLauncher = await readFile("scripts/buildTauriRelease.mjs", "utf8");
    expect(releaseLauncher).toContain(
      'if (forwardedArguments[0] === "--") forwardedArguments.shift()'
    );
    expect(releaseLauncher).toContain('signingIdentity: "-"');
    expect(releaseLauncher).not.toContain("verifyWindowsCertificatePublisher");
    expect(releaseLauncher).not.toContain("certificateThumbprint");
    expect(packageJson.scripts).not.toHaveProperty("dev:tauri");
    expect(packageJson.scripts).not.toHaveProperty("build:tauri");
  });
});
