import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { normalizeUpdaterPublicKey } from
  "../scripts/electronProductionCandidate.mjs";
import { serializeCanonicalJson } from "../scripts/canonicalJson.mjs";

import { buildElectronUpdaterPreviousFixtures } from
  "../scripts/buildElectronUpdaterPreviousFixtures.mjs";
import {
  decodeTauriPublicKey,
  encodeEphemeralUpdaterCiPassword,
  prepareElectronUpdaterCiFixture
} from "../scripts/prepareElectronUpdaterCiFixture.mjs";
import {
  runElectronUpdaterTransactionProbe,
  verifyElectronUpdaterCompatibilityInput
} from
  "../scripts/runElectronUpdaterTransactionProbe.mjs";
import {
  assertUpdaterPrivateEnvironmentAbsent,
  ELECTRON_UPDATER_PREPARED_INPUT_KIND,
  prepareElectronUpdaterProbeInput,
  readElectronUpdaterPreparedProbeInput
} from
  "../scripts/electronUpdaterPreparedProbeInput.mjs";
import {
  createUpdaterProbeRuntimeEnvironment,
  sanitizeUpdaterRuntimeEnvironment
} from
  "../scripts/runtimeEnvironmentPolicy.mjs";
import {
  createUpdaterSignerEnvironment,
  createUpdaterSignerGenerationEnvironment,
  signUpdaterArtifact
} from "../scripts/updaterSignerEnvironment.mjs";
import { verifyTauriV22UpdaterInput } from
  "../scripts/verifyTauriV22UpdaterInput.mjs";

const PUBLIC_KEY = "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
const ENCODED_PUBLIC_KEY_FILE = Buffer.from(
  `untrusted comment: minisign public key: production\n${PUBLIC_KEY}\n`,
  "utf8"
).toString("base64");

describe("Electron updater CI fixtures", () => {
  it("removes updater signing secrets before transaction runtime probes", () => {
    const source = {
      PATH: "/usr/bin",
      RION_STUDIO_UPDATER_PUBLIC_KEY: PUBLIC_KEY,
      RION_STUDIO_UPDATER_PRIVATE_TOKEN: "production-token",
      TAURI_SIGNING_PRIVATE_KEY: "production-private-key",
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "production-password",
      TAURI_SIGNING_PRIVATE_KEY_PATH: "/tmp/private-key",
      tauri_signing_private_key_lowercase: "case-insensitive-private-key"
    };

    expect(sanitizeUpdaterRuntimeEnvironment(source)).toEqual({
      PATH: "/usr/bin",
      RION_STUDIO_UPDATER_PUBLIC_KEY: PUBLIC_KEY
    });
    expect(source.TAURI_SIGNING_PRIVATE_KEY_PASSWORD).toBe(
      "production-password"
    );
    expect(() => assertUpdaterPrivateEnvironmentAbsent({
      PATH: "/usr/bin",
      TAURI_SIGNING_PRIVATE_KEY: "must-not-cross-runtime-boundary"
    })).toThrow("must not receive private signing environment");
    expect(() => assertUpdaterPrivateEnvironmentAbsent({
      RION_STUDIO_UPDATER_PRIVATE_TOKEN: "must-not-cross-runtime-boundary"
    })).toThrow("RION_STUDIO_UPDATER_PRIVATE_TOKEN");
    expect(() => assertUpdaterPrivateEnvironmentAbsent({
      PATH: "/usr/bin",
      RION_STUDIO_UPDATER_PUBLIC_KEY: PUBLIC_KEY
    })).not.toThrow();
  });

  it("gives updater runtime children only toolchain state and explicit probe inputs", () => {
    const source = {
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-token",
      ACTIONS_RUNTIME_TOKEN: "actions-token",
      AWS_ACCESS_KEY_ID: "cloud-key",
      AZURE_CLIENT_SECRET: "azure-secret",
      CARGO_HOME: "/Users/runner/.cargo",
      CARGO_TARGET_DIR: "/tmp/cargo-target",
      CFFIXED_USER_HOME: "/tmp/runtime-home",
      CI: "true",
      GITHUB_ACTIONS: "true",
      GITHUB_ENV: "/tmp/github-env",
      GITHUB_OUTPUT: "/tmp/github-output",
      GITHUB_PATH: "/tmp/github-path",
      GITHUB_STEP_SUMMARY: "/tmp/github-summary",
      GITHUB_TOKEN: "github-token",
      GOOGLE_APPLICATION_CREDENTIALS: "/tmp/google-credentials.json",
      HOME: "/Users/runner",
      HTTP_PROXY: "http://proxy.invalid",
      HTTPS_PROXY: "http://proxy.invalid",
      LANG: "en_US.UTF-8",
      NODE_AUTH_TOKEN: "npm-token",
      NODE_OPTIONS: "--require=/tmp/injected.cjs",
      NODE_PATH: "/tmp/injected-modules",
      NPM_CONFIG_USERCONFIG: "/tmp/attacker-npmrc",
      PATH: "/usr/bin:/bin",
      PNPM_AUTH_TOKEN: "pnpm-token",
      DYLD_INSERT_LIBRARIES: "/tmp/injected.dylib",
      DYLD_LIBRARY_PATH: "/tmp/injected-libraries",
      RION_STUDIO_UPDATER_PUBLIC_KEY: PUBLIC_KEY,
      RION_UPDATER_CI_FIXTURE_ROOT: "/tmp/private-parent-input",
      RUSTUP_HOME: "/Users/runner/.rustup",
      TAURI_SIGNING_PRIVATE_KEY: "production-private-key",
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "production-password",
      TMPDIR: "/tmp/runtime"
    };
    const overrides = {
      RION_UPDATER_PREVIOUS_V23_INSTALLER: "/tmp/previous-installer",
      RION_UPDATER_PREVIOUS_V23_VERSION: "23.0.0",
      RION_UPDATER_PROBE_ARTIFACT: "/tmp/prepared/target.tar.gz",
      RION_UPDATER_PROBE_PUBLIC_KEY: PUBLIC_KEY
    };
    const sourceSnapshot = { ...source };
    const overridesSnapshot = { ...overrides };

    expect(createUpdaterProbeRuntimeEnvironment(source, overrides)).toEqual({
      CARGO_HOME: "/Users/runner/.cargo",
      CARGO_TARGET_DIR: "/tmp/cargo-target",
      CFFIXED_USER_HOME: "/tmp/runtime-home",
      CI: "true",
      GITHUB_ACTIONS: "true",
      HOME: "/Users/runner",
      LANG: "en_US.UTF-8",
      PATH: "/usr/bin:/bin",
      RION_UPDATER_PREVIOUS_V23_INSTALLER: "/tmp/previous-installer",
      RION_UPDATER_PREVIOUS_V23_VERSION: "23.0.0",
      RION_UPDATER_PROBE_ARTIFACT: "/tmp/prepared/target.tar.gz",
      RION_UPDATER_PROBE_PUBLIC_KEY: PUBLIC_KEY,
      RUSTUP_HOME: "/Users/runner/.rustup",
      TMPDIR: "/tmp/runtime"
    });
    expect(source).toEqual(sourceSnapshot);
    expect(overrides).toEqual(overridesSnapshot);
    expect(() => createUpdaterProbeRuntimeEnvironment({
      PATH: "/usr/bin",
      Path: "/bin"
    })).toThrow("duplicate PATH entries");
    expect(() => createUpdaterProbeRuntimeEnvironment(source, {
      GITHUB_OUTPUT: "/tmp/github-output"
    })).toThrow("Unsupported updater probe runtime override");
    expect(() => createUpdaterProbeRuntimeEnvironment(source, {
      TAURI_SIGNING_PRIVATE_KEY: "must-not-cross"
    })).toThrow("Unsupported updater probe runtime override");
    expect(() => createUpdaterProbeRuntimeEnvironment(source, {
      RION_UPDATER_PROBE_ARTIFACT: "/tmp/first",
      rion_updater_probe_artifact: "/tmp/second"
    })).toThrow("duplicate RION_UPDATER_PROBE_ARTIFACT entries");

    expect(createUpdaterProbeRuntimeEnvironment({
      ACTIONS_RUNTIME_TOKEN: "actions-token",
      AZURE_CLIENT_SECRET: "azure-secret",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      GITHUB_ENV: "C:\\runner\\github-env",
      GITHUB_OUTPUT: "C:\\runner\\github-output",
      GITHUB_PATH: "C:\\runner\\github-path",
      GITHUB_STEP_SUMMARY: "C:\\runner\\github-summary",
      NODE_OPTIONS: "--require=C:\\injected.cjs",
      NODE_PATH: "C:\\injected-modules",
      NPM_CONFIG_USERCONFIG: "C:\\attacker-npmrc",
      Path: "C:\\Windows\\System32",
      PATHEXT: ".COM;.EXE;.CMD",
      PNPM_AUTH_TOKEN: "pnpm-token",
      SystemDrive: "C:",
      SystemRoot: "C:\\Windows",
      TEMP: "C:\\runtime-temp",
      USERPROFILE: "C:\\runtime-home",
      WINDIR: "C:\\Windows"
    }, {
      RION_UPDATER_PROBE_ARTIFACT: "C:\\prepared\\Rion.Studio-win.exe"
    })).toEqual({
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      Path: "C:\\Windows\\System32",
      PATHEXT: ".COM;.EXE;.CMD",
      RION_UPDATER_PROBE_ARTIFACT: "C:\\prepared\\Rion.Studio-win.exe",
      SystemDrive: "C:",
      SystemRoot: "C:\\Windows",
      TEMP: "C:\\runtime-temp",
      USERPROFILE: "C:\\runtime-home",
      WINDIR: "C:\\Windows"
    });
  });

  it("gives updater signer children only isolated homes and an exact allowlist", () => {
    const source = {
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-token",
      GITHUB_ENV: "/tmp/github-env",
      GITHUB_TOKEN: "github-token",
      HOME: "/Users/runner",
      LANG: "en_US.UTF-8",
      NODE_AUTH_TOKEN: "npm-token",
      NODE_OPTIONS: "--require=/tmp/injected.cjs",
      PATH: "/usr/bin",
      RION_STUDIO_UPDATER_PUBLIC_KEY: PUBLIC_KEY,
      RUNNER_TEMP: "/tmp/runner",
      TAURI_SIGNING_PRIVATE_KEY: "production-private-key",
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "production-password",
      TEMP: "/tmp/runner-temp"
    };
    const snapshot = { ...source };
    const signerHome = resolve("/tmp/rion-isolated-signer-home");

    expect(createUpdaterSignerEnvironment(source, signerHome)).toEqual({
      APPDATA: join(signerHome, "appdata"),
      HOME: signerHome,
      LANG: "en_US.UTF-8",
      LOCALAPPDATA: join(signerHome, "local-appdata"),
      PATH: "/usr/bin",
      TAURI_SIGNING_PRIVATE_KEY: "production-private-key",
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "production-password",
      TEMP: join(signerHome, "tmp"),
      TMP: join(signerHome, "tmp"),
      TMPDIR: join(signerHome, "tmp"),
      USERPROFILE: signerHome
    });
    expect(createUpdaterSignerGenerationEnvironment(source, signerHome)).toEqual({
      APPDATA: join(signerHome, "appdata"),
      HOME: signerHome,
      LANG: "en_US.UTF-8",
      LOCALAPPDATA: join(signerHome, "local-appdata"),
      PATH: "/usr/bin",
      TEMP: join(signerHome, "tmp"),
      TMP: join(signerHome, "tmp"),
      TMPDIR: join(signerHome, "tmp"),
      USERPROFILE: signerHome
    });
    expect(source).toEqual(snapshot);
    expect(() => createUpdaterSignerEnvironment({
      PATH: "/usr/bin",
      TAURI_SIGNING_PRIVATE_KEY: "inline",
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "password",
      TAURI_SIGNING_PRIVATE_KEY_PATH: "/tmp/key"
    }, signerHome)).toThrow("exactly one private key source");
    expect(() => createUpdaterSignerEnvironment({
      PATH: "/usr/bin",
      Path: "/bin",
      TAURI_SIGNING_PRIVATE_KEY: "inline",
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "password"
    }, signerHome)).toThrow("duplicate PATH entries");

    expect(createUpdaterSignerEnvironment({
      ACTIONS_RUNTIME_TOKEN: "actions-token",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      GITHUB_OUTPUT: "C:\\runner\\output",
      NODE_OPTIONS: "--require=C:\\injected.cjs",
      Path: "C:\\Windows\\System32",
      PATHEXT: ".COM;.EXE;.CMD",
      SystemDrive: "C:",
      SystemRoot: "C:\\Windows",
      tauri_signing_private_key_password: "windows-password",
      tauri_signing_private_key_path: "C:\\fixture\\updater.key",
      WINDIR: "C:\\Windows"
    }, signerHome)).toEqual({
      APPDATA: join(signerHome, "appdata"),
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      HOME: signerHome,
      LOCALAPPDATA: join(signerHome, "local-appdata"),
      Path: "C:\\Windows\\System32",
      PATHEXT: ".COM;.EXE;.CMD",
      SystemDrive: "C:",
      SystemRoot: "C:\\Windows",
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "windows-password",
      TAURI_SIGNING_PRIVATE_KEY_PATH: "C:\\fixture\\updater.key",
      TEMP: join(signerHome, "tmp"),
      TMP: join(signerHome, "tmp"),
      TMPDIR: join(signerHome, "tmp"),
      USERPROFILE: signerHome,
      WINDIR: "C:\\Windows"
    });
  });

  it("redacts signer failures and never places the production password in argv", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "rion-signer-redaction-"));
    const artifactPath = join(fixtureRoot, "artifact.bin");
    const privateKey = "sentinel-private-key-that-must-not-leak";
    const password = "sentinel-password-that-must-not-leak";
    await writeFile(artifactPath, "artifact");
    let failure: unknown;
    try {
      try {
        await signUpdaterArtifact({
          artifactPath,
          environment: {
            PATH: process.env.PATH,
            TAURI_SIGNING_PRIVATE_KEY: privateKey,
            TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password
          },
          workingDirectory: process.cwd()
        });
      } catch (error) {
        failure = error;
      }
    } finally {
      await rm(fixtureRoot, { force: true, recursive: true });
    }
    expect(String(failure)).toBe("Error: Updater artifact signing failed.");
    expect(String(failure)).not.toContain(privateKey);
    expect(String(failure)).not.toContain(password);

    const signerSource = await readFile(
      "scripts/updaterSignerEnvironment.mjs",
      "utf8"
    );
    const signingInvocation = signerSource.slice(
      signerSource.indexOf("await execFileAsync(process.execPath"),
      signerSource.indexOf("} finally")
    );
    expect(signingInvocation).not.toContain('"--password"');
    expect(signingInvocation).not.toContain("environment,");
  });

  it("decodes only the ephemeral Tauri public-key file format", () => {
    const encoded = Buffer.from([
      "untrusted comment: minisign public key: fixture",
      PUBLIC_KEY,
      ""
    ].join("\n"), "utf8").toString("base64");
    expect(decodeTauriPublicKey(encoded)).toBe(PUBLIC_KEY);
    expect(() => decodeTauriPublicKey("not-a-key")).toThrow("invalid");
    expect(() => decodeTauriPublicKey(Buffer.from(
      `trusted comment: fixture\n${PUBLIC_KEY}\n`,
      "utf8"
    ).toString("base64"))).toThrow("invalid");
  });

  it("keeps random updater passwords unambiguous as command-line values", () => {
    const entropy = Buffer.alloc(24);
    entropy[0] = 0xf8;
    const password = encodeEphemeralUpdaterCiPassword(entropy);

    expect(entropy.toString("base64url")).toMatch(/^-/u);
    expect(password).toBe(`rion-ci-${entropy.toString("base64url")}`);
    expect(password).not.toMatch(/^-/u);
    expect(() => encodeEphemeralUpdaterCiPassword(Buffer.alloc(23)))
      .toThrow("requires 24 bytes");
  });

  it("keeps key generation and packaged transactions CI-only", async () => {
    await expect(prepareElectronUpdaterCiFixture({})).rejects.toThrow(
      "restricted to GitHub CI"
    );
    await expect(runElectronUpdaterTransactionProbe([], {})).rejects.toThrow(
      "restricted to GitHub CI"
    );
    await expect(buildElectronUpdaterPreviousFixtures({})).rejects.toThrow(
      "restricted to Windows GitHub CI"
    );
    await expect(verifyTauriV22UpdaterInput([], {})).rejects.toThrow(
      "restricted to GitHub CI"
    );
  });

  it("binds separately prepared updater inputs and rejects private runtime env", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "rion-prepared-updater-test-"));
    const artifact = join(fixtureRoot, "Rion.Studio-mac.app.tar.gz");
    const artifactSignature = `${artifact}.sig`;
    const companion = join(fixtureRoot, "Rion.Studio-win.exe");
    const companionSignature = `${companion}.sig`;
    const manifest = join(fixtureRoot, "latest-darwin.json");
    const receiptPath = join(fixtureRoot, "prepared-updater-probe-input.json");
    const files = new Map<string, Buffer>([
      [artifact, Buffer.from("target artifact", "utf8")],
      [artifactSignature, Buffer.from("target signature", "utf8")],
      [companion, Buffer.from("companion artifact", "utf8")],
      [companionSignature, Buffer.from("companion signature", "utf8")],
      [manifest, Buffer.from('{"version":"23.4.0"}\n', "utf8")]
    ]);
    await Promise.all(
      [...files].map(([filePath, source]) => writeFile(filePath, source))
    );
    const identity = (filePath: string) => {
      const source = files.get(filePath)!;
      return {
        path: filePath,
        bytes: source.length,
        sha256: createHash("sha256").update(source).digest("hex")
      };
    };
    const receipt = {
      schemaVersion: 2,
      kind: ELECTRON_UPDATER_PREPARED_INPUT_KIND,
      architecture: "arm64",
      platform: "darwin",
      version: "23.4.0",
      artifact: identity(artifact),
      artifactSignature: identity(artifactSignature),
      companion: identity(companion),
      companionSignature: identity(companionSignature),
      macosPackageVerification: {
        applicationBundle: "Rion Studio.app",
        artifact: {
          bytes: files.get(artifact)!.length,
          fileName: "Rion.Studio-mac.app.tar.gz",
          sha256: identity(artifact).sha256
        },
        expectedVersion: "23.4.0",
        kind: "rion-electron-updater-macos-package-verification",
        packageManifest: {
          directoryCount: 1,
          entryCount: 2,
          regularFileBytes: 42,
          regularFileCount: 1,
          schemaVersion: 1,
          sha256: createHash("sha256").update("package manifest").digest("hex"),
          symlinkCount: 0
        },
        schemaVersion: 1,
        verificationKind:
          "safe-tar-extraction-production-electron-package-v1"
      },
      manifest: identity(manifest)
    };
    await writeFile(receiptPath, serializeCanonicalJson(receipt));
    const input = {
      artifactPath: artifact,
      architecture: "arm64" as const,
      environment: { PATH: "/usr/bin" },
      fixtureRoot,
      platform: "darwin" as const,
      receiptPath,
      version: "23.4.0"
    };
    await expect(readElectronUpdaterPreparedProbeInput(input)).resolves.toMatchObject({
      artifact,
      companion,
      manifest,
      receiptPath
    });
    await expect(readElectronUpdaterPreparedProbeInput({
      ...input,
      environment: { TAURI_SIGNING_PRIVATE_KEY: "forbidden" }
    })).rejects.toThrow("must not receive private signing environment");
    await writeFile(companion, "tampered companion");
    await expect(readElectronUpdaterPreparedProbeInput(input)).rejects.toThrow(
      "changed after signing"
    );
  });

  it("rejects a private-key path whose real ancestor escapes the fixture", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "rion-key-root-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "rion-key-outside-"));
    const sourceRoot = await mkdtemp(join(tmpdir(), "rion-key-artifact-"));
    const artifactPath = join(sourceRoot, "target.tar.gz");
    const outsideKey = join(outsideRoot, "updater.key");
    const linkedRoot = join(fixtureRoot, "linked-key-root");
    await Promise.all([
      writeFile(artifactPath, "artifact"),
      writeFile(outsideKey, "private-key")
    ]);
    await symlink(
      outsideRoot,
      linkedRoot,
      process.platform === "win32" ? "junction" : "dir"
    );
    try {
      await expect(prepareElectronUpdaterProbeInput({
        architecture: "arm64",
        artifactPath,
        environment: {
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "password",
          TAURI_SIGNING_PRIVATE_KEY_PATH: join(linkedRoot, "updater.key")
        },
        fixtureRoot,
        platform: "darwin",
        referenceApplicationPath: join(fixtureRoot, "Rion Studio.app"),
        version: "23.4.0",
        workingDirectory: process.cwd()
      })).rejects.toThrow("resolved outside its ephemeral fixture root");
    } finally {
      await Promise.all([
        rm(fixtureRoot, { force: true, recursive: true }),
        rm(outsideRoot, { force: true, recursive: true }),
        rm(sourceRoot, { force: true, recursive: true })
      ]);
    }
  });

  it("binds Windows transactions to the verified OS profile instead of AppData env spoofing", async () => {
    const source = await readFile(
      "scripts/runElectronUpdaterTransactionProbe.mjs",
      "utf8"
    );
    expect(source).toContain("resolveVerifiedWindowsProfileIsolation(environment)");
    expect(source).toContain("profile.localAppDataDirectory");
    expect(source).toContain("profile.userDataDirectory");
    expect(source).not.toContain("isolation: profile.kind");
    expect(source).toContain("runElectronUpdaterDarwinHelperProbe({");
    expect(source).not.toContain("terminateMacosInstalledApplication");
    expect(source).toContain("await terminateWindowsProcessTree(launched.pid");
    expect(source).toContain('join(fixtureRoot, "runtime-home")');
    expect(source).toContain('join(fixtureRoot, "runtime-temp")');
    expect(source).toContain("createUpdaterProbeRuntimeEnvironment(");
    expect(source.match(/readElectronUpdaterPreparedProbeInput\(/gu)).toHaveLength(2);
    expect(source).toContain(
      "writeElectronUpdaterCompatibilityProvisionalReceipt({"
    );
    expect(source).not.toContain("async function writeCompatibilityReceipt(");
    expect(source).toContain(
      "writeElectronUpdaterDarwinProcessIsolationResult({"
    );
    expect(source).toContain('"isolation-attempt-nonce"');
    expect(source).toContain('"isolation-command-invocation-sha256"');
    expect(source).toContain('"isolation-sandbox-profile-sha256"');
    expect(source).not.toContain("APPDATA: appData");
    expect(source).not.toContain("LOCALAPPDATA: localAppData");
  });

  it("pins a real Tauri v22 input to repository, tag, commit, and SHA-256", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rion-tauri-v22-input-test-"));
    const artifact = Buffer.from("real historical artifact fixture", "utf8");
    const artifactSha256 = createHash("sha256").update(artifact).digest("hex");
    const signature = "fixture updater signature";
    await Promise.all([
      writeFile(join(directory, "Rion.Studio-mac.app.tar.gz"), artifact),
      writeFile(join(directory, "Rion.Studio-mac.app.tar.gz.sig"), signature),
      writeFile(join(directory, "SHA256SUMS.txt"), [
        `${artifactSha256}  Rion.Studio-mac.app.tar.gz`,
        ""
      ].join("\n")),
      writeFile(join(directory, "latest.json"), JSON.stringify({
        version: "0.22.9",
        pub_date: "2026-08-30T00:00:00Z",
        platforms: {
          "darwin-aarch64": {
            url: "https://github.com/rion-tw/rion-studio/releases/download/v0.22.9/Rion.Studio-mac.app.tar.gz",
            signature,
            sha256: artifactSha256
          }
        }
      }))
    ]);
    const githubEnvironment = join(directory, "github-env");
    await writeFile(githubEnvironment, "");
    const output = join(directory, "receipt.json");
    const argumentsList = [
      "--directory", directory,
      "--output", output,
      "--platform", "darwin-aarch64",
      "--version", "0.22.9",
      "--release-tag", "v0.22.9",
      "--source-sha", "1".repeat(40),
      "--target-sha", "2".repeat(40),
      "--expected-sha256", artifactSha256
    ];
    const environment = {
      CI: "true",
      GITHUB_ACTIONS: "true",
      GITHUB_REPOSITORY: "rion-tw/rion-studio-source",
      GITHUB_ENV: githubEnvironment,
      RION_STUDIO_UPDATER_PUBLIC_KEY: ENCODED_PUBLIC_KEY_FILE
    };
    await expect(verifyTauriV22UpdaterInput(argumentsList, {
      ...environment,
      RION_STUDIO_UPDATER_PUBLIC_KEY: ""
    })).rejects.toThrow("RION_STUDIO_UPDATER_PUBLIC_KEY");
    await expect(verifyTauriV22UpdaterInput(argumentsList, {
      ...environment,
      GITHUB_REPOSITORY: "rion-tw/rion-studio"
    })).rejects.toThrow("must run from rion-tw/rion-studio-source");
    const receipt = await verifyTauriV22UpdaterInput(argumentsList, environment);
    expect(receipt).toMatchObject({
      schemaVersion: 2,
      evidenceKind: "tauri-v22-published-input",
      runtime: "tauri-v22",
      sourceSha: "1".repeat(40),
      targetSha: "2".repeat(40),
      updaterPublicKeySha256: normalizeUpdaterPublicKey(PUBLIC_KEY).sha256,
      artifactSha256,
      signatureSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      manifestSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      checksumSha256: expect.stringMatching(/^[0-9a-f]{64}$/u)
    });
    expect(await readFile(output)).toEqual(serializeCanonicalJson(receipt));
    await expect(verifyTauriV22UpdaterInput(argumentsList, environment))
      .rejects.toMatchObject({ code: "EEXIST" });

    const fixtureRoot = join(directory, "probe");
    await mkdir(fixtureRoot);
    const compatibilityInput = {
      fixtureRoot,
      inputReceiptPath: output,
      outputPath: join(fixtureRoot, "terminal-receipt.json"),
      platform: "darwin" as const,
      publicKey: PUBLIC_KEY,
      targetSha: "2".repeat(40)
    };
    await expect(verifyElectronUpdaterCompatibilityInput(compatibilityInput))
      .resolves.toBeUndefined();
    await writeFile(join(directory, "Rion.Studio-mac.app.tar.gz.sig"), "tampered");
    await expect(verifyElectronUpdaterCompatibilityInput(compatibilityInput))
      .rejects.toThrow("changed after receipt verification");
  });
});
