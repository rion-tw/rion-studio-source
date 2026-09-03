import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  macDevBundleLaunchArguments,
  macDevBundleRoot
} from "../scripts/runMacDevBundle.mjs";

const execFileAsync = promisify(execFile);

describe("Tauri development and release commands", () => {
  it("starts Tauri development directly without retired compatibility or attestation gates", async () => {
    const [
      packageSource,
      launcher,
      macRunner,
      macPlistSource,
      productionMacPlist,
      tauriSource,
      viteSource
    ] = await Promise.all([
      readFile("package.json", "utf8"),
      readFile("scripts/devTauri.mjs", "utf8"),
      readFile("scripts/runMacDevBundle.mjs", "utf8"),
      readFile("scripts/macDevBundleInfoPlist.mjs", "utf8"),
      readFile("src-tauri/Info.plist", "utf8"),
      readFile("src-tauri/tauri.conf.json", "utf8"),
      readFile("vite.tauri.config.ts", "utf8")
    ]);
    const packageJson = JSON.parse(packageSource) as { scripts: Record<string, string> };
    const tauriConfig = JSON.parse(tauriSource) as {
      build: { devUrl: string };
      app: { security: { csp: string; devCsp: string } };
    };

    expect(packageJson.scripts.dev).toBe("node scripts/devTauri.mjs");
    expect(packageJson.scripts).not.toHaveProperty("dev:degraded");
    expect(tauriConfig.build.devUrl).toBe("http://127.0.0.1:5173");
    expect(tauriConfig.app.security.csp).toContain("script-src 'self';");
    expect(tauriConfig.app.security.csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(tauriConfig.app.security.csp).not.toContain("ws://127.0.0.1:5173");
    expect(tauriConfig.app.security.csp).toContain("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;");
    expect(tauriConfig.app.security.csp).toContain("font-src 'self' https://fonts.gstatic.com;");
    expect(tauriConfig.app.security.csp).toContain("connect-src ipc: http://ipc.localhost");
    expect(tauriConfig.app.security.devCsp).toContain("https://fonts.googleapis.com");
    expect(tauriConfig.app.security.devCsp).toContain("https://fonts.gstatic.com");
    expect(tauriConfig.app.security.devCsp).toContain("script-src 'self' 'unsafe-inline'");
    expect(tauriConfig.app.security.devCsp).toContain("ws://127.0.0.1:5173");
    expect(viteSource).toContain('host: "127.0.0.1"');
    expect(viteSource).toContain("rolldownOptions");
    expect(viteSource).toContain("codeSplitting");
    expect(viteSource).toContain("/node_modules/");
    expect(viteSource).toContain('name: "vendor"');
    expect(viteSource).toContain("import.meta.dirname");
    expect(viteSource).not.toContain("__dirname");
    expect(viteSource).not.toContain("manualChunks");
    expect(launcher).toContain("environmentWithCargoExecutable");
    expect(launcher).toContain("assertDevRendererPortAvailable");
    expect(launcher.indexOf("await assertDevRendererPortAvailable()"))
      .toBeLessThan(launcher.indexOf("await environmentWithCargoExecutable()"));
    expect(launcher).toContain("configureMacOsDevBundleRunner(environment)");
    expect(launcher).toContain("CARGO_TARGET_${architecture}_APPLE_DARWIN_RUNNER");
    expect(macRunner).toContain('"Rion Studio Dev.app"');
    expect(macPlistSource).toContain("com.rionstudio.launcher");
    expect(macPlistSource).toContain("NSAllowsLocalNetworking");
    expect(macRunner).not.toContain("process.execve(");
    expect(macRunner).toContain('"/usr/bin/open"');
    expect(macRunner).toContain('execute("/usr/bin/codesign"');
    expect(macRunner).toContain("macWebKitExperimentExecutableEnvironment()");
    expect(macRunner).toContain("macGameModeMetadataEnabled()");
    expect(productionMacPlist).toContain("<key>LSSupportsGameMode</key>");
    expect(productionMacPlist).toContain("<string>public.app-category.games</string>");
    expect(productionMacPlist).toContain("<true/>");
    expect(launcher).toContain('["exec", "tauri", "dev"]');
    expect(launcher).not.toContain("test:native:system-input");
    expect(launcher).not.toContain("rion-attestation");
    expect(launcher).not.toContain("INPUT_ATTESTED");
  });

  it("launches the macOS development bundle as a fresh LaunchServices application", () => {
    expect(macDevBundleRoot("/Users/developer")).toBe(join(
      "/Users/developer",
      "Applications",
      "Rion Studio Development",
      "Rion Studio Dev.app"
    ));
    expect(macDevBundleLaunchArguments(
      "/tmp/Rion Studio Dev.app",
      ["--example", "argument with spaces"]
    )).toEqual([
      "-n",
      "-W",
      "-F",
      "/tmp/Rion Studio Dev.app",
      "--args",
      "--example",
      "argument with spaces"
    ]);
    expect(macDevBundleLaunchArguments("/tmp/Rion Studio Dev.app")).toEqual([
      "-n",
      "-W",
      "-F",
      "/tmp/Rion Studio Dev.app"
    ]);
  });

  it("uses semantic release version synchronization for every public version source", async () => {
    const script = await readFile("scripts/applyReleaseVersion.mjs", "utf8");
    expect(script).toContain('if (args[0] === "--") args.shift()');
    expect(script).toContain("unexpectedArgs.length > 0");
    expect(script).toContain('updateJson("package.json"');
    expect(script).toContain('updateJson("src-tauri/tauri.conf.json"');
    expect(script).toContain("[workspace\\.package\\]");
    expect(script).toContain("for (const name of [");
    for (const crate of [
      "rion-appkit",
      "rion-core",
      "rion-node",
      "rion-platform",
      "rion-tauri",
      "rion-updater"
    ]) {
      expect(script).toContain(`"${crate}"`);
    }
    expect(script).toContain('await write("Cargo.lock", cargoLock)');
  });

  it("accepts the argument separator forwarded by pnpm 11", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "rion-release-version-"));
    try {
      await mkdir(join(fixtureRoot, "scripts"));
      await mkdir(join(fixtureRoot, "src-tauri"));
      await Promise.all([
        copyFile("scripts/applyReleaseVersion.mjs", join(fixtureRoot, "scripts/applyReleaseVersion.mjs")),
        copyFile("package.json", join(fixtureRoot, "package.json")),
        copyFile("Cargo.toml", join(fixtureRoot, "Cargo.toml")),
        copyFile("Cargo.lock", join(fixtureRoot, "Cargo.lock")),
        copyFile("src-tauri/tauri.conf.json", join(fixtureRoot, "src-tauri/tauri.conf.json"))
      ]);

      await execFileAsync(process.execPath, [
        join(fixtureRoot, "scripts/applyReleaseVersion.mjs"),
        "--",
        "3.3.1"
      ]);

      const [packageSource, tauriSource, cargoSource, lockSource] = await Promise.all([
        readFile(join(fixtureRoot, "package.json"), "utf8"),
        readFile(join(fixtureRoot, "src-tauri/tauri.conf.json"), "utf8"),
        readFile(join(fixtureRoot, "Cargo.toml"), "utf8"),
        readFile(join(fixtureRoot, "Cargo.lock"), "utf8")
      ]);
      expect(JSON.parse(packageSource).version).toBe("3.3.1");
      expect(JSON.parse(tauriSource).version).toBe("3.3.1");
      expect(cargoSource).toMatch(/\[workspace\.package\][\s\S]*?\nversion = "3\.3\.1"/);
      for (const name of ["rion-core", "rion-platform", "rion-tauri"]) {
        expect(lockSource).toContain(`name = "${name}"\nversion = "3.3.1"`);
      }
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
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
    expect(packageLauncher).not.toContain("test:native:");
    expect(packageLauncher).not.toContain("attestation");
    expect(Object.keys(packageJson.scripts).some((name) => name.startsWith("test:native:")))
      .toBe(false);
    expect(packageLauncher).toContain("createUpdaterArtifacts: false");
    expect(packageLauncher).toContain('signingIdentity: "-"');
    expect(packageLauncher).toContain('if (args[0] === "--") args.shift()');
    expect(packageJson.scripts.dist).toBe("node scripts/buildTauriRelease.mjs");
    const releaseLauncher = await readFile("scripts/buildTauriRelease.mjs", "utf8");
    expect(releaseLauncher).toContain(
      'if (forwardedArguments[0] === "--") forwardedArguments.shift()'
    );
    expect(releaseLauncher).toContain('import { spawnPlatformCommand }');
    expect(releaseLauncher).toContain("spawnPlatformCommand(executable, args");
    expect(releaseLauncher).not.toContain("spawnSync");
    expect(releaseLauncher).toContain('signingIdentity: "-"');
    expect(releaseLauncher).toContain("delete buildEnvironment[name]");
    expect(releaseLauncher).not.toContain("releasePlatformBundle");
    expect(releaseLauncher).not.toContain("verifyWindowsCertificatePublisher");
    expect(releaseLauncher).not.toContain("certificateThumbprint");
    expect(packageJson.scripts).not.toHaveProperty("dev:tauri");
    expect(packageJson.scripts).not.toHaveProperty("build:tauri");
  });
});
