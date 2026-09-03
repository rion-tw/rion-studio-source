import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

describe("desktop shell migration gate", () => {
  const execute = promisify(execFile);

  it("is a required CI and signed-candidate check", async () => {
    const [packageJson, ci, release, preflight, buildWorkflow, candidate, gate] = await Promise.all([
      readFile("package.json", "utf8"),
      readFile(".github/workflows/ci.yml", "utf8"),
      readFile(".github/workflows/release.yml", "utf8"),
      readFile(".github/workflows/tauri-release-preflight.yml", "utf8"),
      readFile(".github/workflows/tauri-release-build.yml", "utf8"),
      readFile(".github/workflows/tauri-release-candidate.yml", "utf8"),
      readFile("scripts/verifySystemOnlyProduct.mjs", "utf8")
    ]);
    const build = buildWorkflow.slice(
      buildWorkflow.indexOf("  build:"),
      buildWorkflow.indexOf("  manifest:")
    );

    expect(packageJson).toContain(
      '"verify:system-only": "node scripts/verifySystemOnlyProduct.mjs"'
    );
    expect(ci).toContain("pnpm run verify:system-only");
    expect(release).toContain("- await-preflight");
    expect(release).toContain("- verify-upgrade-compatibility");
    expect(release).toContain("ref: ${{ needs.await-preflight.outputs.source_ref }}");
    expect(preflight).toContain("uses: ./.github/workflows/tauri-release-build.yml");
    expect(preflight).toContain("source_ref: ${{ needs.plan-release.outputs.source_ref }}");
    expect(buildWorkflow).toContain("source_ref:");
    expect(buildWorkflow).not.toContain("verified_sha:");
    expect(candidate).toContain("verified_sha:");
    expect(candidate).toContain("run_quality: ${{ github.event_name == 'workflow_dispatch' }}");
    expect(build).not.toContain("pnpm run verify:system-only");
    expect(gate).toContain("CdnCompatibilityManager");
    expect(gate).toContain("ExternalChrome");
    expect(gate).toContain("ChromeProfileImport");
    expect(gate).toContain("proxy_url");
    expect(gate).toContain("BrowserProxySettingsRecord");
    expect(gate).toContain("CoreEffectAction still exposes");
    expect(gate).toContain('"crates/rion-node/"');
    expect(gate).toContain('"src/electron/"');
    expect(gate).toContain('"scripts/verifyDesktopE2eIsolation.mjs"');
    expect(gate).toContain('"scripts/runtimeEnvironmentPolicy.mjs"');
    expect(gate).toContain('"scripts/verifyTauriV22UpdaterInput.mjs"');
    expect(gate).toContain('"scripts/windowsElectronInstallerPayloadProof"');
    expect(gate).toContain("Electron renderer entry contains Tauri compatibility token");
    expect(gate).toContain("The stable Tauri compatibility renderer entry is not preserved");
    expect(gate).toContain("stable Tauri boundary plus scoped Electron migration");
  });

  it("executes the product gate instead of checking only source strings", async () => {
    await expect(execute(process.execPath, ["scripts/verifySystemOnlyProduct.mjs"], {
      cwd: process.cwd()
    })).resolves.toMatchObject({ stderr: "" });
  }, 10_000);

  it("pins the additive Chromium shell without switching production entry points early", async () => {
    const [
      packageSource,
      cargo,
      workspace,
      electronConfig,
      tsconfig,
      runtimeVerifier
    ] = await Promise.all([
      readFile("package.json", "utf8"),
      readFile("Cargo.toml", "utf8"),
      readFile("pnpm-workspace.yaml", "utf8"),
      readFile("electron.vite.config.ts", "utf8"),
      readFile("tsconfig.json", "utf8"),
      readFile("scripts/verifyElectronRuntime.mjs", "utf8")
    ]);
    const packageJson = JSON.parse(packageSource) as {
      main?: string;
      scripts?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(packageJson.main).toBe("./out/main/index.js");
    expect(packageJson.devDependencies).toMatchObject({
      electron: "43.4.1",
      "electron-builder": "26.15.3",
      "electron-vite": "5.0.0"
    });
    expect(packageJson.devDependencies).not.toHaveProperty("@electron/rebuild");
    expect(packageJson.scripts?.dev).toBe("node scripts/devTauri.mjs");
    expect(packageJson.scripts?.build).toContain("cargo build -p rion-tauri");
    expect(packageJson.scripts?.["dev:electron"]).toContain("build:electron:rust");
    expect(packageJson.scripts?.["build:electron"]).toContain("electron-vite build");
    expect(packageJson.scripts?.["verify:electron-runtime"])
      .toBe("node scripts/verifyElectronRuntime.mjs");

    expect(cargo).toContain('"crates/rion-node"');
    expect(cargo).toContain("napi = { version = \"=3.6.1\"");
    expect(workspace).toContain("electron: true");
    expect(workspace).toContain("electron-winstaller: true");
    expect(electronConfig).toContain('"src/electron/main/index.ts"');
    expect(electronConfig).toContain('"src/electron/preload/index.ts"');
    expect(electronConfig).toContain('entryFileNames: "[name].cjs"');
    expect(electronConfig.match(/external: \["electron"\]/gu)).toHaveLength(2);
    expect(tsconfig).toContain('"./tsconfig.electron.json"');
    expect(runtimeVerifier).toContain('chrome: "150.0.7871.224"');
    expect(runtimeVerifier).toContain('electron: "43.4.1"');
    expect(runtimeVerifier).toContain('modules: "148"');
    expect(runtimeVerifier).toContain('napi: "10"');
    expect(runtimeVerifier).toContain('node: "24.18.1"');
    expect(runtimeVerifier).toContain("mkdtemp");
  });

  it.each(["remote-debugging-port", "remote-debugging-pipe"])(
    "rejects a negative fixture that reintroduces %s",
    async (switchName) => {
    const directory = await mkdtemp(join(tmpdir(), "rion-system-only-negative-"));
    const fixture = join(directory, "retired-runtime.ts");
    try {
      await writeFile(fixture, `export const argument = "${switchName}";\n`);
      await expect(execute(process.execPath, [
        "scripts/verifySystemOnlyProduct.mjs",
        "--probe",
        fixture
      ], { cwd: process.cwd() })).rejects.toMatchObject({
        stderr: expect.stringContaining(switchName)
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
    }
  );

  it.each([
    ["renderer raw proxy flag", 'export const argument = "--proxy-server=http://127.0.0.1:9";\n', "--proxy-server"],
    ["Electron proxy API", "export const apply = session.setProxy;\n", "session.setProxy"],
    ["unapproved native proxy property", "void apply(id store) { store.proxyConfigurations = nil; }\n", "proxyConfigurations"]
  ])("rejects retired %s anywhere", async (_name, source, token) => {
    const directory = await mkdtemp(join(tmpdir(), "rion-proxy-negative-"));
    const fixture = join(directory, "proxy-fixture.ts");
    try {
      await writeFile(fixture, source);
      await expect(execute(process.execPath, [
        "scripts/verifySystemOnlyProduct.mjs",
        "--probe",
        fixture
      ], { cwd: process.cwd() })).rejects.toMatchObject({
        stderr: expect.stringContaining(token)
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
