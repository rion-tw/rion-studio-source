import { createHash } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { serializeCanonicalJson } from "../scripts/canonicalJson.mjs";
import {
  ELECTRON_PRODUCTION_UPDATER_EVIDENCE_NATIVE_HOST_BINDINGS_KIND,
  ELECTRON_PRODUCTION_UPDATER_EVIDENCE_NATIVE_HOST_LAUNCH_ARGUMENTS_FILE,
  ELECTRON_PRODUCTION_UPDATER_EVIDENCE_NATIVE_HOST_LAUNCH_ARGUMENTS_KIND,
  ELECTRON_PRODUCTION_UPDATER_EVIDENCE_NATIVE_HOST_OBSERVATION_FILE,
  ELECTRON_PRODUCTION_UPDATER_EVIDENCE_NATIVE_HOST_OBSERVATION_KIND,
  observeElectronProductionUpdaterEvidenceNativeHost,
  readElectronProductionUpdaterEvidenceNativeHostObservation,
  type ElectronProductionUpdaterEvidenceDarwinProcessIdentity,
  type ElectronProductionUpdaterEvidenceNativeHostObservationBindings,
  type ElectronProductionUpdaterEvidenceNativeHostPlatform,
  type ElectronProductionUpdaterEvidenceWindowsProcessIdentity
} from "../scripts/electronProductionUpdaterEvidenceNativeHostObservation.mjs";
import {
  ELECTRON_PRODUCTION_UPDATER_EVIDENCE_NATIVE_HOST_CLI_SUMMARY_KIND,
  runElectronProductionUpdaterEvidenceNativeHostObservationCli
} from "../scripts/electronProductionUpdaterEvidenceNativeHostObservationCli.mjs";

const NOW = new Date("2026-09-02T00:18:00.000Z");
const TARGET_VERSION = "8.6.0";
const TARGET_PID = process.pid === 42_420 ? 42_421 : 42_420;
const DARWIN_START_SECONDS = Math.floor(
  Date.parse("2026-09-02T00:01:00.250Z") / 1000
);
const DARWIN_START_MICROSECONDS = 250_000;
const DARWIN_LAUNCH_FENCE = DARWIN_START_SECONDS * 1000;
const WINDOWS_CREATION_MILLISECONDS = Date.parse("2026-09-02T00:01:00.250Z");
const EXECUTABLE_BYTES = Buffer.from("exact target executable\n", "utf8");
const INVENTORY_BYTES = Buffer.from("trusted Darwin process inventory\n", "utf8");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true })
    )
  );
});

describe("Electron production updater native-host observation", () => {
  it.each([
    ["darwin-aarch64", "appkit-chromium", true],
    ["windows-x86_64", "bundled-chromium", false]
  ] as const)(
    "creates and verifies bundle-exact %s native-host evidence",
    async (platform, nativeHostKind, retainedAppKitHost) => {
      const fixture = await createFixture(platform);
      const calls: unknown[] = [];
      const stdout: Buffer[] = [];
      const controller = new AbortController();
      const dependencies = platform === "darwin-aarch64"
        ? {
            hostPlatform: "darwin" as const,
            now: () => new Date(NOW),
            observeDarwinProcess: async (input: unknown) => {
              calls.push(input);
              return { ...fixture.darwinIdentity! };
            }
          }
        : {
            hostPlatform: "win32" as const,
            now: () => new Date(NOW),
            queryWindowsProcess: async (input: unknown) => {
              calls.push(input);
              return { ...fixture.windowsIdentity! };
            }
          };
      const summary =
        await runElectronProductionUpdaterEvidenceNativeHostObservationCli(
          observeArguments(fixture),
          {
            ...dependencies,
            signal: controller.signal,
            writeStdout: (source) => { stdout.push(source); }
          }
        );

      expect(summary).toEqual({
        schemaVersion: 1,
        kind: ELECTRON_PRODUCTION_UPDATER_EVIDENCE_NATIVE_HOST_CLI_SUMMARY_KIND,
        command: "observe",
        status: "observed",
        artifact: {
          bytes: expect.any(Number),
          fileName: ELECTRON_PRODUCTION_UPDATER_EVIDENCE_NATIVE_HOST_OBSERVATION_FILE,
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/u)
        }
      });
      expect(calls).toHaveLength(2);
      expect(calls[0]).toMatchObject({
        processId: TARGET_PID,
        signal: controller.signal
      });
      const verified =
        await readElectronProductionUpdaterEvidenceNativeHostObservation({
          bindings: fixture.bindings,
          expectedSha256: summary.artifact.sha256,
          observationPath: fixture.outputPath
        });
      expect(verified.observation).toEqual({
        schemaVersion: 1,
        kind: ELECTRON_PRODUCTION_UPDATER_EVIDENCE_NATIVE_HOST_OBSERVATION_KIND,
        ...fixture.bindings.context,
        capturedAt: NOW.toISOString(),
        observedAt: new Date(WINDOWS_CREATION_MILLISECONDS).toISOString(),
        runtime: {
          nativeHostKind,
          remoteDebugging: false,
          retainedAppKitHost,
          targetVersionObserved: TARGET_VERSION
        },
        target: fixture.bindings.target,
        targetRunningImageSha256: fixture.bindings.targetRunningImageSha256
      });
      const persisted = JSON.parse(
        await readFile(fixture.outputPath, "utf8")
      ) as Record<string, unknown>;
      expect(Object.keys(persisted).sort()).toEqual([
        "capturedAt",
        "challenge",
        "evidenceAttemptId",
        "kind",
        "observedAt",
        "platform",
        "runtime",
        "schemaVersion",
        "sourceInstallAttemptId",
        "target",
        "targetRunningImageSha256",
        "transitionKind"
      ]);
      expect(JSON.parse(stdout[0].toString("utf8"))).toEqual(summary);

      const verifySummary =
        await runElectronProductionUpdaterEvidenceNativeHostObservationCli([
          "verify",
          "--bindings", fixture.bindingsPath,
          "--observation", fixture.outputPath,
          "--expected-sha256", summary.artifact.sha256
        ], { writeStdout: () => undefined });
      expect(verifySummary).toMatchObject({
        command: "verify",
        status: "verified",
        artifact: summary.artifact
      });
    }
  );

  it.each(["darwin-aarch64", "windows-x86_64"] as const)(
    "rejects %s PID reuse between the two native observations",
    async (platform) => {
      const fixture = await createFixture(platform);
      let calls = 0;
      const dependencies = platform === "darwin-aarch64"
        ? {
            hostPlatform: "darwin" as const,
            now: () => new Date(NOW),
            observeDarwinProcess: async () => {
              calls += 1;
              return calls === 1
                ? { ...fixture.darwinIdentity! }
                : { ...fixture.darwinIdentity!, processUniqueId: "800002" };
            }
          }
        : {
            hostPlatform: "win32" as const,
            now: () => new Date(NOW),
            queryWindowsProcess: async () => {
              calls += 1;
              return calls === 1
                ? { ...fixture.windowsIdentity! }
                : {
                    ...fixture.windowsIdentity!,
                    creationMilliseconds: WINDOWS_CREATION_MILLISECONDS + 1
                  };
            }
          };
      await expect(observeFixture(fixture, dependencies)).rejects.toThrow(
        platform === "darwin-aarch64"
          ? "identity changed between live observations"
          : "creation identity does not match"
      );
      await expect(readFile(fixture.outputPath)).rejects.toMatchObject({ code: "ENOENT" });
    }
  );

  it.each(["darwin-aarch64", "windows-x86_64"] as const)(
    "rejects an observed %s executable path mismatch",
    async (platform) => {
      const fixture = await createFixture(platform);
      const wrongPath = join(fixture.root, "foreign", "Rion Studio.exe");
      const dependencies = platform === "darwin-aarch64"
        ? {
            hostPlatform: "darwin" as const,
            now: () => new Date(NOW),
            observeDarwinProcess: async () => ({
              ...fixture.darwinIdentity!,
              executablePath: wrongPath
            })
          }
        : {
            hostPlatform: "win32" as const,
            now: () => new Date(NOW),
            queryWindowsProcess: async () => ({
              ...fixture.windowsIdentity!,
              executablePath: wrongPath
            })
          };
      await expect(observeFixture(fixture, dependencies)).rejects.toThrow(
        "executable path does not match"
      );
    }
  );

  it("rejects executable and Darwin inventory hash mismatch or mutation", async () => {
    const hashMismatch = await createFixture("darwin-aarch64");
    const mismatchedBindings: ElectronProductionUpdaterEvidenceNativeHostObservationBindings = {
      ...hashMismatch.bindings,
      targetRunningImageSha256: sha256("different executable")
    };
    await rewriteLaunchSeal(hashMismatch, (seal) => {
      seal.targetRunningImageSha256 = mismatchedBindings.targetRunningImageSha256;
    });
    await expect(observeFixture(hashMismatch, darwinDependencies(hashMismatch), {
      bindings: mismatchedBindings
    })).rejects.toThrow("live target executable SHA-256 does not match");

    const executableMutation = await createFixture("darwin-aarch64");
    let executableCalls = 0;
    await expect(observeFixture(executableMutation, {
      hostPlatform: "darwin",
      now: () => new Date(NOW),
      observeDarwinProcess: async () => {
        executableCalls += 1;
        if (executableCalls === 2) {
          await writeFile(executableMutation.executablePath, "tampered executable\n");
          await chmod(executableMutation.executablePath, 0o700);
        }
        return { ...executableMutation.darwinIdentity! };
      }
    })).rejects.toThrow("live target executable changed");

    const inventoryHash = await createFixture("darwin-aarch64");
    const wrongProcess = {
      ...inventoryHash.processBinding,
      inventoryExecutableSha256: sha256("wrong inventory")
    };
    await expect(observeFixture(inventoryHash, darwinDependencies(inventoryHash), {
      processBinding: wrongProcess
    })).rejects.toThrow("inventory executable SHA-256 does not match");

    const inventoryMutation = await createFixture("darwin-aarch64");
    let inventoryCalls = 0;
    await expect(observeFixture(inventoryMutation, {
      hostPlatform: "darwin",
      now: () => new Date(NOW),
      observeDarwinProcess: async () => {
        inventoryCalls += 1;
        if (inventoryCalls === 2) {
          await writeFile(inventoryMutation.inventoryExecutablePath!, "tampered\n");
          await chmod(inventoryMutation.inventoryExecutablePath!, 0o700);
        }
        return { ...inventoryMutation.darwinIdentity! };
      }
    })).rejects.toThrow("inventory executable changed");
  });

  it.each([
    "--remote-debugging-port=9222",
    "/Applications/Rion Studio --remote-debugging-port=9222",
    "--remote-debugging-pipe",
    "--inspect-brk=0",
    "--js-flags=--inspect",
    "--auto-open-devtools-for-tabs"
  ])("rejects forbidden sealed launch flag %s", async (forbiddenFlag) => {
    const fixture = await createFixture("windows-x86_64", [forbiddenFlag]);
    await expect(observeFixture(
      fixture,
      windowsDependencies(fixture)
    )).rejects.toThrow("enable remote debugging or DevTools");
    await expect(readFile(fixture.outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires the explicit retained-AppKit no-substitute claim", async () => {
    const fixture = await createFixture("darwin-aarch64");
    await rewriteLaunchSeal(fixture, (seal) => {
      const claim = seal.hostClaim as Record<string, unknown>;
      claim.browserWindowOnlySubstitute = true;
    });
    await expect(observeFixture(
      fixture,
      darwinDependencies(fixture)
    )).rejects.toThrow("BrowserWindow-only substitute verdict does not match");
  });

  it("rejects a changed launch seal, wrong seal digest, and unknown seal fields", async () => {
    const changed = await createFixture("windows-x86_64");
    let calls = 0;
    await expect(observeFixture(changed, {
      hostPlatform: "win32",
      now: () => new Date(NOW),
      queryWindowsProcess: async () => {
        calls += 1;
        if (calls === 2) {
          await rewriteCanonical(changed.launchArgumentsPath, (value) => {
            (value.arguments as string[]).push("--safe-second-read-change");
          });
        }
        return { ...changed.windowsIdentity! };
      }
    })).rejects.toThrow("launch-arguments seal changed");

    const wrongDigest = await createFixture("windows-x86_64");
    await expect(observeFixture(
      wrongDigest,
      windowsDependencies(wrongDigest),
      { launchArgumentsSha256: "0".repeat(64) }
    )).rejects.toThrow("launch-arguments seal SHA-256 does not match");

    const unknown = await createFixture("windows-x86_64");
    await rewriteLaunchSeal(unknown, (seal) => { seal.timeoutPassed = true; });
    await expect(observeFixture(
      unknown,
      windowsDependencies(unknown)
    )).rejects.toThrow("unexpected schema");
  });

  it("requires caller cancellation and never treats abort as success", async () => {
    const preAborted = await createFixture("windows-x86_64");
    const controller = new AbortController();
    controller.abort(new Error("external liveness ended"));
    let queried = false;
    await expect(observeElectronProductionUpdaterEvidenceNativeHost({
      bindings: preAborted.bindings,
      expectedExecutablePath: preAborted.executablePath,
      launchArgumentsPath: preAborted.launchArgumentsPath,
      launchArgumentsSha256: preAborted.launchArgumentsSha256,
      outputPath: preAborted.outputPath,
      process: preAborted.processBinding,
      signal: controller.signal
    }, {
      hostPlatform: "win32",
      now: () => new Date(NOW),
      queryWindowsProcess: async () => {
        queried = true;
        return { ...preAborted.windowsIdentity! };
      }
    })).rejects.toThrow("external liveness ended");
    expect(queried).toBe(false);

    const midFlight = await createFixture("windows-x86_64");
    const midController = new AbortController();
    await expect(observeFixture(midFlight, {
      hostPlatform: "win32",
      now: () => new Date(NOW),
      queryWindowsProcess: async () => {
        midController.abort(new Error("external deadline closed"));
        return { ...midFlight.windowsIdentity! };
      }
    }, { signal: midController.signal })).rejects.toThrow("external deadline closed");
    await expect(readFile(midFlight.outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("enforces canonical single-link inputs, create-new output, and exact CLI options", async () => {
    const noncanonical = await createFixture("windows-x86_64");
    await writeFile(
      noncanonical.bindingsPath,
      JSON.stringify(noncanonical.bindings)
    );
    await expect(runElectronProductionUpdaterEvidenceNativeHostObservationCli(
      observeArguments(noncanonical),
      {
        ...windowsDependencies(noncanonical),
        signal: new AbortController().signal,
        writeStdout: () => undefined
      }
    )).rejects.toThrow("not canonical JSON");

    const linked = await createFixture("windows-x86_64");
    await link(linked.launchArgumentsPath, `${linked.launchArgumentsPath}.link`);
    await expect(observeFixture(
      linked,
      windowsDependencies(linked)
    )).rejects.toThrow("bounded, nonempty, single-link regular file");

    const existing = await createFixture("windows-x86_64");
    await writeFile(existing.outputPath, "existing");
    await expect(observeFixture(
      existing,
      windowsDependencies(existing)
    )).rejects.toThrow("must be create-new");

    const wrongPlatformOptions = await createFixture("windows-x86_64");
    const argumentsList = observeArguments(wrongPlatformOptions);
    argumentsList.push(
      "--inventory-executable", wrongPlatformOptions.executablePath,
      "--inventory-executable-sha256", sha256(EXECUTABLE_BYTES),
      "--launched-after-milliseconds", String(DARWIN_LAUNCH_FENCE)
    );
    await expect(runElectronProductionUpdaterEvidenceNativeHostObservationCli(
      argumentsList,
      {
        ...windowsDependencies(wrongPlatformOptions),
        signal: new AbortController().signal,
        writeStdout: () => undefined
      }
    )).rejects.toThrow("option set is not exact");

    await expect(runElectronProductionUpdaterEvidenceNativeHostObservationCli([
      "verify",
      "--bindings", wrongPlatformOptions.bindingsPath,
      "--observation", wrongPlatformOptions.outputPath,
      "--timeout", "1000"
    ], { writeStdout: () => undefined })).rejects.toThrow(
      "Unknown native-host verify option --timeout"
    );
  });
});

interface Fixture {
  bindings: ElectronProductionUpdaterEvidenceNativeHostObservationBindings;
  bindingsPath: string;
  darwinIdentity?: ElectronProductionUpdaterEvidenceDarwinProcessIdentity;
  executablePath: string;
  inventoryExecutablePath?: string;
  launchArgumentsPath: string;
  launchArgumentsSha256: string;
  outputPath: string;
  platform: ElectronProductionUpdaterEvidenceNativeHostPlatform;
  processBinding: {
    creationMilliseconds: number;
    platform: "win32";
    processId: number;
  } | {
    inventoryExecutablePath: string;
    inventoryExecutableSha256: string;
    launchedAfterMilliseconds: number;
    platform: "darwin";
    processId: number;
  };
  root: string;
  windowsIdentity?: ElectronProductionUpdaterEvidenceWindowsProcessIdentity;
}

async function createFixture(
  platform: ElectronProductionUpdaterEvidenceNativeHostPlatform,
  launchArguments: readonly string[] = ["--rion-production-evidence"]
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "rion-native-host-observation-"));
  temporaryDirectories.push(root);
  const isDarwin = platform === "darwin-aarch64";
  const executablePath = isDarwin
    ? join(root, "Rion Studio.app", "Contents", "MacOS", "Rion Studio")
    : join(root, "Rion Studio.exe");
  const inventoryExecutablePath = isDarwin
    ? join(root, "native", "packaged-process-inventory")
    : undefined;
  await mkdir(dirname(executablePath), { recursive: true });
  await writeFile(executablePath, EXECUTABLE_BYTES, { mode: 0o700 });
  await chmod(executablePath, 0o700);
  if (inventoryExecutablePath) {
    await mkdir(dirname(inventoryExecutablePath), { recursive: true });
    await writeFile(inventoryExecutablePath, INVENTORY_BYTES, { mode: 0o700 });
    await chmod(inventoryExecutablePath, 0o700);
  }
  const bindings = createBindings(platform);
  const darwinIdentity = isDarwin
    ? createDarwinIdentity(executablePath)
    : undefined;
  const windowsIdentity = isDarwin
    ? undefined
    : createWindowsIdentity(executablePath);
  const launchSeal = {
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_UPDATER_EVIDENCE_NATIVE_HOST_LAUNCH_ARGUMENTS_KIND,
    arguments: [...launchArguments],
    context: bindings.context,
    executablePath,
    hostClaim: {
      browserWindowOnlySubstitute: false,
      htmlChromeSubstitute: false,
      nativeHostKind: isDarwin ? "appkit-chromium" : "bundled-chromium",
      retainedAppKitHost: isDarwin
    },
    process: isDarwin ? darwinIdentity : windowsIdentity,
    target: {
      candidateReceiptSha256: bindings.target.candidateReceiptSha256,
      sourceSha: bindings.target.sourceSha,
      version: bindings.target.version
    },
    targetRunningImageSha256: bindings.targetRunningImageSha256
  };
  const bindingsPath = join(root, "native-host-bindings.json");
  const launchArgumentsPath = join(
    root,
    ELECTRON_PRODUCTION_UPDATER_EVIDENCE_NATIVE_HOST_LAUNCH_ARGUMENTS_FILE
  );
  const outputPath = join(
    root,
    ELECTRON_PRODUCTION_UPDATER_EVIDENCE_NATIVE_HOST_OBSERVATION_FILE
  );
  const launchSource = serializeCanonicalJson(launchSeal);
  await Promise.all([
    writeFile(bindingsPath, serializeCanonicalJson(bindings)),
    writeFile(launchArgumentsPath, launchSource)
  ]);
  return {
    bindings,
    bindingsPath,
    darwinIdentity,
    executablePath,
    inventoryExecutablePath,
    launchArgumentsPath,
    launchArgumentsSha256: sha256(launchSource),
    outputPath,
    platform,
    processBinding: isDarwin
      ? {
          inventoryExecutablePath: inventoryExecutablePath!,
          inventoryExecutableSha256: sha256(INVENTORY_BYTES),
          launchedAfterMilliseconds: DARWIN_LAUNCH_FENCE,
          platform: "darwin",
          processId: TARGET_PID
        }
      : {
          creationMilliseconds: WINDOWS_CREATION_MILLISECONDS,
          platform: "win32",
          processId: TARGET_PID
        },
    root,
    windowsIdentity
  };
}

function createBindings(
  platform: ElectronProductionUpdaterEvidenceNativeHostPlatform
): ElectronProductionUpdaterEvidenceNativeHostObservationBindings {
  const isDarwin = platform === "darwin-aarch64";
  return {
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_UPDATER_EVIDENCE_NATIVE_HOST_BINDINGS_KIND,
    context: {
      challenge: {
        expiresAt: "2026-09-02T12:00:00Z",
        id: "20000000-0000-4000-8000-000000000001",
        issuedAt: "2026-09-02T00:00:00Z",
        nonceSha256: sha256("native-host challenge")
      },
      evidenceAttemptId: "20000000-0000-4000-8000-000000000002",
      platform,
      sourceInstallAttemptId: "update-install-20000000-0000-4000-8000-000000000003",
      transitionKind: "electron-v23-to-electron-v23"
    },
    target: {
      artifactName: isDarwin
        ? "Rion.Studio-mac.app.tar.gz"
        : "Rion.Studio-win.exe",
      artifactSha256: sha256("target artifact"),
      candidateReceiptSha256: sha256("target candidate receipt"),
      embeddedUpdaterEndpoint: "https://updates.example.test/future/latest.json",
      manifestName: "latest.json",
      runtime: "electron-v23",
      servedManifestSha256: sha256("served manifest"),
      signatureName: isDarwin
        ? "Rion.Studio-mac.app.tar.gz.sig"
        : "Rion.Studio-win.exe.sig",
      signatureSha256: sha256("target signature"),
      sourceSha: "a".repeat(40),
      version: TARGET_VERSION
    },
    targetRunningImageSha256: sha256(EXECUTABLE_BYTES)
  };
}

function createDarwinIdentity(
  executablePath: string
): ElectronProductionUpdaterEvidenceDarwinProcessIdentity {
  return {
    auditToken: "ab".repeat(32),
    executablePath,
    parentProcessId: 300,
    parentProcessUniqueId: "700001",
    processGroupId: TARGET_PID,
    processId: TARGET_PID,
    processUniqueId: "800001",
    startMicroseconds: DARWIN_START_MICROSECONDS,
    startSeconds: DARWIN_START_SECONDS,
    userId: 501
  };
}

function createWindowsIdentity(
  executablePath: string
): ElectronProductionUpdaterEvidenceWindowsProcessIdentity {
  return {
    creationMilliseconds: WINDOWS_CREATION_MILLISECONDS,
    executablePath,
    processId: TARGET_PID
  };
}

function darwinDependencies(fixture: Fixture) {
  return {
    hostPlatform: "darwin" as const,
    now: () => new Date(NOW),
    observeDarwinProcess: async () => ({ ...fixture.darwinIdentity! })
  };
}

function windowsDependencies(fixture: Fixture) {
  return {
    hostPlatform: "win32" as const,
    now: () => new Date(NOW),
    queryWindowsProcess: async () => ({ ...fixture.windowsIdentity! })
  };
}

async function observeFixture(
  fixture: Fixture,
  dependencies: Record<string, unknown>,
  overrides: {
    bindings?: ElectronProductionUpdaterEvidenceNativeHostObservationBindings;
    launchArgumentsSha256?: string;
    processBinding?: Fixture["processBinding"];
    signal?: AbortSignal;
  } = {}
) {
  return observeElectronProductionUpdaterEvidenceNativeHost({
    bindings: overrides.bindings ?? fixture.bindings,
    expectedExecutablePath: fixture.executablePath,
    launchArgumentsPath: fixture.launchArgumentsPath,
    launchArgumentsSha256:
      overrides.launchArgumentsSha256 ?? fixture.launchArgumentsSha256,
    outputPath: fixture.outputPath,
    process: overrides.processBinding ?? fixture.processBinding,
    signal: overrides.signal ?? new AbortController().signal
  }, dependencies);
}

function observeArguments(fixture: Fixture): string[] {
  const common = [
    "observe",
    "--bindings", fixture.bindingsPath,
    "--expected-executable", fixture.executablePath,
    "--launch-arguments", fixture.launchArgumentsPath,
    "--launch-arguments-sha256", fixture.launchArgumentsSha256,
    "--output", fixture.outputPath,
    "--process-id", String(TARGET_PID)
  ];
  if (fixture.platform === "darwin-aarch64") {
    return [
      ...common,
      "--inventory-executable", fixture.inventoryExecutablePath!,
      "--inventory-executable-sha256", sha256(INVENTORY_BYTES),
      "--launched-after-milliseconds", String(DARWIN_LAUNCH_FENCE)
    ];
  }
  return [
    ...common,
    "--process-creation-milliseconds", String(WINDOWS_CREATION_MILLISECONDS)
  ];
}

async function rewriteLaunchSeal(
  fixture: Fixture,
  mutate: (value: Record<string, unknown>) => void
) {
  await rewriteCanonical(fixture.launchArgumentsPath, mutate);
  fixture.launchArgumentsSha256 = sha256(await readFile(fixture.launchArgumentsPath));
}

async function rewriteCanonical(
  filePath: string,
  mutate: (value: Record<string, unknown>) => void
) {
  const value = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
  mutate(value);
  await writeFile(filePath, serializeCanonicalJson(value));
}

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}
