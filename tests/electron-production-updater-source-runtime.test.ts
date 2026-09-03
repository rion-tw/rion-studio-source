import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { serializeCanonicalJson } from "../scripts/canonicalJson.mjs";
import {
  ELECTRON_PRODUCTION_UPDATER_SOURCE_RUNTIME_LAUNCH_KIND,
  ELECTRON_PRODUCTION_UPDATER_SOURCE_RUNTIME_PREPARATION_KIND,
  launchElectronProductionUpdaterSourceRuntime,
  prepareElectronProductionUpdaterSourceRuntime,
  type ElectronProductionUpdaterSourceRuntimeDependencies
} from "../scripts/electronProductionUpdaterSourceRuntime.mjs";
import {
  runElectronProductionUpdaterSourceRuntimeCli
} from "../scripts/electronProductionUpdaterSourceRuntimeCli.mjs";

const ARTIFACT_BYTES = "exact signed source artifact\n";
const EXECUTABLE_BYTES = "exact installed source executable\n";
const NOW = "2026-09-02T00:00:00.000Z";
const TARGET_SHA = "a".repeat(40);
const SOURCE_SHA = "b".repeat(40);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })
  ));
});

describe("Electron production updater source runtime", () => {
  it.each([
    ["darwin-aarch64", "tauri-v22-to-electron-v23"],
    ["darwin-aarch64", "electron-v23-to-electron-v23"],
    ["windows-x86_64", "tauri-v22-to-electron-v23"],
    ["windows-x86_64", "electron-v23-to-electron-v23"]
  ] as const)(
    "prepares exact %s %s source bytes without a runtime override",
    async (platform, transitionKind) => {
      const fixture = await createFixture(platform, transitionKind);
      const preparation = await prepareElectronProductionUpdaterSourceRuntime(
        fixture.input,
        runtimeDependencies(fixture)
      );

      expect(preparation.receipt).toMatchObject({
        schemaVersion: 1,
        kind: ELECTRON_PRODUCTION_UPDATER_SOURCE_RUNTIME_PREPARATION_KIND,
        platform,
        transitionKind,
        source: fixture.sourceBinding,
        artifact: {
          bytes: Buffer.byteLength(ARTIFACT_BYTES),
          fileName: fixture.sourceBinding.artifactName,
          sha256: sha256(ARTIFACT_BYTES)
        },
        runningImage: {
          bytes: Buffer.byteLength(EXECUTABLE_BYTES),
          fileName: fixture.executableName,
          sha256: sha256(EXECUTABLE_BYTES)
        },
        launchPolicy: {
          arguments: [],
          embeddedUpdaterEndpointOnly: true,
          privateUpdaterMaterialPresent: false,
          remoteDebugging: false,
          userDataOverrideUsed: false
        }
      });
      expect(preparation.preparationIdentity).toMatchObject({
        fileName: "source-runtime-preparation.json",
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/u)
      });
      expect(JSON.parse(await readFile(fixture.outputPath, "utf8")))
        .toEqual(preparation.receipt);
    }
  );

  it("launches the prepared executable with no arguments and preserves the caller signal", async () => {
    const fixture = await createFixture(
      "darwin-aarch64",
      "electron-v23-to-electron-v23"
    );
    const preparation = await prepareElectronProductionUpdaterSourceRuntime(
      fixture.input,
      runtimeDependencies(fixture)
    );
    const launched: Array<Record<string, unknown>> = [];
    let unrefCalls = 0;
    let nowCall = 0;
    const result = await launchElectronProductionUpdaterSourceRuntime({
      expectedPreparationSha256: preparation.preparationIdentity.sha256,
      outputPath: fixture.launchOutputPath,
      preparationPath: fixture.outputPath,
      signal: fixture.signal
    }, {
      hostPlatform: "darwin",
      launchProcess: async (input) => {
        launched.push(input as unknown as Record<string, unknown>);
        return {
          processId: 42_420,
          terminate: () => undefined,
          unref: () => { unrefCalls += 1; }
        };
      },
      now: () => new Date(nowCall++ === 0
        ? "2026-09-02T00:01:00.000Z"
        : "2026-09-02T00:01:00.001Z"),
      runtimeEnvironment: () => ({ PATH: "/usr/bin" })
    });

    expect(launched).toHaveLength(1);
    expect(launched[0]).toMatchObject({
      arguments: [],
      environment: { PATH: "/usr/bin" },
      executablePath: preparation.receipt.installation.executablePath,
      signal: fixture.signal
    });
    expect(result.launch).toEqual({
      schemaVersion: 1,
      kind: ELECTRON_PRODUCTION_UPDATER_SOURCE_RUNTIME_LAUNCH_KIND,
      platform: "darwin-aarch64",
      transitionKind: "electron-v23-to-electron-v23",
      preparationSha256: preparation.preparationIdentity.sha256,
      executablePath: preparation.receipt.installation.executablePath,
      arguments: [],
      launchedAfterMilliseconds: Date.parse("2026-09-02T00:01:00.000Z"),
      launchedAt: "2026-09-02T00:01:00.001Z",
      processId: 42_420,
      remoteDebugging: false,
      userDataOverrideUsed: false
    });
    expect(unrefCalls).toBe(1);
  });

  it("rejects mismatched artifact bytes before installation and keeps roots absent", async () => {
    const fixture = await createFixture(
      "windows-x86_64",
      "tauri-v22-to-electron-v23"
    );
    await writeFile(fixture.artifactPath, "foreign source artifact\n");
    let installed = false;
    await expect(prepareElectronProductionUpdaterSourceRuntime(
      fixture.input,
      {
        ...runtimeDependencies(fixture),
        installWindows: async () => {
          installed = true;
          throw new Error("must not install");
        }
      }
    )).rejects.toThrow("source artifact SHA-256 does not match");
    expect(installed).toBe(false);
    await expect(readFile(join(fixture.installRoot, fixture.executableName)))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(fixture.userDataDirectory, "anything")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a source binding whose runtime does not match its transition", async () => {
    const fixture = await createFixture(
      "darwin-aarch64",
      "tauri-v22-to-electron-v23"
    );
    await writeBindings(fixture.bindingsPath, {
      ...fixture.sourceBinding,
      runtime: "electron-v23"
    });
    await expect(prepareElectronProductionUpdaterSourceRuntime(
      fixture.input,
      runtimeDependencies(fixture)
    )).rejects.toThrow("source runtime does not match");
  });

  it("keeps prepare and launch CLI option sets exact and propagates the signal", async () => {
    const fixture = await createFixture(
      "windows-x86_64",
      "electron-v23-to-electron-v23"
    );
    const stdout: Buffer[] = [];
    const preparationIdentity = {
      bytes: 100,
      fileName: "source-runtime-preparation.json",
      sha256: sha256("preparation")
    };
    let observedSignal: AbortSignal | undefined;
    const summary = await runElectronProductionUpdaterSourceRuntimeCli([
      "prepare",
      "--artifact", fixture.artifactPath,
      "--bindings", fixture.bindingsPath,
      "--install-root", fixture.installRoot,
      "--output", fixture.outputPath,
      "--platform", fixture.platform,
      "--transition-kind", fixture.transitionKind,
      "--user-data", fixture.userDataDirectory
    ], {
      prepare: (async (input: { signal: AbortSignal }) => {
        observedSignal = input.signal;
        return {
          receipt: {
            installation: { executablePath: join(fixture.installRoot, "Rion Studio.exe") }
          },
          preparationIdentity,
          preparationPath: fixture.outputPath,
          installRoot: fixture.installRoot,
          userDataDirectory: fixture.userDataDirectory
        };
      }) as never,
      signal: fixture.signal,
      writeStdout: (source) => { stdout.push(source); }
    });
    expect(observedSignal).toBe(fixture.signal);
    expect(summary).toMatchObject({
      command: "prepare",
      status: "prepared",
      artifact: preparationIdentity
    });
    expect(JSON.parse(stdout[0].toString("utf8"))).toEqual(summary);

    await expect(runElectronProductionUpdaterSourceRuntimeCli([
      "launch",
      "--expected-preparation-sha256", preparationIdentity.sha256,
      "--output", fixture.launchOutputPath,
      "--preparation", fixture.outputPath,
      "--timeout", "1000"
    ], { signal: fixture.signal })).rejects.toThrow(
      "Unknown source-runtime launch option --timeout"
    );
  });
});

interface Fixture {
  artifactPath: string;
  bindingsPath: string;
  executableName: string;
  input: Parameters<typeof prepareElectronProductionUpdaterSourceRuntime>[0];
  installRoot: string;
  launchOutputPath: string;
  outputPath: string;
  platform: "darwin-aarch64" | "windows-x86_64";
  root: string;
  signal: AbortSignal;
  sourceBinding: Record<string, unknown>;
  transitionKind:
    | "tauri-v22-to-electron-v23"
    | "electron-v23-to-electron-v23";
  userDataDirectory: string;
}

async function createFixture(
  platform: Fixture["platform"],
  transitionKind: Fixture["transitionKind"]
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "rion-updater-source-runtime-"));
  temporaryDirectories.push(root);
  const isTauri = transitionKind === "tauri-v22-to-electron-v23";
  const isDarwin = platform === "darwin-aarch64";
  const artifactName = isDarwin
    ? "Rion.Studio-mac.app.tar.gz"
    : "Rion.Studio-win.exe";
  const artifactPath = join(root, "input", artifactName);
  const bindingsPath = join(root, "input", "bundle-bindings.json");
  const installRoot = join(root, "runtime");
  const outputPath = join(root, "evidence", "source-runtime-preparation.json");
  const launchOutputPath = join(root, "evidence", "source-runtime-launch.json");
  const userDataDirectory = join(root, "standard-data", "Rion Studio");
  const sourceBinding = createSourceBinding(isTauri, artifactName);
  await Promise.all([
    mkdir(dirname(artifactPath), { recursive: true }),
    mkdir(dirname(outputPath), { recursive: true }),
    mkdir(dirname(userDataDirectory), { recursive: true })
  ]);
  await Promise.all([
    writeFile(artifactPath, ARTIFACT_BYTES),
    writeBindings(bindingsPath, sourceBinding)
  ]);
  const signal = new AbortController().signal;
  return {
    artifactPath,
    bindingsPath,
    executableName: isDarwin
      ? (isTauri ? "rion-tauri" : "Rion Studio")
      : (isTauri ? "rion-tauri.exe" : "Rion Studio.exe"),
    input: {
      artifactPath,
      bindingsPath,
      installRoot,
      outputPath,
      platform,
      signal,
      transitionKind,
      userDataDirectory
    },
    installRoot,
    launchOutputPath,
    outputPath,
    platform,
    root,
    signal,
    sourceBinding,
    transitionKind,
    userDataDirectory
  };
}

function createSourceBinding(isTauri: boolean, artifactName: string) {
  const common = {
    artifactName,
    artifactSha256: sha256(ARTIFACT_BYTES),
    lineageKind: isTauri ? "published-release" : "production-candidate",
    manifestName: "latest.json",
    manifestSha256: sha256("source manifest"),
    runningImageSha256: sha256(EXECUTABLE_BYTES),
    runtime: isTauri ? "tauri-v22" : "electron-v23",
    sourceSha: SOURCE_SHA,
    version: isTauri ? "8.4.0" : "8.5.0"
  };
  return isTauri
    ? {
        ...common,
        defaultUpdaterEndpoint:
          "https://github.com/rion-tw/rion-studio/releases/latest/download/latest.json",
        releaseTag: "v8.4.0"
      }
    : {
        ...common,
        candidateReceiptSha256: sha256("source candidate receipt"),
        embeddedUpdaterEndpoint: "https://updates.example.test/rion/v23/latest.json"
      };
}

function runtimeDependencies(
  fixture: Fixture
): ElectronProductionUpdaterSourceRuntimeDependencies {
  const runtime = fixture.transitionKind === "tauri-v22-to-electron-v23"
    ? "tauri-v22"
    : "electron-v23";
  return {
    expectedUserDataDirectory: () => fixture.userDataDirectory,
    extractDarwin: async ({ destinationPath }) => {
      const executablePath = join(
        destinationPath,
        "Contents",
        "MacOS",
        runtime === "tauri-v22" ? "rion-tauri" : "Rion Studio"
      );
      await mkdir(dirname(executablePath), { recursive: true });
      await writeFile(executablePath, EXECUTABLE_BYTES, { mode: 0o700 });
      return { destinationPath };
    },
    hostPlatform: fixture.platform === "darwin-aarch64" ? "darwin" : "win32",
    installWindows: async ({ installRoot }) => {
      const executablePath = join(
        installRoot,
        runtime === "tauri-v22" ? "rion-tauri.exe" : "Rion Studio.exe"
      );
      await mkdir(installRoot, { recursive: true });
      await writeFile(executablePath, EXECUTABLE_BYTES, { mode: 0o700 });
      return {
        applicationPath: installRoot,
        executablePath,
        installKind: "silent-current-user-nsis" as const
      };
    },
    now: () => new Date(NOW)
  };
}

async function writeBindings(
  bindingsPath: string,
  sourceBinding: Record<string, unknown>
) {
  await writeFile(bindingsPath, serializeCanonicalJson({
    provenance: {
      artifactName: "aggregate",
      repository: "rion-tw/rion-studio-source",
      runAttempt: 1,
      runId: "123",
      sourceSha: TARGET_SHA,
      workflow: ".github/workflows/electron-production-updater-evidence.yml"
    },
    sourceBinding,
    targetBinding: {
      sourceSha: TARGET_SHA,
      version: "8.6.0"
    }
  }));
}

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}
