import { execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { Cookie, CookiesSetDetails } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  CoreCommand,
  CoreEvent,
  RoleSessionMigrationRecord
} from "../src/shared/generated";
import {
  CoreAddonClient,
  type CoreAddonClientObserver,
  type RawNodeApiCoreBinding,
  type RoleSessionMigrationTargetTransitionInputInternal
} from "../src/electron/core/coreAddonClient";
import type { ChromiumRoleSessionPort } from
  "../src/electron/main/chromiumRoleSessionRegistry";
import {
  ChromiumRuntimeBootstrap,
  type ChromiumRuntimeCorePort
} from "../src/electron/main/chromiumRuntimeBootstrap";
import type { WindowsChromiumTrustedInputRuntimeConfiguration } from
  "../src/electron/main/windowsChromiumTrustedInputRuntime";

type RuntimePlatform = "darwin" | "win32";

interface NativeAppCoreOptions {
  readonly userDataDir: string;
  readonly platform: RuntimePlatform;
  readonly appVersion: string;
  readonly packaged: boolean;
  readonly runtimeContractVersion: number;
}

interface NativeAddon {
  createAppCore: (
    options: NativeAppCoreOptions
  ) => Promise<RawNodeApiCoreBinding>;
}

interface InstrumentationOptions {
  dropFirstBeginAcknowledgement?: boolean;
  dropFirstTargetTransitionAcknowledgementAt?: "verifying" | "v23Ready";
}

interface TargetTransitionCallObservation {
  readonly acknowledgement: "dropped" | "returned";
  readonly committedJson: string;
  readonly inputJson: string;
  readonly nextPhase: string;
}

interface InstrumentedCore {
  readonly client: CoreAddonClient;
  readonly core: ChromiumRuntimeCorePort;
  readonly observerErrors: unknown[];
  readonly targetTransitionCalls: TargetTransitionCallObservation[];
}

const executeFile = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const runtimePlatform = process.platform as RuntimePlatform;
const migrationPlatform = runtimePlatform === "darwin" ? "macos" : "windows";
const fixtureBinary = join(
  repositoryRoot,
  "target",
  "debug",
  `rion-node-native-integration-fixture${runtimePlatform === "win32" ? ".exe" : ""}`
);
const addonPath = join(
  repositoryRoot,
  "build",
  "native",
  `${runtimePlatform}-${process.arch}`,
  "rion-core.node"
);
const require = createRequire(import.meta.url);
const activeDirectories = new Set<string>();
const activeRuntimes = new Set<ChromiumRuntimeBootstrap>();
const activeClients = new Set<CoreAddonClient>();

afterEach(async () => {
  for (const runtime of [...activeRuntimes].reverse()) {
    await runtime.shutdown().catch(() => undefined);
  }
  activeRuntimes.clear();
  for (const client of [...activeClients].reverse()) {
    await client.shutdown().catch(() => undefined);
  }
  activeClients.clear();
  for (const directory of activeDirectories) {
    await rm(directory, { recursive: true, force: true });
  }
  activeDirectories.clear();
});

function nativeAddon(): NativeAddon {
  return require(addonPath) as NativeAddon;
}

async function seedExportedMigration(): Promise<Readonly<{
  directory: string;
  exported: RoleSessionMigrationRecord;
}>> {
  const directory = await mkdtemp(join(tmpdir(), "rion-native-integration-"));
  activeDirectories.add(directory);
  const result = await executeFile(
    fixtureBinary,
    [directory, runtimePlatform],
    { encoding: "utf8" }
  );
  const output = result.stdout.trim().split(/\r?\n/u).at(-1);
  if (!output) throw new Error(`Fixture produced no record: ${result.stderr}`);
  return Object.freeze({
    directory,
    exported: JSON.parse(output) as RoleSessionMigrationRecord
  });
}

function instrumentBinding(
  binding: RawNodeApiCoreBinding,
  order: string[],
  options: InstrumentationOptions,
  targetTransitionCalls: TargetTransitionCallObservation[]
): RawNodeApiCoreBinding {
  let dropBeginAcknowledgement = options.dropFirstBeginAcknowledgement ?? false;
  let dropTargetTransitionAcknowledgementAt =
    options.dropFirstTargetTransitionAcknowledgementAt;
  return new Proxy(binding, {
    get(target, property, receiver) {
      if (property === "invoke") {
        return async (commandJson: string): Promise<string> => {
          const command = JSON.parse(commandJson) as { type?: string };
          order.push(`invoke:${command.type ?? "unknown"}`);
          return target.invoke.call(target, commandJson);
        };
      }
      if (property === "beginRoleSessionMigrationImportInternal") {
        return async (inputJson: string): Promise<string> => {
          order.push("napi-begin-enter");
          const committed = await target.beginRoleSessionMigrationImportInternal.call(
            target,
            inputJson
          );
          order.push("napi-begin-resolved");
          if (dropBeginAcknowledgement) {
            dropBeginAcknowledgement = false;
            throw new Error("native integration fixture dropped the committed begin ACK");
          }
          return committed;
        };
      }
      if (property === "transitionRoleSessionMigrationTargetInternal") {
        return async (inputJson: string): Promise<string> => {
          const input = JSON.parse(inputJson) as { nextPhase?: unknown };
          const nextPhase = typeof input.nextPhase === "string"
            ? input.nextPhase
            : "unknown";
          const label = `napi-transition:${nextPhase}`;
          order.push(`${label}:enter`);
          const committed = await target
            .transitionRoleSessionMigrationTargetInternal.call(target, inputJson);
          order.push(`${label}:committed`);
          if (dropTargetTransitionAcknowledgementAt === nextPhase) {
            dropTargetTransitionAcknowledgementAt = undefined;
            targetTransitionCalls.push(Object.freeze({
              acknowledgement: "dropped",
              committedJson: committed,
              inputJson,
              nextPhase
            }));
            order.push(`${label}:ack-dropped`);
            throw new Error(
              `native integration fixture dropped the committed ${nextPhase} ACK`
            );
          }
          targetTransitionCalls.push(Object.freeze({
            acknowledgement: "returned",
            committedJson: committed,
            inputJson,
            nextPhase
          }));
          order.push(`${label}:resolved`);
          return committed;
        };
      }
      if (property === "readRoleSessionTransferVaultInternal") {
        return async (roleId: string, transferId: string): Promise<Buffer> => {
          order.push("napi-vault-read");
          return target.readRoleSessionTransferVaultInternal.call(
            target,
            roleId,
            transferId
          );
        };
      }
      if (property === "recoverPendingChromeProfileImportsInternal") {
        return async (): Promise<string> => {
          order.push("napi-chrome-profile-recovery-enter");
          const recovered = await target.recoverPendingChromeProfileImportsInternal.call(target);
          order.push("napi-chrome-profile-recovery-resolved");
          return recovered;
        };
      }
      if (property === "subscribeCoreEvents") {
        return (
          listener: (eventsJson: string) => void,
          failureListener: (failureJson: string) => void
        ): void => {
          order.push("napi-subscribe-raw");
          target.subscribeCoreEvents.call(target, listener, failureListener);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

async function createCore(
  directory: string,
  platform: RuntimePlatform,
  order: string[],
  options: InstrumentationOptions = {}
): Promise<InstrumentedCore> {
  const addon = nativeAddon();
  const observerErrors: unknown[] = [];
  const observer: CoreAddonClientObserver = {
    onEventBridgeError: (error) => observerErrors.push(error)
  };
  const targetTransitionCalls: TargetTransitionCallObservation[] = [];
  const client = await CoreAddonClient.create({
    createAppCore: async (coreOptions: NativeAppCoreOptions) =>
      instrumentBinding(
        await addon.createAppCore(coreOptions),
        order,
        options,
        targetTransitionCalls
      )
  }, {
    userDataDir: directory,
    platform,
    appVersion: "23.0.0-native-integration",
    packaged: false,
    runtimeContractVersion: 23
  }, observer);
  activeClients.add(client);
  const core = new Proxy(client, {
    get(target, property, receiver) {
      if (property === "subscribeCoreEvents") {
        return (listener: (event: CoreEvent) => void): (() => void) => {
          order.push("subscribe-local");
          return target.subscribeCoreEvents(listener);
        };
      }
      if (property === "startCoreEventBridge") {
        return (): void => {
          order.push("start-core-event-bridge");
          target.startCoreEventBridge();
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    }
  }) as ChromiumRuntimeCorePort;
  return { client, core, observerErrors, targetTransitionCalls };
}

function createNativePorts() {
  let cookies: Cookie[] = [];
  let storagePath: string | null = null;
  const session = {
    on: vi.fn(),
    cookies: {
      flushStore: vi.fn(async () => undefined),
      get: vi.fn(async () => [...cookies]),
      set: vi.fn(async (details: CookiesSetDetails) => {
        const url = new URL(details.url);
        cookies = [{
          name: details.name ?? "",
          value: details.value ?? "",
          domain: details.domain ?? url.hostname,
          hostOnly: details.domain === undefined,
          path: details.path ?? "/",
          secure: details.secure ?? false,
          httpOnly: details.httpOnly ?? false,
          session: details.expirationDate === undefined,
          ...(details.expirationDate === undefined
            ? {}
            : { expirationDate: details.expirationDate }),
          sameSite: details.sameSite ?? "lax"
        }];
      })
    },
    clearStorageData: vi.fn(async () => { cookies = []; }),
    flushStorageData: vi.fn(),
    protocol: { handle: vi.fn(), unhandle: vi.fn() },
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    setDevicePermissionHandler: vi.fn(),
    setDisplayMediaRequestHandler: vi.fn(),
    setBluetoothPairingHandler: vi.fn()
  } as unknown as ChromiumRoleSessionPort;
  Object.defineProperty(session, "storagePath", {
    configurable: false,
    enumerable: true,
    get: () => storagePath
  });
  return {
    ipcMain: {
      handle: vi.fn(),
      removeHandler: vi.fn()
    },
    sessions: {
      fromPath: vi.fn((path: string) => {
        if (storagePath !== null && storagePath !== path) {
          throw new Error("The native integration fixture received a second session path.");
        }
        storagePath = path;
        return session;
      })
    },
    views: {
      create: vi.fn(() => {
        throw new Error("The non-UI native integration fixture cannot create a visible surface.");
      })
    }
  };
}

function windowsTrustedInput(): WindowsChromiumTrustedInputRuntimeConfiguration {
  return {
    addon: {
      windowsChromiumInputProbeAbiVersion: () => 5,
      attachWindowsChromiumInputHwnd: () => {
        throw new Error("The fixture has no attached Windows input surface.");
      },
      projectWindowsChromiumInputHwnd: () => {
        throw new Error("The fixture has no attached Windows input surface.");
      },
      probeWindowsChromiumInputHwnd: () => {
        throw new Error("The fixture has no attached Windows input surface.");
      },
      submitWindowsChromiumBackgroundKey: () => {
        throw new Error("The fixture cannot submit Windows input.");
      },
      submitWindowsChromiumBackgroundMouse: () => {
        throw new Error("The fixture cannot submit Windows input.");
      }
    },
    baseWindows: {
      create: () => {
        throw new Error("The fixture cannot create a Windows input host.");
      }
    },
    deadlines: {
      schedule: () => 1,
      cancel: () => undefined
    },
    ipcMain: {
      on: () => undefined,
      removeListener: () => undefined
    }
  };
}

function windowsBootstrapPorts() {
  return {
    browserWindows: {
      create: () => {
        throw new Error("The non-UI native integration fixture cannot create BrowserWindow.");
      }
    },
    displays: {
      displayMatching: () => {
        throw new Error("The fixture has no visible Windows runtime host.");
      }
    },
    displayTopology: () => {
      throw new Error("The fixture has no visible Windows display projection.");
    },
    lifecycleEpoch: () => 1,
    runtimeShortcutOwner: {
      acknowledgeWindowsRuntimeShortcutOwner: () => {
        throw new Error("Windows shortcut ownership is unavailable on macOS");
      },
      registerWindowsRuntimeShortcutOwner: () => {
        throw new Error("The fixture has no visible Windows runtime shortcut host.");
      },
      unregisterWindowsRuntimeShortcutOwner: () => {
        throw new Error("The fixture has no visible Windows runtime shortcut host.");
      }
    },
    runtimeDocumentPath: "C:\\Rion\\out\\runtime-windows-host.html",
    runtimeHostPreloadPath: "C:\\Rion\\out\\preload\\runtimeWindowsHost.cjs",
    onWindowControl: async () => {
      throw new Error("The fixture has no visible Windows runtime host.");
    },
    trustedInput: windowsTrustedInput()
  };
}

async function startRuntime(
  core: ChromiumRuntimeCorePort,
  platform: RuntimePlatform
): Promise<ChromiumRuntimeBootstrap> {
  const native = createNativePorts();
  const runtime = await ChromiumRuntimeBootstrap.start({
    core,
    platform,
    electronVersion: "43.4.1",
    chromiumVersion: "150.0.7871.224",
    rolePreloadPath: platform === "darwin"
      ? "/Rion/out/preload/role.cjs"
      : "C:\\Rion\\out\\preload\\role.cjs",
    ...native,
    ...(platform === "win32" ? { windows: windowsBootstrapPorts() } : {}),
    onError: (error) => { throw error; }
  });
  activeRuntimes.add(runtime);
  return runtime;
}

function position(order: readonly string[], value: string): number {
  const index = order.indexOf(value);
  expect(index, `missing ordered boundary ${value}`).toBeGreaterThanOrEqual(0);
  return index;
}

function coreErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]*$/u.test(code)) return code;
  }
  const message = error instanceof Error ? error.message : String(error);
  try {
    return (JSON.parse(message) as { code?: string }).code;
  } catch {
    return /"code"\s*:\s*"([A-Z0-9_]+)"/u.exec(message)?.[1];
  }
}

async function expectCoreError(
  promise: Promise<unknown>,
  expectedCode: string
): Promise<void> {
  let observed: unknown;
  try {
    await promise;
  } catch (error) {
    observed = error;
  }
  expect(observed).toBeDefined();
  expect(coreErrorCode(observed)).toBe(expectedCode);
}

describe("real native Core startup integration", () => {
  it("dispatches a retired tab close through the real asynchronous Node-API boundary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rion-native-tab-stop-"));
    activeDirectories.add(directory);
    const binding = await nativeAddon().createAppCore({
      userDataDir: directory, platform: runtimePlatform, appVersion: "23.0.0-test",
      packaged: false, runtimeContractVersion: 23
    });
    try {
      binding.subscribeCoreEvents(() => {}, () => {});
      const result = JSON.parse(await binding.invoke(JSON.stringify({
        type: "embeddedTabStop", sourceId: "retired-workspace", tabType: "workspace",
        request: { operationId: "retired-tab-stop", mutationKind: "stop", tabId: "retired-tab",
          sourceWindowId: "retired-window", sourceWindowGeneration: 7, lifecycleEpoch: 3 }
      })));
      expect(result.tabs).toEqual([]);
      expect(result.windows).toEqual([]);
    } finally {
      await binding.shutdown();
    }
  });

  it("admits one exact exported journal before registration and the raw bridge", async () => {
    const { directory, exported } = await seedExportedMigration();
    const order: string[] = [];
    const { client, core, observerErrors } = await createCore(
      directory,
      runtimePlatform,
      order
    );
    const runtime = await startRuntime(core, runtimePlatform);

    expect(exported).toMatchObject({
      phase: "exported",
      platform: migrationPlatform,
      targetEngine: "chromium",
      cookieCount: 0,
      localStorageOriginCount: 0,
      localStorageEntryCount: 0
    });
    expect(runtime.sessionMigrationResume.eligibleRoleCount).toBe(1);
    expect(runtime.sessionMigrationResume.results).toEqual([
      expect.objectContaining({
        status: "v23-ready",
        journal: expect.objectContaining({
          roleId: exported.roleId,
          transferId: exported.transferId,
          phase: "v23Ready",
          journalRevision: exported.journalRevision + 3,
          targetRevision: 1,
          envelopeSha256: exported.envelopeSha256,
          inventorySha256: exported.inventorySha256,
          outcome: "verified"
        })
      })
    ]);
    const resumeResult = runtime.sessionMigrationResume.results[0];
    if (resumeResult?.status !== "v23-ready") {
      throw new Error("The exact native migration did not reach v23-ready.");
    }
    const durable = await client.invoke({
      type: "roleSessionMigrationGet",
      roleId: exported.roleId
    });
    expect(durable).toEqual(resumeResult.journal);

    expect(position(order, "invoke:roleSessionMigrationsList"))
      .toBeLessThan(position(order, "napi-begin-enter"));
    expect(position(order, "napi-begin-resolved"))
      .toBeLessThan(position(order, "napi-vault-read"));
    expect(position(order, "napi-vault-read"))
      .toBeLessThan(position(order, "napi-transition:verifying:resolved"));
    expect(position(order, "napi-transition:verifying:resolved"))
      .toBeLessThan(position(order, "napi-transition:v23Ready:resolved"));
    expect(position(order, "napi-transition:v23Ready:resolved"))
      .toBeLessThan(position(order, "invoke:browserRuntimeRegister"));
    expect(position(order, "invoke:browserRuntimeRegister"))
      .toBeLessThan(position(order, "subscribe-local"));
    expect(position(order, "subscribe-local"))
      .toBeLessThan(position(order, "start-core-event-bridge"));
    expect(position(order, "start-core-event-bridge"))
      .toBeLessThan(position(order, "napi-subscribe-raw"));
    expect(position(order, "napi-subscribe-raw"))
      .toBeLessThan(position(order, "napi-chrome-profile-recovery-enter"));
    expect(position(order, "napi-chrome-profile-recovery-enter"))
      .toBeLessThan(position(order, "napi-chrome-profile-recovery-resolved"));
    expect(runtime.chromeProfileImportRecovery).toEqual({ recovered: 0, pending: 0 });
    expect(order.filter((value) => value === "napi-subscribe-raw")).toHaveLength(1);

    let unsubscribe: () => void = () => undefined;
    const delivered = new Promise<CoreEvent>((resolve) => {
      unsubscribe = client.subscribeCoreEvents((event) => {
        if (event.type === "stateChanged" && event.changedCollections.includes("games")) {
          resolve(event);
        }
      });
    });
    await client.invoke({
      type: "gameCreate",
      input: {
        name: "Native bridge event probe",
        defaultLaunchUrl: "https://example.test/bridge"
      }
    });
    await expect(delivered).resolves.toMatchObject({ type: "stateChanged" });
    unsubscribe();
    expect(observerErrors).toEqual([]);
  });

  it("replays a committed begin exactly after its acknowledgement is unknown", async () => {
    const { directory, exported } = await seedExportedMigration();
    const firstOrder: string[] = [];
    const first = await createCore(directory, runtimePlatform, firstOrder, {
      dropFirstBeginAcknowledgement: true
    });
    const firstRuntime = await startRuntime(first.core, runtimePlatform);

    expect(firstRuntime.sessionMigrationResume.results).toEqual([
      expect.objectContaining({
        status: "pending",
        stableErrorCode: "CHROMIUM_SESSION_MIGRATION_IMPORT_BEGIN_INDETERMINATE",
        lastKnownJournal: exported
      })
    ]);
    const committed = await first.client.invoke({
      type: "roleSessionMigrationGet",
      roleId: exported.roleId
    });
    expect(committed).toMatchObject({
      phase: "importing",
      journalRevision: exported.journalRevision + 1,
      targetRevision: 1
    });
    const replayed = await first.client.beginRoleSessionMigrationImportInternal({
      roleId: exported.roleId,
      transferId: exported.transferId,
      expectedJournalRevision: exported.journalRevision
    });
    expect(replayed).toEqual(committed);
    expect(firstOrder.filter((value) => value === "napi-begin-enter")).toHaveLength(2);

    await firstRuntime.shutdown();
    activeRuntimes.delete(firstRuntime);
    await first.client.shutdown();
    activeClients.delete(first.client);
    const restartOrder: string[] = [];
    const restarted = await createCore(directory, runtimePlatform, restartOrder);
    const restartedRuntime = await startRuntime(restarted.core, runtimePlatform);
    expect(restartedRuntime.sessionMigrationResume.results).toEqual([
      expect.objectContaining({
        status: "v23-ready",
        journal: expect.objectContaining({
          phase: "v23Ready",
          targetRevision: 1
        })
      })
    ]);
    expect(restartOrder).not.toContain("napi-begin-enter");
    expect(restarted.observerErrors).toEqual([]);
  });

  it("replays a committed verifying transition exactly and converges after restart", async () => {
    const { directory, exported } = await seedExportedMigration();
    const firstOrder: string[] = [];
    const first = await createCore(directory, runtimePlatform, firstOrder, {
      dropFirstTargetTransitionAcknowledgementAt: "verifying"
    });
    const firstRuntime = await startRuntime(first.core, runtimePlatform);

    expect(firstRuntime.sessionMigrationResume.results).toEqual([
      expect.objectContaining({
        status: "pending",
        stableErrorCode: "CHROMIUM_SESSION_MIGRATION_RESUME_TRANSITION_INDETERMINATE",
        lastKnownJournal: expect.objectContaining({
          phase: "importing",
          journalRevision: exported.journalRevision + 1,
          targetRevision: 1
        })
      })
    ]);
    const canonicalReceipt =
      `chromium-cookie-flush:${exported.transferId}:1`;
    const committed = await first.client.invoke({
      type: "roleSessionMigrationGet",
      roleId: exported.roleId
    });
    expect(committed).toMatchObject({
      phase: "verifying",
      journalRevision: exported.journalRevision + 2,
      targetRevision: 1,
      cleanFlushReceiptId: canonicalReceipt
    });
    const dropped = first.targetTransitionCalls.find(
      (call) => call.acknowledgement === "dropped"
    );
    expect(dropped).toMatchObject({
      acknowledgement: "dropped",
      nextPhase: "verifying"
    });
    if (!dropped) throw new Error("The verifying transition ACK was not dropped.");
    expect(JSON.parse(dropped.committedJson)).toEqual(committed);
    const replayInput = JSON.parse(
      dropped.inputJson
    ) as RoleSessionMigrationTargetTransitionInputInternal;
    const replayed = await first.client
      .transitionRoleSessionMigrationTargetInternal(replayInput);
    const replayObservation = first.targetTransitionCalls.at(-1);

    expect(replayInput.transitionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
    );
    expect(replayObservation).toMatchObject({
      acknowledgement: "returned",
      inputJson: dropped.inputJson,
      committedJson: dropped.committedJson,
      nextPhase: "verifying"
    });
    expect(replayed).toEqual(committed);
    expect(await first.client.invoke({
      type: "roleSessionMigrationGet",
      roleId: exported.roleId
    })).toEqual(committed);
    expect(firstOrder.filter((value) => value === "napi-begin-enter"))
      .toHaveLength(1);
    expect(firstOrder).toContain("napi-transition:verifying:ack-dropped");

    await firstRuntime.shutdown();
    activeRuntimes.delete(firstRuntime);
    await first.client.shutdown();
    activeClients.delete(first.client);
    const restartOrder: string[] = [];
    const restarted = await createCore(directory, runtimePlatform, restartOrder);
    const restartedRuntime = await startRuntime(restarted.core, runtimePlatform);
    expect(restartedRuntime.sessionMigrationResume.results).toEqual([
      expect.objectContaining({
        status: "v23-ready",
        journal: expect.objectContaining({
          phase: "v23Ready",
          journalRevision: exported.journalRevision + 3,
          targetRevision: 1,
          cleanFlushReceiptId: canonicalReceipt,
          outcome: "verified"
        })
      })
    ]);
    expect(restartOrder).not.toContain("napi-begin-enter");
    expect(position(restartOrder, "napi-vault-read"))
      .toBeLessThan(position(restartOrder, "napi-transition:v23Ready:resolved"));
    const durableReady = await restarted.client.invoke({
      type: "roleSessionMigrationGet",
      roleId: exported.roleId
    });
    expect(durableReady).toMatchObject({
      phase: "v23Ready",
      cleanFlushReceiptId: canonicalReceipt
    });
    expect(restarted.observerErrors).toEqual([]);
  });

  it("replays a committed v23-ready transition exactly after its ACK is lost", async () => {
    const { directory, exported } = await seedExportedMigration();
    const firstOrder: string[] = [];
    const first = await createCore(directory, runtimePlatform, firstOrder, {
      dropFirstTargetTransitionAcknowledgementAt: "v23Ready"
    });
    const firstRuntime = await startRuntime(first.core, runtimePlatform);

    expect(firstRuntime.sessionMigrationResume.results).toEqual([
      expect.objectContaining({
        status: "pending",
        stableErrorCode: "CHROMIUM_SESSION_MIGRATION_RESUME_TRANSITION_INDETERMINATE",
        lastKnownJournal: expect.objectContaining({ phase: "verifying" })
      })
    ]);
    const canonicalReceipt =
      `chromium-cookie-flush:${exported.transferId}:1`;
    const committed = await first.client.invoke({
      type: "roleSessionMigrationGet",
      roleId: exported.roleId
    });
    expect(committed).toMatchObject({
      phase: "v23Ready",
      journalRevision: exported.journalRevision + 3,
      cleanFlushReceiptId: canonicalReceipt,
      outcome: "verified"
    });
    const dropped = first.targetTransitionCalls.find(
      (call) => call.acknowledgement === "dropped"
    );
    if (!dropped) throw new Error("The v23-ready transition ACK was not dropped.");
    expect(dropped.nextPhase).toBe("v23Ready");
    expect(JSON.parse(dropped.committedJson)).toEqual(committed);
    const replayInput = JSON.parse(
      dropped.inputJson
    ) as RoleSessionMigrationTargetTransitionInputInternal;
    expect(await first.client.transitionRoleSessionMigrationTargetInternal(replayInput))
      .toEqual(committed);
    expect(first.targetTransitionCalls.at(-1)).toMatchObject({
      acknowledgement: "returned",
      inputJson: dropped.inputJson,
      committedJson: dropped.committedJson,
      nextPhase: "v23Ready"
    });
    expect(await first.client.invoke({
      type: "roleSessionMigrationGet",
      roleId: exported.roleId
    })).toEqual(committed);

    await firstRuntime.shutdown();
    activeRuntimes.delete(firstRuntime);
    await first.client.shutdown();
    activeClients.delete(first.client);
    const restartOrder: string[] = [];
    const restarted = await createCore(directory, runtimePlatform, restartOrder);
    const restartedRuntime = await startRuntime(restarted.core, runtimePlatform);
    expect(restartedRuntime.sessionMigrationResume).toEqual({
      eligibleRoleCount: 0,
      results: []
    });
    expect(restartOrder).not.toContain("napi-begin-enter");
    expect(restartOrder.some((value) => value.startsWith("napi-transition:")))
      .toBe(false);
    expect(await restarted.client.invoke({
      type: "roleSessionMigrationGet",
      roleId: exported.roleId
    })).toEqual(committed);
  });

  it("rejects caller-owned host context before disk access and both CAS bypass surfaces", async () => {
    const { directory, exported } = await seedExportedMigration();
    const oppositePlatform = runtimePlatform === "darwin" ? "win32" : "darwin";
    const rejectedDirectory = join(directory, "rejected-core");
    const addon = nativeAddon();
    await expect(CoreAddonClient.create(
      addon,
      {
        userDataDir: rejectedDirectory,
        platform: oppositePlatform,
        appVersion: "23.0.0-native-integration",
        packaged: false,
        runtimeContractVersion: 23
      }
    )).rejects.toMatchObject({ code: "CORE_HOST_PLATFORM_MISMATCH" });
    await expectCoreError(
      addon.createAppCore({
        userDataDir: rejectedDirectory,
        platform: runtimePlatform,
        appVersion: "23.0.0-native-integration",
        packaged: false,
        runtimeContractVersion: 22
      }),
      "CORE_RUNTIME_CONTRACT_MISMATCH"
    );
    await expect(access(rejectedDirectory)).rejects.toBeDefined();

    const current = await createCore(directory, runtimePlatform, []);
    const bypass: RoleSessionMigrationTargetTransitionInputInternal = {
      roleId: exported.roleId,
      transferId: exported.transferId,
      transitionId: "30000000-0000-4000-8000-000000000102",
      expectedPhase: "exported",
      expectedJournalRevision: exported.journalRevision,
      nextPhase: "importing",
      occurredAt: exported.updatedAt
    };
    await expectCoreError(
      current.client.transitionRoleSessionMigrationTargetInternal(bypass),
      "ROLE_SESSION_MIGRATION_TRANSITION_INVALID"
    );
    await expectCoreError(
      current.client.invoke({
        type: "roleSessionMigrationTransition",
        input: bypass
      } as unknown as CoreCommand),
      "CORE_INPUT_INVALID"
    );
    expect(await current.client.invoke({
      type: "roleSessionMigrationGet",
      roleId: exported.roleId
    })).toEqual(exported);
  });
});
