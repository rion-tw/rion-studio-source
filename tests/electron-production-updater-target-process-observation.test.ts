import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { serializeCanonicalJson } from "../scripts/canonicalJson.mjs";
import {
  ELECTRON_PRODUCTION_UPDATER_EVIDENCE_NATIVE_HOST_BINDINGS_KIND,
  ELECTRON_PRODUCTION_UPDATER_EVIDENCE_NATIVE_HOST_LAUNCH_ARGUMENTS_KIND,
  type ElectronProductionUpdaterEvidenceNativeHostObservationBindings
} from "../scripts/electronProductionUpdaterEvidenceNativeHostObservation.mjs";
import {
  ELECTRON_PRODUCTION_UPDATER_TARGET_PROCESS_OBSERVATION_KIND,
  discoverAndObserveElectronProductionUpdaterTargetProcess,
  type ElectronProductionUpdaterTargetProcessObservationDependencies
} from "../scripts/electronProductionUpdaterTargetProcessObservation.mjs";
import {
  runElectronProductionUpdaterTargetProcessObservationCli
} from "../scripts/electronProductionUpdaterTargetProcessObservationCli.mjs";

const TARGET_SHA = "a".repeat(40);
const TARGET_VERSION = "8.6.0";
const LAUNCH_FENCE = Date.parse("2026-09-02T00:01:00.000Z");
const PROCESS_STARTED_AT = Date.parse("2026-09-02T00:02:00.250Z");
const PROCESS_ID = 42_420;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })
  ));
});

describe("Electron production updater target-process observation", () => {
  it.each(["darwin-aarch64", "windows-x86_64"] as const)(
    "discovers one post-fence %s process, seals its command line, and invokes native verification",
    async (platform) => {
      const fixture = await createFixture(platform);
      const calls: unknown[] = [];
      const result = await discoverAndObserveElectronProductionUpdaterTargetProcess(
        fixture.input,
        asDependencies(platform === "darwin-aarch64"
          ? {
              hostPlatform: "darwin",
              discoverDarwinTarget: async (input: unknown) => {
                calls.push(input);
                return discovery(platform, fixture.executablePath);
              },
              observeNativeHost: nativeObserver(calls)
            }
          : {
              hostPlatform: "win32",
              discoverWindowsTarget: async (input: unknown) => {
                calls.push(input);
                return discovery(platform, fixture.executablePath);
              },
              observeNativeHost: nativeObserver(calls)
            })
      );

      expect(result).toMatchObject({
        schemaVersion: 1,
        kind: ELECTRON_PRODUCTION_UPDATER_TARGET_PROCESS_OBSERVATION_KIND,
        platform,
        process: { processId: PROCESS_ID },
        launchArguments: {
          fileName: "native-host-launch-arguments.json",
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/u)
        },
        nativeHostObservation: {
          fileName: "native-host-observation.json",
          sha256: sha256("native-host-observation")
        }
      });
      expect(calls).toHaveLength(2);
      const launchSeal = JSON.parse(await readFile(
        fixture.input.launchArgumentsOutputPath,
        "utf8"
      ));
      expect(launchSeal).toEqual({
        schemaVersion: 1,
        kind: ELECTRON_PRODUCTION_UPDATER_EVIDENCE_NATIVE_HOST_LAUNCH_ARGUMENTS_KIND,
        arguments: [`${fixture.executablePath} --rion-update-recovery`],
        context: fixture.bindings.context,
        executablePath: fixture.executablePath,
        hostClaim: {
          browserWindowOnlySubstitute: false,
          htmlChromeSubstitute: false,
          nativeHostKind: platform === "darwin-aarch64"
            ? "appkit-chromium"
            : "bundled-chromium",
          retainedAppKitHost: platform === "darwin-aarch64"
        },
        process: discovery(platform, fixture.executablePath).identity,
        target: {
          candidateReceiptSha256: fixture.bindings.target.candidateReceiptSha256,
          sourceSha: TARGET_SHA,
          version: TARGET_VERSION
        },
        targetRunningImageSha256: fixture.bindings.targetRunningImageSha256
      });
    }
  );

  it("rejects a pre-fence target candidate before any launch seal or native claim", async () => {
    const fixture = await createFixture("windows-x86_64");
    const candidate = discovery("windows-x86_64", fixture.executablePath);
    candidate.identity.creationMilliseconds = LAUNCH_FENCE - 2_000;
    let observed = false;
    await expect(discoverAndObserveElectronProductionUpdaterTargetProcess(
      fixture.input,
      asDependencies({
        hostPlatform: "win32",
        discoverWindowsTarget: async () => candidate,
        observeNativeHost: async () => {
          observed = true;
          throw new Error("must not run");
        }
      })
    )).rejects.toThrow("predates its launch fence");
    expect(observed).toBe(false);
    await expect(readFile(fixture.input.launchArgumentsOutputPath))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a noncanonical Darwin target executable before process discovery", async () => {
    const fixture = await createFixture("darwin-aarch64");
    let discovered = false;
    await expect(discoverAndObserveElectronProductionUpdaterTargetProcess({
      ...fixture.input,
      expectedExecutablePath: join(fixture.root, "Foreign.app", "Contents", "MacOS", "Foreign")
    }, asDependencies({
      hostPlatform: "darwin",
      discoverDarwinTarget: async () => {
        discovered = true;
        throw new Error("must not run");
      },
      observeNativeHost: async () => {
        throw new Error("must not run");
      }
    }))).rejects.toThrow("canonical Rion Studio app member");
    expect(discovered).toBe(false);
  });

  it("keeps CLI options platform-exact and propagates the caller signal", async () => {
    const fixture = await createFixture("windows-x86_64");
    const stdout: Buffer[] = [];
    let signal: AbortSignal | undefined;
    const expected = {
      schemaVersion: 1,
      kind: ELECTRON_PRODUCTION_UPDATER_TARGET_PROCESS_OBSERVATION_KIND,
      platform: "windows-x86_64",
      process: discovery("windows-x86_64", fixture.executablePath).identity,
      launchArguments: {
        bytes: 100,
        fileName: "native-host-launch-arguments.json",
        sha256: sha256("launch")
      },
      nativeHostObservation: {
        bytes: 100,
        fileName: "native-host-observation.json",
        sha256: sha256("native")
      }
    } as const;
    const result = await runElectronProductionUpdaterTargetProcessObservationCli([
      "observe",
      "--bindings", fixture.bindingsPath,
      "--expected-executable", fixture.executablePath,
      "--launch-arguments-output", fixture.input.launchArgumentsOutputPath,
      "--launched-after-milliseconds", String(LAUNCH_FENCE),
      "--native-host-output", fixture.input.nativeHostObservationOutputPath
    ], {
      observe: (async (input: { signal: AbortSignal }) => {
        signal = input.signal;
        return expected;
      }) as never,
      signal: fixture.input.signal,
      writeStdout: (source) => { stdout.push(source); }
    });
    expect(signal).toBe(fixture.input.signal);
    expect(result).toEqual(expected);
    expect(JSON.parse(stdout[0].toString("utf8"))).toEqual(expected);

    await expect(runElectronProductionUpdaterTargetProcessObservationCli([
      "observe",
      "--bindings", fixture.bindingsPath,
      "--expected-executable", fixture.executablePath,
      "--launch-arguments-output", fixture.input.launchArgumentsOutputPath,
      "--launched-after-milliseconds", String(LAUNCH_FENCE),
      "--native-host-output", fixture.input.nativeHostObservationOutputPath,
      "--inventory-executable", join(fixture.root, "inventory"),
      "--inventory-executable-sha256", sha256("inventory")
    ], { signal: fixture.input.signal })).rejects.toThrow(
      "option set is not exact"
    );
  });
});

async function createFixture(platform: "darwin-aarch64" | "windows-x86_64") {
  const root = await mkdtemp(join(tmpdir(), "rion-updater-target-process-"));
  temporaryDirectories.push(root);
  const isDarwin = platform === "darwin-aarch64";
  const executablePath = isDarwin
    ? join(root, "Rion Studio.app", "Contents", "MacOS", "Rion Studio")
    : join(root, "Rion Studio.exe");
  const bindings = createBindings(platform);
  const bindingsPath = join(root, "native-host-bindings.json");
  await writeFile(bindingsPath, serializeCanonicalJson(bindings));
  return {
    bindings,
    bindingsPath,
    executablePath,
    input: {
      bindings,
      expectedExecutablePath: executablePath,
      launchArgumentsOutputPath: join(root, "native-host-launch-arguments.json"),
      launchedAfterMilliseconds: LAUNCH_FENCE,
      nativeHostObservationOutputPath: join(root, "native-host-observation.json"),
      platformProcess: isDarwin
        ? {
            inventoryExecutablePath: join(root, "packaged-process-inventory"),
            inventoryExecutableSha256: sha256("inventory")
          }
        : {},
      signal: new AbortController().signal
    },
    root
  };
}

function createBindings(
  platform: "darwin-aarch64" | "windows-x86_64"
): ElectronProductionUpdaterEvidenceNativeHostObservationBindings {
  const isDarwin = platform === "darwin-aarch64";
  return {
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_UPDATER_EVIDENCE_NATIVE_HOST_BINDINGS_KIND,
    context: {
      challenge: {
        expiresAt: "2026-09-03T00:00:00.000Z",
        id: "10000000-0000-4000-8000-000000000001",
        issuedAt: "2026-09-02T00:00:00.000Z",
        nonceSha256: sha256("challenge")
      },
      evidenceAttemptId: "10000000-0000-4000-8000-000000000002",
      platform,
      sourceInstallAttemptId: "update-install-10000000-0000-4000-8000-000000000003",
      transitionKind: "electron-v23-to-electron-v23"
    },
    target: {
      artifactName: isDarwin
        ? "Rion.Studio-mac.app.tar.gz"
        : "Rion.Studio-win.exe",
      artifactSha256: sha256("target-artifact"),
      candidateReceiptSha256: sha256("target-candidate"),
      embeddedUpdaterEndpoint: "https://updates.example.test/rion/v23/latest.json",
      manifestName: "latest.json",
      runtime: "electron-v23",
      servedManifestSha256: sha256("served-manifest"),
      signatureName: isDarwin
        ? "Rion.Studio-mac.app.tar.gz.sig"
        : "Rion.Studio-win.exe.sig",
      signatureSha256: sha256("target-signature"),
      sourceSha: TARGET_SHA,
      version: TARGET_VERSION
    },
    targetRunningImageSha256: sha256("target-running-image")
  };
}

function discovery(
  platform: "darwin-aarch64" | "windows-x86_64",
  executablePath: string
) {
  const identity = platform === "darwin-aarch64"
    ? {
        auditToken: "ab".repeat(32),
        executablePath,
        parentProcessId: 300,
        parentProcessUniqueId: "700001",
        processGroupId: PROCESS_ID,
        processId: PROCESS_ID,
        processUniqueId: "800001",
        startMicroseconds: PROCESS_STARTED_AT % 1000 * 1000,
        startSeconds: Math.floor(PROCESS_STARTED_AT / 1000),
        userId: 501
      }
    : {
        creationMilliseconds: PROCESS_STARTED_AT,
        executablePath,
        processId: PROCESS_ID
      };
  return {
    arguments: [`${executablePath} --rion-update-recovery`],
    identity
  };
}

function nativeObserver(calls: unknown[]) {
  return async (input: Record<string, unknown>) => {
    calls.push(input);
    const launchPath = String(input.launchArgumentsPath);
    const launchSource = await readFile(launchPath);
    expect(sha256(launchSource)).toBe(input.launchArgumentsSha256);
    return {
      observation: {},
      observationIdentity: {
        bytes: 100,
        fileName: "native-host-observation.json",
        sha256: sha256("native-host-observation")
      },
      observationPath: input.outputPath
    };
  };
}

function asDependencies(value: unknown) {
  return value as ElectronProductionUpdaterTargetProcessObservationDependencies;
}

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}
