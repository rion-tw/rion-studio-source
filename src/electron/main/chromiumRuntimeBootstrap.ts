import type {
  BrowserRuntimeRegistrationRecord,
  CoreCommand,
  CoreCommandResult,
  DisplayTopologySnapshotRecord,
  EngineCapabilitySnapshotRecord,
  RoleSessionMigrationRecord
} from "../../shared/generated";
import { normalizeRionBridgeError, RionBridgeError } from "../ipc/errors";
import {
  ChromiumRoleSessionRegistry,
  type ChromiumSessionFactoryPort
} from "./chromiumRoleSessionRegistry";
import { ChromiumGlobalWebSessionRegistry } from
  "./chromiumGlobalWebSessionRegistry";
import { ChromiumSessionOwnershipLedger } from
  "./chromiumSessionOwnershipLedger";
import { ChromiumRoleBrowserDataClearCoordinator } from
  "./chromiumRoleBrowserDataClearCoordinator";
import { ChromiumGlobalWebBrowserDataClearCoordinator } from
  "./chromiumGlobalWebBrowserDataClearCoordinator";
import {
  ChromiumSessionMigrationImporter,
  type ChromiumSessionMigrationCorePort
} from "./chromiumSessionMigrationImporter";
import {
  ChromiumSessionMigrationResumeCoordinator,
  type ChromiumSessionMigrationResumeStartResult
} from "./chromiumSessionMigrationResumeCoordinator";
import type { ChromiumWebContentsViewFactoryPort } from "./chromiumRoleSurfacePorts";
import type { ChromiumRoleSurfaceNativeAttachmentPort } from
  "./chromiumRoleSurfacePorts";
import { ChromiumRoleSurfaceRegistry } from "./chromiumRoleSurfaceRegistry";
import type { ChromiumRoleOverlayFrameIdentity } from
  "./chromiumRoleSurfaceRegistry";
import {
  ChromiumGlobalWebSurfaceRegistry,
  type ChromiumGlobalWebNativeAttachmentPort
} from "./chromiumGlobalWebSurfaceRegistry";
import {
  ChromiumGlobalWebPresentationRegistry,
  type ChromiumWorkspaceWebChromeShellInput
} from "./chromiumGlobalWebPresentationRegistry";
import {
  ChromiumRuntimeEffectExecutor,
  type ChromiumRuntimeExecutorSnapshot,
  type ChromiumRuntimeShellEffectsPort,
  type ChromiumRuntimeTrustedInputPort
} from "./chromiumRuntimeEffectExecutor";
import type { ChromiumRuntimeFullscreenToolbarInspection } from
  "./chromiumRuntimeFullscreenToolbar";
import {
  ChromiumRoleOverlayCoordinator,
  type ChromiumRoleOverlayIpcMainPort
} from "./chromiumRoleOverlayCoordinator";
import { ChromiumRoleFontsCoordinator } from
  "./chromiumRoleFontsCoordinator";
import {
  ChromiumPlatformRuntimeHostFactory,
  type MacosAppKitRuntimeHostFactoryPort,
  type WindowsBrowserWindowFactoryPort,
  type WindowsRuntimeForegroundProbePort,
  type WindowsRuntimeHostDisplayResolverPort
} from "./chromiumRuntimeHostFactory";
import { ChromiumRuntimeLayoutResolver } from "./chromiumRuntimeLayoutResolver";
import type { ChromiumRuntimeNativeTabAction } from
  "./chromiumRuntimeNativeWindowController";
import {
  CoreEffectCoordinator,
  createCoreEffectProcessReceiptLedger,
  type CoreEffectEventStreamFailureTerminal,
  type ElectronCoreEffectPort
} from "./coreEffectCoordinator";
import {
  ChromeProfileImportCoordinator,
  type ChromeProfileImportCoordinatorCorePort
} from "./chromeProfileImportCoordinator";
import type { MacosAppKitRendererActionPort } from
  "./macosAppKitRuntimeEventBridge";
import { ChromiumPopupLifecycleCoordinator } from
  "./chromiumPopupLifecycleCoordinator";
import {
  createWindowsChromiumTrustedInputRuntime,
  type WindowsChromiumTrustedInputRuntimeConfiguration
} from "./windowsChromiumTrustedInputRuntime";
import { ChromiumAutomaticInputContextCoordinator } from
  "./chromiumAutomaticInputContextCoordinator";
import type { ChromiumTrustedInputRecoveryProof } from
  "./chromiumTrustedInputCoordinator";
import { ChromiumManagedShortcutCoordinator } from
  "./chromiumManagedShortcutCoordinator";
import {
  ChromiumRuntimeRolePlaceholderRegistry,
  type ChromiumRuntimeRolePlaceholderShellInput
} from "./chromiumRuntimeRolePlaceholderRegistry";
import type {
  RuntimeRolePlaceholderClaimReceipt,
  RuntimeRolePlaceholderState
} from "../../shared/runtimeRolePlaceholder";
import { ChromiumRoleNavigationFailureReporter } from
  "./chromiumRoleNavigationFailureReporter";
import { ChromiumWorkspaceWebNavigationFailureReporter } from
  "./chromiumWorkspaceWebNavigationFailureReporter";
import { WindowsChromiumHeldKeyContinuityCoordinator } from
  "./windowsChromiumHeldKeyContinuityCoordinator";
import type {
  ChromeProfileImportRecoveryResultInternal,
  RoleSessionMigrationImportBeginInputInternal,
  RoleSessionMigrationTargetTransitionInputInternal,
  WindowsChromiumHeldKeyContinuityInputInternal,
  WindowsChromiumHeldKeyContinuityReceiptInternal
} from "../core/coreAddonClient";
import {
  WindowsRuntimeWindowPlacementController,
  type WindowsRuntimeWindowPlacementInspection
} from "./windowsRuntimeWindowPlacementController";
import { ChromiumRoleReloadCoordinator } from
  "./chromiumRoleReloadCoordinator";
import { executeControlledRuntimeTabReload } from
  "./controlledRuntimeTabReload";

export const ELECTRON_CHROMIUM_RUNTIME_CONTRACT_VERSION = 23;
const processCoreEffectReceiptLedger = createCoreEffectProcessReceiptLedger();

export function withElectronChromiumRuntimeContract<Options extends object>(
  options: Options
): Readonly<Options & { runtimeContractVersion: 23 }> {
  return Object.freeze({
    ...options,
    runtimeContractVersion: ELECTRON_CHROMIUM_RUNTIME_CONTRACT_VERSION
  });
}

const CAPABILITY_KEYS = [
  "navigation",
  "persistentSession",
  "trustedInput",
  "backgroundInput",
  "frameEvaluation",
  "popup",
  "audioMute",
  "customFonts",
  "downloads",
  "fileUpload",
  "permissions",
  "dialogs",
  "certificateHandling"
] as const satisfies ReadonlyArray<keyof EngineCapabilitySnapshotRecord>;

/**
 * Exact capability evidence for this bootstrap slice.
 *
 * Navigation and persistent sessions have authoritative Electron events and
 * storage-flush coverage. Audio is Core-owned, owner-generation-fenced, applied
 * with exact Chromium readback, and compensates both native and logical state.
 * Custom fonts use a bounded Core payload plus exact role-generation/document
 * application receipts; the remote page receives data but no privileged API.
 */
export const WINDOWS_CHROMIUM_BOOTSTRAP_CAPABILITIES = Object.freeze({
  navigation: "supported",
  persistentSession: "supported",
  trustedInput: "supported",
  backgroundInput: "supported",
  frameEvaluation: "degraded",
  popup: "supported",
  audioMute: "supported",
  customFonts: "supported",
  downloads: "disabled",
  fileUpload: "supported",
  permissions: "degraded",
  dialogs: "supported",
  certificateHandling: "supported"
} satisfies EngineCapabilitySnapshotRecord);

export const MACOS_APPKIT_CHROMIUM_CAPABILITIES = Object.freeze({
  navigation: "supported",
  persistentSession: "supported",
  trustedInput: "supported",
  backgroundInput: "supported",
  frameEvaluation: "degraded",
  popup: "supported",
  audioMute: "supported",
  customFonts: "supported",
  downloads: "disabled",
  fileUpload: "supported",
  permissions: "degraded",
  dialogs: "supported",
  certificateHandling: "supported"
} satisfies EngineCapabilitySnapshotRecord);

export const UNAVAILABLE_CHROMIUM_CAPABILITIES = Object.freeze(
  Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, "disabled"])) as
    EngineCapabilitySnapshotRecord
);

type RuntimePlatform = "darwin" | "win32";
type BootstrapState = "open" | "draining" | "closed";

interface StartupStreamFailureWaiter {
  reject: (error: RionBridgeError) => void;
  settled: boolean;
}

class StartupStreamFailureFanIn {
  readonly #waiters = new Set<StartupStreamFailureWaiter>();
  #detected = false;
  #failure: RionBridgeError | null = null;

  failAfterDrain(
    failure: RionBridgeError,
    drained: Promise<void>,
    onDrainFailure: (error: unknown) => void
  ): void {
    if (this.#detected) return;
    this.#detected = true;
    void drained.then(
      () => this.#terminalize(failure),
      (error: unknown) => {
        try {
          onDrainFailure(error);
        } catch {
          // Observational reporting cannot suppress the authoritative failure.
        }
        this.#terminalize(failure);
      }
    );
  }

  waitFor<T>(work: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const waiter: StartupStreamFailureWaiter = {
        reject: (error) => {
          if (waiter.settled) return;
          waiter.settled = true;
          this.#waiters.delete(waiter);
          reject(error);
        },
        settled: false
      };
      if (this.#failure) {
        waiter.reject(this.#failure);
        return;
      }
      this.#waiters.add(waiter);
      void work.then(
        (result) => {
          if (waiter.settled || this.#detected) return;
          waiter.settled = true;
          this.#waiters.delete(waiter);
          resolve(result);
        },
        (error: unknown) => {
          if (waiter.settled || this.#detected) return;
          waiter.settled = true;
          this.#waiters.delete(waiter);
          reject(error);
        }
      );
    });
  }

  #terminalize(failure: RionBridgeError): void {
    this.#failure = failure;
    for (const waiter of [...this.#waiters]) waiter.reject(failure);
  }
}

export interface ChromiumRuntimeCorePort extends ElectronCoreEffectPort,
  ChromiumSessionMigrationCorePort, ChromeProfileImportCoordinatorCorePort {
  invoke: <Command extends CoreCommand>(
    command: Command
  ) => Promise<CoreCommandResult<Command>>;
  beginRoleSessionMigrationImportInternal: (
    input: RoleSessionMigrationImportBeginInputInternal
  ) => Promise<RoleSessionMigrationRecord>;
  transitionRoleSessionMigrationTargetInternal: (
    input: RoleSessionMigrationTargetTransitionInputInternal
  ) => Promise<RoleSessionMigrationRecord>;
  recoverPendingChromeProfileImportsInternal: (
  ) => Promise<ChromeProfileImportRecoveryResultInternal>;
  restoreWindowsChromiumHeldKeysInternal?: (
    input: WindowsChromiumHeldKeyContinuityInputInternal
  ) => Promise<WindowsChromiumHeldKeyContinuityReceiptInternal>;
  startCoreEventBridge: () => void;
  shutdown: () => Promise<void>;
}

export interface MacosAppKitRuntimeBootstrapAdapter {
  readonly hostFactory: MacosAppKitRuntimeHostFactoryPort;
  readonly lifecycleEpoch?: () => number;
  readonly rendererActions?: MacosAppKitRendererActionPort;
  readonly drainEvents?: () => Promise<void>;
  readonly nativeAttachments?: ChromiumRoleSurfaceNativeAttachmentPort &
    ChromiumGlobalWebNativeAttachmentPort;
  readonly createTrustedInput?: (
    surfaces: ChromiumRoleSurfaceRegistry,
    preflightAutomaticInputContext: (
      roleId: string,
      surfaceGeneration: number
    ) => void | Promise<void>,
    onRecoveryProof: (proof: ChromiumTrustedInputRecoveryProof) => void
  ) => ChromiumRuntimeTrustedInputPort;
  readonly adapterVersion: string;
  readonly capabilities: EngineCapabilitySnapshotRecord;
}

export interface ChromiumRuntimeBootstrapInput {
  readonly appKit?: MacosAppKitRuntimeBootstrapAdapter;
  readonly chromiumVersion: string;
  readonly core: ChromiumRuntimeCorePort;
  readonly electronVersion: string;
  readonly ipcMain: ChromiumRoleOverlayIpcMainPort;
  readonly onError: ConstructorParameters<typeof CoreEffectCoordinator>[0]["onError"];
  readonly onFatalEventStreamFailure?: (
    terminal: CoreEffectEventStreamFailureTerminal
  ) => void;
  readonly onNativeProjectionChanged?: () => void;
  readonly onRuntimeTabQuickAccess?: (tabId: string) => void;
  readonly onRuntimeTabFullscreen?: (tabId: string) => void;
  readonly platform: RuntimePlatform;
  readonly rolePreloadPath: string;
  /** Main-process startup quit fence; production supplies it before Core recovery. */
  readonly startupSignal?: AbortSignal;
  /** Required by production bootstrap; optional only for lower-layer harnesses. */
  readonly webChromeShell?: ChromiumWorkspaceWebChromeShellInput;
  /** Required by production bootstrap; optional only for lower-layer harnesses. */
  readonly rolePlaceholderShell?: ChromiumRuntimeRolePlaceholderShellInput;
  readonly shellEffects?: ChromiumRuntimeShellEffectsPort;
  readonly sessions: ChromiumSessionFactoryPort;
  readonly views: ChromiumWebContentsViewFactoryPort;
  readonly windows?: Readonly<{
    browserWindows: WindowsBrowserWindowFactoryPort;
    displays: WindowsRuntimeHostDisplayResolverPort;
    displayTopology: () => DisplayTopologySnapshotRecord;
    lifecycleEpoch: () => number;
    runtimeDocumentPath: string;
    runtimeHostPreloadPath: string;
    onWindowControl: (
      windowId: string,
      action: "closeWindow" | "toggleMaximizeWindow"
    ) => Promise<void>;
    onTabControl?: (
      tabId: string,
      action: ChromiumRuntimeNativeTabAction
    ) => Promise<void>;
    runtimeForegroundProbe?: WindowsRuntimeForegroundProbePort;
    trustedInput?: WindowsChromiumTrustedInputRuntimeConfiguration;
  }>;
}

function bootstrapError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function requireBootstrapNotCancelled(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw bootstrapError(
    "ELECTRON_CHROMIUM_BOOTSTRAP_CANCELLED",
    "Application shutdown cancelled Chromium startup after native work drained."
  );
}

function adapterVersion(electronVersion: string, chromiumVersion: string): string {
  const version = `electron-${electronVersion}+chromium-${chromiumVersion}`;
  if (
    version.length > 64 ||
    !/^[+._0-9A-Za-z-]+$/u.test(version)
  ) {
    throw bootstrapError(
      "ELECTRON_CHROMIUM_ADAPTER_VERSION_INVALID",
      "Electron reported an invalid Chromium runtime adapter version."
    );
  }
  return version;
}

function copyCapabilities(
  capabilities: EngineCapabilitySnapshotRecord
): EngineCapabilitySnapshotRecord {
  const statuses = new Set(["supported", "degraded", "unsupported", "disabled"]);
  if (CAPABILITY_KEYS.some((key) => !statuses.has(capabilities[key]))) {
    throw bootstrapError(
      "ELECTRON_CHROMIUM_CAPABILITIES_INVALID",
      "The Chromium runtime adapter reported an invalid capability status."
    );
  }
  return Object.fromEntries(
    CAPABILITY_KEYS.map((key) => [key, capabilities[key]])
  ) as EngineCapabilitySnapshotRecord;
}

function capabilityAvailable(status: string): boolean {
  return status === "supported" || status === "degraded";
}

function baselineAvailable(capabilities: EngineCapabilitySnapshotRecord): boolean {
  return capabilityAvailable(capabilities.navigation) &&
    capabilityAvailable(capabilities.persistentSession) &&
    capabilityAvailable(capabilities.audioMute);
}

export function buildChromiumRuntimeRegistration(
  input: Pick<
    ChromiumRuntimeBootstrapInput,
    "appKit" | "chromiumVersion" | "electronVersion" | "platform"
  >
): BrowserRuntimeRegistrationRecord {
  const shellAdapterVersion = adapterVersion(
    input.electronVersion,
    input.chromiumVersion
  );
  if (input.platform === "win32") {
    const capabilities = copyCapabilities(WINDOWS_CHROMIUM_BOOTSTRAP_CAPABILITIES);
    const available = baselineAvailable(capabilities);
    return {
      contractVersion: ELECTRON_CHROMIUM_RUNTIME_CONTRACT_VERSION,
      platform: "windows",
      engine: "chromium",
      adapterVersion: shellAdapterVersion,
      available,
      capabilities,
      ...(available ? {} : { failureReason: "runtime-creation-failed" })
    };
  }

  if (!input.appKit) {
    return {
      contractVersion: ELECTRON_CHROMIUM_RUNTIME_CONTRACT_VERSION,
      platform: "macos",
      engine: "chromium",
      adapterVersion: shellAdapterVersion,
      available: false,
      capabilities: copyCapabilities(UNAVAILABLE_CHROMIUM_CAPABILITIES),
      failureReason: "runtime-creation-failed"
    };
  }

  // macOS evidence is platform-specific and complete. Never infer a native
  // AppKit/Chromium capability from the Windows Electron host implementation.
  const capabilities = copyCapabilities(input.appKit.capabilities);
  const trustedInputAvailable = capabilities.trustedInput === "supported";
  const available = baselineAvailable(capabilities) && trustedInputAvailable;
  const nativeAdapterVersion = input.appKit.adapterVersion;
  if (
    nativeAdapterVersion.length === 0 ||
    nativeAdapterVersion.length > 64 ||
    nativeAdapterVersion.trim() !== nativeAdapterVersion ||
    [...nativeAdapterVersion].some((character) => character.codePointAt(0)! <= 0x1f)
  ) {
    throw bootstrapError(
      "ELECTRON_MACOS_APPKIT_ADAPTER_VERSION_INVALID",
      "The AppKit runtime adapter reported an invalid version."
    );
  }
  return {
    contractVersion: ELECTRON_CHROMIUM_RUNTIME_CONTRACT_VERSION,
    platform: "macos",
    engine: "chromium",
    adapterVersion: nativeAdapterVersion,
    available,
    capabilities,
    ...(available
      ? {}
      : {
          failureReason: trustedInputAvailable
            ? "runtime-creation-failed" as const
            : "trusted-input-unavailable" as const
        })
  };
}

function validateRegistrationReceipt(
  expected: BrowserRuntimeRegistrationRecord,
  received: BrowserRuntimeRegistrationRecord
): void {
  const identityMatches = received.contractVersion === expected.contractVersion &&
    received.platform === expected.platform &&
    received.engine === expected.engine &&
    received.adapterVersion === expected.adapterVersion &&
    received.available === expected.available &&
    received.failureReason === expected.failureReason;
  const capabilitiesMatch = CAPABILITY_KEYS.every(
    (key) => received.capabilities[key] === expected.capabilities[key]
  );
  if (!identityMatches || !capabilitiesMatch) {
    throw bootstrapError(
      "ELECTRON_CHROMIUM_REGISTRATION_MISMATCH",
      "Core did not retain the exact Chromium runtime registration."
    );
  }
}

/** Owns v23 effect intake, native Chromium resources, and ordered Core shutdown. */
export class ChromiumRuntimeBootstrap {
  readonly #coordinator: CoreEffectCoordinator;
  readonly #automaticInputContext: ChromiumAutomaticInputContextCoordinator;
  readonly #core: ChromiumRuntimeCorePort;
  readonly #executor: ChromiumRuntimeEffectExecutor;
  readonly #fontsCoordinator: ChromiumRoleFontsCoordinator;
  readonly #managedShortcuts: ChromiumManagedShortcutCoordinator;
  readonly #overlayCoordinator: ChromiumRoleOverlayCoordinator;
  readonly #roleReloadCoordinator: ChromiumRoleReloadCoordinator | null;
  readonly #popupCoordinator: ChromiumPopupLifecycleCoordinator;
  readonly #navigationFailureReporter: ChromiumRoleNavigationFailureReporter;
  readonly #workspaceWebNavigationFailureReporter:
    ChromiumWorkspaceWebNavigationFailureReporter;
  readonly #hosts: ChromiumPlatformRuntimeHostFactory;
  readonly #windowPlacement: WindowsRuntimeWindowPlacementController | null;
  readonly #drainPlatformEvents?: () => Promise<void>;
  readonly #closeNativeActionIngress: () => void;
  readonly registration: BrowserRuntimeRegistrationRecord;
  readonly chromeProfileImportRecovery: ChromeProfileImportRecoveryResultInternal;
  readonly sessionMigrationResume: ChromiumSessionMigrationResumeStartResult;
  #intakeDrainPromise: Promise<void> | null = null;
  #cleanExitPromise: Promise<void> | null = null;
  #cleanExitGeneration: number | null = null;
  #shutdownPromise: Promise<void> | null = null;
  #state: BootstrapState = "open";
  #fatalGeneration = 0;

  private constructor(
    core: ChromiumRuntimeCorePort,
    coordinator: CoreEffectCoordinator,
    automaticInputContext: ChromiumAutomaticInputContextCoordinator,
    executor: ChromiumRuntimeEffectExecutor,
    fontsCoordinator: ChromiumRoleFontsCoordinator,
    managedShortcuts: ChromiumManagedShortcutCoordinator,
    overlayCoordinator: ChromiumRoleOverlayCoordinator,
    roleReloadCoordinator: ChromiumRoleReloadCoordinator | null,
    popupCoordinator: ChromiumPopupLifecycleCoordinator,
    navigationFailureReporter: ChromiumRoleNavigationFailureReporter,
    workspaceWebNavigationFailureReporter:
      ChromiumWorkspaceWebNavigationFailureReporter,
    hosts: ChromiumPlatformRuntimeHostFactory,
    windowPlacement: WindowsRuntimeWindowPlacementController | null,
    registration: BrowserRuntimeRegistrationRecord,
    chromeProfileImportRecovery: ChromeProfileImportRecoveryResultInternal,
    sessionMigrationResume: ChromiumSessionMigrationResumeStartResult,
    closeNativeActionIngress: () => void,
    drainPlatformEvents?: () => Promise<void>
  ) {
    this.#core = core;
    this.#coordinator = coordinator;
    this.#automaticInputContext = automaticInputContext;
    this.#executor = executor;
    this.#fontsCoordinator = fontsCoordinator;
    this.#managedShortcuts = managedShortcuts;
    this.#overlayCoordinator = overlayCoordinator;
    this.#roleReloadCoordinator = roleReloadCoordinator;
    this.#popupCoordinator = popupCoordinator;
    this.#navigationFailureReporter = navigationFailureReporter;
    this.#workspaceWebNavigationFailureReporter =
      workspaceWebNavigationFailureReporter;
    this.#hosts = hosts;
    this.#windowPlacement = windowPlacement;
    this.#closeNativeActionIngress = closeNativeActionIngress;
    this.#drainPlatformEvents = drainPlatformEvents;
    this.registration = Object.freeze(registration);
    this.chromeProfileImportRecovery = Object.freeze(chromeProfileImportRecovery);
    this.sessionMigrationResume = Object.freeze(sessionMigrationResume);
  }

  static async start(input: ChromiumRuntimeBootstrapInput): Promise<ChromiumRuntimeBootstrap> {
    requireBootstrapNotCancelled(input.startupSignal);
    if (input.platform === "win32" && !input.windows) {
      throw bootstrapError(
        "ELECTRON_WINDOWS_RUNTIME_HOST_MISSING",
        "The Windows Chromium runtime requires the native BrowserWindow host."
      );
    }
    const registration = buildChromiumRuntimeRegistration(input);
    const ownership = new ChromiumSessionOwnershipLedger(input.platform);
    const sessions = new ChromiumRoleSessionRegistry(
      input.sessions,
      input.platform,
      ownership
    );
    const globalWebSessions = new ChromiumGlobalWebSessionRegistry(
      input.sessions,
      input.platform,
      ownership
    );
    const nativeActionIngress = { accepting: true };
    const requireNativeActionIngress = (): void => {
      if (!nativeActionIngress.accepting) {
        throw bootstrapError(
          "ELECTRON_CHROMIUM_NATIVE_ACTION_DRAINING",
          "The Chromium runtime rejects native actions while preparing to exit."
        );
      }
    };
    let executor: ChromiumRuntimeEffectExecutor | null = null;
    const windowPlacement = input.platform === "win32"
      ? new WindowsRuntimeWindowPlacementController({
          core: input.core,
          readDisplayTopology: input.windows!.displayTopology,
          onError: input.onError,
          onApplied: (event, receipt) => {
            if (!executor) {
              throw bootstrapError(
                "ELECTRON_WINDOWS_RUNTIME_PLACEMENT_RUNTIME_NOT_READY",
                "The applied Windows placement has no active runtime executor."
              );
            }
            executor.commitWindowsRuntimePlacementTarget(event, receipt);
          }
        })
      : null;
    const hosts = new ChromiumPlatformRuntimeHostFactory(
      input.platform === "win32"
        ? {
            platform: "win32",
            onError: (error) => input.onError(normalizeRionBridgeError(
              error,
              "ELECTRON_WINDOWS_RUNTIME_COMMAND_FAILED"
            )),
            browserWindows: input.windows!.browserWindows,
            displays: input.windows!.displays,
            runtimeDocumentPath: input.windows!.runtimeDocumentPath,
            runtimeHostPreloadPath: input.windows!.runtimeHostPreloadPath,
            onWindowControl: (windowId, action) => {
              requireNativeActionIngress();
              return input.windows!.onWindowControl(windowId, action);
            },
            onTabControl: (tabId, action) => {
              requireNativeActionIngress();
              const request = input.windows!.onTabControl;
              return request
                ? request(tabId, action)
                : Promise.reject(bootstrapError(
                    "ELECTRON_CHROMIUM_TAB_CONTROL_UNAVAILABLE",
                    "The Core-owned Windows tab control lane is unavailable."
                  ));
            },
            onWorkspaceDividerPointer: (event) => {
              requireNativeActionIngress();
              return input.core.invoke({
                type: "browserWorkspaceDividerPointer",
                event
              });
            },
            onRuntimeWindowPlacement: (host) => {
              requireNativeActionIngress();
              return windowPlacement!.observe(host);
            },
            runtimeForegroundProbe: input.windows!.runtimeForegroundProbe,
            lifecycleEpoch: input.windows!.lifecycleEpoch,
            onTabReload: (fence) => {
              requireNativeActionIngress();
              return executeControlledRuntimeTabReload(input.core, fence).then(
                () => undefined
              );
            }
          }
        : {
            platform: "darwin",
            appKit: registration.available ? input.appKit?.hostFactory : undefined
        }
    );
    const windowsInput = input.platform === "win32"
      ? createWindowsChromiumTrustedInputRuntime({
          capabilities: registration.capabilities,
          configuration: input.windows?.trustedInput,
          nowMs: Date.now,
          onError: (error) => input.onError(error),
          parents: {
            resolve: (parent) => hosts.resolveWindowsInputParent(parent)
          }
        })
      : null;
    const roleNativeAttachments = input.platform === "darwin"
      ? input.appKit?.nativeAttachments ?? null
      : windowsInput?.nativeAttachments ?? null;
    const globalNativeAttachments = input.platform === "darwin"
      ? input.appKit?.nativeAttachments ?? null
      : null;
    const popupCoordinator = new ChromiumPopupLifecycleCoordinator({
      core: input.core,
      hosts,
      onError: input.onError,
      platform: input.platform,
      runtimeSnapshot: () => {
        if (!executor) {
          throw bootstrapError(
            "ELECTRON_CHROMIUM_POPUP_RUNTIME_NOT_READY",
            "The Chromium popup requested native state before runtime registration."
          );
        }
        return executor.snapshot();
      },
      views: input.views
    });
    const navigationFailureReporter = new ChromiumRoleNavigationFailureReporter({
      core: input.core,
      currentSurface: (roleId) => {
        const role = executor?.snapshot().roles.find(
          (candidate) => candidate.roleId === roleId
        );
        return role ? Object.freeze({
          ownerGeneration: role.ownerGeneration,
          roleId: role.roleId,
          surfaceGeneration: role.generation,
          tabId: role.tabId
        }) : null;
      },
      onError: input.onError
    });
    const workspaceWebNavigationFailureReporter =
      new ChromiumWorkspaceWebNavigationFailureReporter({
        core: input.core,
        onError: input.onError
      });
    const surfaces = new ChromiumRoleSurfaceRegistry(
      sessions,
      input.views,
      roleNativeAttachments,
      popupCoordinator,
      input.onRuntimeTabQuickAccess
        ? {
            platform: input.platform,
            request: (tabId) => {
              requireNativeActionIngress();
              input.onRuntimeTabQuickAccess!(tabId);
            },
            ...(input.onRuntimeTabFullscreen === undefined
              ? {}
              : {
                  requestFullscreen: (tabId: string) => {
                    requireNativeActionIngress();
                    input.onRuntimeTabFullscreen!(tabId);
                  }
                }),
            onError: (error) => input.onError(normalizeRionBridgeError(
              error,
              "ELECTRON_CHROMIUM_QUICK_ACCESS_REQUEST_FAILED"
            ))
          }
        : null,
      navigationFailureReporter
    );
    const contentWebSurfaces = new ChromiumGlobalWebSurfaceRegistry(
      globalWebSessions,
      input.views,
      globalNativeAttachments,
      popupCoordinator,
      workspaceWebNavigationFailureReporter
    );
    const webSurfaces = input.webChromeShell
      ? new ChromiumGlobalWebPresentationRegistry({
          content: contentWebSurfaces,
          views: input.views,
          nativeAttachments: globalNativeAttachments,
          shell: input.webChromeShell,
          onError: (error) => input.onError(error)
        })
      : contentWebSurfaces;
    let trustedInput: ChromiumRuntimeTrustedInputPort | null = null;
    const automaticInputContext = new ChromiumAutomaticInputContextCoordinator({
      core: {
        inspectRecovery: ({ recoveryId, roleId, expectedInputEpoch }) =>
          input.core.invoke({
            type: "macroInputRecoveryInspect",
            recoveryId,
            roleId,
            expectedInputEpoch
          }),
        drainInput: ({ roleId, inputEpoch }) => input.core.invoke({
          type: "macroInputDrain",
          roleId,
          inputEpoch
        }),
        completeRecovery: ({ recoveryId, roleId, expectedInputEpoch }) =>
          input.core.invoke({
            type: "macroInputRecoveryComplete",
            recoveryId,
            roleId,
            expectedInputEpoch
          }),
        failRecovery: ({ recoveryId, roleId, expectedInputEpoch, message }) =>
          input.core.invoke({
            type: "macroInputRecoveryFail",
            recoveryId,
            roleId,
            expectedInputEpoch,
            message
          })
      },
      surfaces,
      resumeNativeAfterDocumentReplacement: (roleId, surfaceGeneration) =>
        trustedInput?.resumeAfterDocumentReplacement(roleId, surfaceGeneration) ??
        Promise.resolve(false),
      onError: input.onError
    });
    const rolePlaceholders = input.rolePlaceholderShell
      ? new ChromiumRuntimeRolePlaceholderRegistry({
          claim: async (
            state: RuntimeRolePlaceholderState
          ): Promise<RuntimeRolePlaceholderClaimReceipt> => {
            requireNativeActionIngress();
            if (!executor) {
              throw bootstrapError(
                "ELECTRON_ROLE_PLACEHOLDER_RUNTIME_NOT_READY",
                "The visible Role-slot claim arrived before runtime registration."
              );
            }
            const before = executor.snapshot();
            const window = before.windows.find(
              (candidate) => candidate.windowId === state.windowId
            );
            if (
              !window || window.windowGeneration !== state.windowGeneration ||
              window.topologyRevision !== state.topologyRevision ||
              window.activeTabId !== state.tabId || !window.visible
            ) {
              throw bootstrapError(
                "ELECTRON_ROLE_PLACEHOLDER_ACTION_STALE",
                "The visible Role-slot action lost its native window revision fence."
              );
            }
            const snapshot = await input.core.invoke({
              type: "browserRoleSlotClaim",
              tabId: state.tabId,
              slotId: state.slotId,
              expectedOwnerGeneration: state.ownerGeneration
            });
            const owner = snapshot.roles.find(
              (role) => role.roleId === state.roleId
            )?.owner;
            if (
              !owner || owner.tabId !== state.tabId ||
              owner.slotId !== state.slotId ||
              owner.generation <= state.ownerGeneration
            ) {
              throw bootstrapError(
                "ELECTRON_ROLE_PLACEHOLDER_CLAIM_READBACK_FAILED",
                "Core did not terminalize the exact visible Role owner."
              );
            }
            await executor.commitTerminalRoleOwnership(snapshot.roles);
            const native = executor.snapshot().windows.find(
              (candidate) => candidate.windowId === state.windowId
            );
            if (
              !native || native.windowGeneration !== state.windowGeneration ||
              native.topologyRevision !== state.topologyRevision
            ) {
              throw bootstrapError(
                "ELECTRON_ROLE_PLACEHOLDER_CLAIM_READBACK_FAILED",
                "The native placeholder projection lost its exact window revision fence."
              );
            }
            return Object.freeze({
              generation: state.generation,
              ownerGeneration: state.ownerGeneration,
              placeholderId: state.placeholderId,
              roleId: state.roleId,
              slotId: state.slotId,
              status: "applied" as const,
              tabId: state.tabId,
              topologyRevision: state.topologyRevision,
              windowGeneration: state.windowGeneration,
              windowId: state.windowId
            });
          },
          nativeAttachments: globalNativeAttachments,
          shell: input.rolePlaceholderShell,
          views: input.views
        })
      : undefined;
    let fontsCoordinator: ChromiumRoleFontsCoordinator | null = null;
    let overlayCoordinator: ChromiumRoleOverlayCoordinator | null = null;
    let managedShortcuts: ChromiumManagedShortcutCoordinator | null = null;
    let roleReloadCoordinator: ChromiumRoleReloadCoordinator | null = null;
    let heldKeyContinuity: WindowsChromiumHeldKeyContinuityCoordinator | null = null;
    let effectCoordinator: CoreEffectCoordinator | null = null;
    let publishedRuntime: ChromiumRuntimeBootstrap | null = null;
    let runtimePublished = false;
    const startupStreamFailure = new StartupStreamFailureFanIn();
    const onEventStreamFailure = (
      terminal: CoreEffectEventStreamFailureTerminal
    ): void => {
      nativeActionIngress.accepting = false;
      heldKeyContinuity?.dispose();
      publishedRuntime?.beginFatalEventStreamFailure();
      if (!runtimePublished) {
        startupStreamFailure.failAfterDrain(
          new RionBridgeError(terminal.error),
          terminal.drained,
          (error: unknown) => input.onError(normalizeRionBridgeError(
            error,
            "ELECTRON_CORE_EVENT_STREAM_FATAL_DRAIN_FAILED"
          ))
        );
        return;
      }
      if (input.onFatalEventStreamFailure) {
        input.onFatalEventStreamFailure(terminal);
        return;
      }
      // Production supplies the lifecycle-level fatal handler. A lower-layer
      // harness that omits it still cannot leave a returned runtime accepting
      // work after loss of the authoritative event stream.
      void terminal.drained
        .then(() => publishedRuntime?.shutdown())
        .catch((error: unknown) => input.onError(normalizeRionBridgeError(
          error,
          "ELECTRON_CORE_EVENT_STREAM_FATAL_DRAIN_FAILED"
        )));
    };
    try {
      if (input.platform === "darwin" && registration.available) {
        if (!roleNativeAttachments) {
          throw bootstrapError(
            "ELECTRON_MACOS_APPKIT_NATIVE_ATTACHMENTS_MISSING",
            "The available AppKit Chromium runtime requires exact native surface ownership."
          );
        }
        if (!input.appKit?.createTrustedInput) {
          throw bootstrapError(
            "ELECTRON_MACOS_APPKIT_TRUSTED_INPUT_MISSING",
            "The available AppKit Chromium runtime requires its native trusted-input adapter."
          );
        }
        trustedInput = input.appKit.createTrustedInput(
          surfaces,
          (roleId, surfaceGeneration) =>
            automaticInputContext.preflight(roleId, surfaceGeneration),
          (proof) => {
            void automaticInputContext.observeNeutralityProof(proof).catch(
              (error) => input.onError(normalizeRionBridgeError(
                error,
                "ELECTRON_AUTOMATIC_INPUT_RECOVERY_PROOF_FAILED"
              ))
            );
          }
        );
      }
      if (registration.available) {
        const windowPreferences = await input.core.invoke({
          type: "runtimeWindowPreferencesGet"
        });
        await hosts.applyWindowPreferences(windowPreferences);
      }
      if (input.platform === "win32" && windowsInput) {
        trustedInput = windowsInput.createTrustedInput(
          surfaces,
          (roleId, surfaceGeneration) =>
            automaticInputContext.preflight(roleId, surfaceGeneration),
          (proof) => {
            void automaticInputContext.observeNeutralityProof(proof).catch(
              (error) => input.onError(normalizeRionBridgeError(
                error,
                "ELECTRON_AUTOMATIC_INPUT_RECOVERY_PROOF_FAILED"
              ))
            );
          }
        );
      }
      requireBootstrapNotCancelled(input.startupSignal);
      const sessionMigrationResume = await new ChromiumSessionMigrationResumeCoordinator({
        core: input.core,
        expectedPlatform: input.platform === "darwin" ? "macos" : "windows",
        importer: new ChromiumSessionMigrationImporter(
          input.core,
          sessions,
          input.platform,
          input.startupSignal
        ),
        startupSignal: input.startupSignal
      }).start();
      requireBootstrapNotCancelled(input.startupSignal);
      const browserDataClear = new ChromiumRoleBrowserDataClearCoordinator({
        launcher: input.core,
        maintenance: {
          reserve: (clearInput) =>
            sessions.reserveRoleBrowserDataMaintenance(clearInput),
          release: (reservation) =>
            sessions.releaseRoleBrowserDataMaintenanceReservation(reservation)
        },
        platform: input.platform
      });
      const globalWebBrowserDataClear =
        new ChromiumGlobalWebBrowserDataClearCoordinator({
          maintenance: {
            acquire: (operationId, profile) =>
              globalWebSessions.acquireMaintenance(operationId, profile),
            release: (lease) =>
              globalWebSessions.releaseMaintenance(lease)
          },
          platform: input.platform
        });
      const createdExecutor = new ChromiumRuntimeEffectExecutor({
        browserDataClear,
        chromeProfileImport: new ChromeProfileImportCoordinator(input.core),
        globalWebBrowserDataClear,
        hosts,
        layout: new ChromiumRuntimeLayoutResolver(input.core),
        lifecycleEpoch: input.platform === "win32"
          ? input.windows!.lifecycleEpoch
          : input.appKit?.lifecycleEpoch ?? (() => 1),
        managedShortcutRetirement: {
          retireSurface: (roleId, surfaceGeneration) =>
            managedShortcuts?.retireSurface(roleId, surfaceGeneration) ?? Promise.resolve()
        },
        overlays: {
          install: (roleIds, generationForRole) => {
            if (!overlayCoordinator || !fontsCoordinator) {
              return Promise.reject(bootstrapError(
                "ELECTRON_CHROMIUM_OVERLAY_NOT_READY",
                "The Chromium role overlay and browser-font coordinators are not available."
              ));
            }
            return Promise.all([
              overlayCoordinator.install(roleIds, generationForRole),
              fontsCoordinator.install(roleIds, generationForRole)
            ]).then(() => undefined);
          },
          retire: (roleId, generation) => {
            overlayCoordinator?.retire(roleId, generation);
            fontsCoordinator?.retire(roleId, generation);
          }
        },
        ...(input.onNativeProjectionChanged
          ? { onNativeProjectionChanged: input.onNativeProjectionChanged }
          : {}),
        onError: input.onError,
        preloadPath: input.rolePreloadPath,
        popupZoom: popupCoordinator,
        rolePaths: {
          resolve: (roleId) => input.core.invoke({ type: "rolePathsResolve", id: roleId })
        },
        ...(rolePlaceholders ? { rolePlaceholders } : {}),
        roleReload: {
          prepare: (effect, action) => roleReloadCoordinator
            ? roleReloadCoordinator.prepare(effect, action)
            : Promise.reject(bootstrapError(
                "ELECTRON_ROLE_RELOAD_NOT_READY",
                "The Chromium role reload coordinator is unavailable."
              )),
          commit: (effect, action) => roleReloadCoordinator
            ? roleReloadCoordinator.commit(effect, action)
            : Promise.reject(bootstrapError(
                "ELECTRON_ROLE_RELOAD_NOT_READY",
                "The Chromium role reload coordinator is unavailable."
              )),
          supersede: (effect, action) => {
            if (!roleReloadCoordinator) {
              throw bootstrapError(
                "ELECTRON_ROLE_RELOAD_NOT_READY",
                "The Chromium role reload coordinator is unavailable."
              );
            }
            return roleReloadCoordinator.supersede(effect, action);
          }
        },
        shellEffects: input.shellEffects ?? {
          copyCoordinate: () => {
            throw bootstrapError(
              "ELECTRON_OVERLAY_SHELL_EFFECTS_UNAVAILABLE",
              "The Electron overlay shell-effects adapter is unavailable."
            );
          },
          openMacroPage: () => {
            throw bootstrapError(
              "ELECTRON_OVERLAY_SHELL_EFFECTS_UNAVAILABLE",
              "The Electron overlay shell-effects adapter is unavailable."
            );
          }
        },
        surfaces,
        ...(trustedInput ? { trustedInput } : {}),
        webSurfaces
      });
      executor = createdExecutor;
      if (input.platform === "win32" && windowsInput &&
        registration.capabilities.backgroundInput === "supported") {
        const restoreHeldKeys = input.core.restoreWindowsChromiumHeldKeysInternal;
        if (!restoreHeldKeys) {
          throw bootstrapError(
            "ELECTRON_WINDOWS_HELD_CONTINUITY_NATIVE_MISSING",
            "Supported Windows background input requires the private Core continuity boundary."
          );
        }
        heldKeyContinuity = new WindowsChromiumHeldKeyContinuityCoordinator({
          core: {
            restoreWindowsChromiumHeldKeysInternal: (continuityInput) =>
              restoreHeldKeys.call(input.core, continuityInput)
          },
          surfaces,
          attachments: windowsInput.nativeAttachments,
          resolveIdentity: (identity) =>
            createdExecutor.overlayHeldKeyContinuityIdentity(identity),
          onError: (error) => input.onError(error)
        });
      }
      const createdFontsCoordinator = new ChromiumRoleFontsCoordinator({
        core: {
          browserFontRuntimePayload: () => input.core.invoke({
            type: "browserFontRuntimePayload"
          })
        },
        surfaces
      });
      createdFontsCoordinator.register(input.ipcMain);
      fontsCoordinator = createdFontsCoordinator;
      managedShortcuts = new ChromiumManagedShortcutCoordinator({
        dispatch: ({ operationId, surface, request }) => input.core.invoke({
          type: "managedShortcutPhase",
          operationId,
          roleId: surface.roleId,
          tabId: surface.tabId,
          surfaceGeneration: surface.surfaceGeneration,
          documentInstanceId: surface.documentInstanceId,
          expectedOwnerGeneration: surface.ownerGeneration,
          pressId: request.pressId,
          macroId: request.macroId,
          code: request.code,
          phase: request.phase,
          modifierCodes: [...request.modifierCodes]
        }),
        resolveSurface: (identity, phase) =>
          createdExecutor.overlayManagedShortcutIdentity(identity, phase),
        retireSurface: ({ roleId, surfaceGeneration, documentInstanceId }) =>
          input.core.invoke({
            type: "managedShortcutSurfaceRetire",
            roleId,
            surfaceGeneration,
            documentInstanceId
          }),
        subscribeSurfaceLifecycle: (listener) =>
          surfaces.subscribeOverlayLifecycle(listener),
        onError: input.onError
      });
      const createdOverlayCoordinator = new ChromiumRoleOverlayCoordinator({
        core: {
          overlayRequest: ({ roleId, requestJson }) => input.core.invoke({
            type: "overlayRequest",
            roleId,
            requestJson
          })
        },
        surfaces,
        runtime: {
          activate: (identity) => createdExecutor.overlayActivate(identity),
          coordinateContext: (identity) =>
            createdExecutor.overlayCoordinateContext(identity),
          observeGameInputContext: (identity, payload) =>
            automaticInputContext.observe(identity, payload),
          managedShortcutKeyPhase: (identity, payload) =>
            managedShortcuts!.dispatch(identity, payload),
          ...(heldKeyContinuity
            ? {
                inputContextLost: (
                  identity: ChromiumRoleOverlayFrameIdentity,
                  payload: unknown
                ) => heldKeyContinuity!.observeBlur(identity, payload)
              }
            : {})
        }
      });
      createdOverlayCoordinator.register(input.ipcMain);
      overlayCoordinator = createdOverlayCoordinator;
      if (registration.available && !trustedInput) {
        throw bootstrapError(
          "ELECTRON_ROLE_RELOAD_TRUSTED_INPUT_MISSING",
          "Controlled Chromium reload requires the platform trusted-input adapter."
        );
      }
      if (trustedInput) {
        roleReloadCoordinator = new ChromiumRoleReloadCoordinator({
          inputContexts: automaticInputContext,
          managedShortcuts,
          overlays: createdOverlayCoordinator,
          popups: popupCoordinator,
          readSnapshot: () => createdExecutor.snapshot(),
          surfaces,
          trustedInput
        });
      }
      const coordinator = new CoreEffectCoordinator({
        core: input.core,
        processReceiptLedger: processCoreEffectReceiptLedger,
        execute: (effect, context) => createdExecutor.execute(effect, context),
        afterDispatch: (effect, result, report) =>
          automaticInputContext.afterEffectDispatch(effect, result, report),
        onEventStreamFailure,
        onError: input.onError
      });
      requireBootstrapNotCancelled(input.startupSignal);
      const receipt = await input.core.invoke({
        type: "browserRuntimeRegister",
        registration
      });
      validateRegistrationReceipt(registration, receipt);
      requireBootstrapNotCancelled(input.startupSignal);
      effectCoordinator = coordinator;
      coordinator.start();
      input.core.startCoreEventBridge();
      const chromeProfileImportRecovery = await startupStreamFailure.waitFor(
        input.core.recoverPendingChromeProfileImportsInternal()
      );
      requireBootstrapNotCancelled(input.startupSignal);
      const runtime = new ChromiumRuntimeBootstrap(
        input.core,
        coordinator,
        automaticInputContext,
        executor,
        fontsCoordinator,
        managedShortcuts,
        overlayCoordinator,
        roleReloadCoordinator,
        popupCoordinator,
        navigationFailureReporter,
        workspaceWebNavigationFailureReporter,
        hosts,
        windowPlacement,
        receipt,
        chromeProfileImportRecovery,
        sessionMigrationResume,
        () => {
          nativeActionIngress.accepting = false;
          heldKeyContinuity?.dispose();
        },
        input.appKit?.drainEvents
      );
      await startupStreamFailure.waitFor(Promise.resolve());
      publishedRuntime = runtime;
      runtimePublished = true;
      return runtime;
    } catch (error) {
      await effectCoordinator?.dispose().catch(() => undefined);
      await input.appKit?.drainEvents?.().catch(() => undefined);
      await navigationFailureReporter.closeAndDrain().catch(() => undefined);
      await workspaceWebNavigationFailureReporter.closeAndDrain()
        .catch(() => undefined);
      await popupCoordinator.dispose().catch(() => undefined);
      if (executor) {
        await executor.dispose().catch(() => undefined);
      } else {
        await trustedInput?.dispose().catch(() => undefined);
        await surfaces.dispose().catch(() => undefined);
        await webSurfaces.dispose().catch(() => undefined);
        await rolePlaceholders?.dispose().catch(() => undefined);
      }
      await windowsInput?.dispose().catch(() => undefined);
      fontsCoordinator?.dispose();
      overlayCoordinator?.dispose();
      heldKeyContinuity?.dispose();
      roleReloadCoordinator?.dispose();
      await managedShortcuts?.dispose().catch(() => undefined);
      automaticInputContext.dispose();
      throw error;
    }
  }

  snapshot(): ChromiumRuntimeExecutorSnapshot {
    if (this.#state !== "open") {
      throw bootstrapError(
        "ELECTRON_CHROMIUM_RUNTIME_DRAINING",
        "The Chromium runtime cannot project native state while it is draining."
      );
    }
    return this.#executor.snapshot();
  }

  settleCurrentProjection(): Promise<number> {
    if (this.#state !== "open") {
      return Promise.reject(bootstrapError(
        "ELECTRON_CHROMIUM_RUNTIME_DRAINING",
        "The Chromium runtime cannot settle a projection while it is draining."
      ));
    }
    return this.#coordinator.settleCurrentProjectionEffects();
  }

  settleCurrentApplicationEffects(): Promise<void> {
    if (this.#state !== "open") {
      return Promise.reject(bootstrapError(
        "ELECTRON_CHROMIUM_RUNTIME_DRAINING",
        "The Chromium runtime cannot settle its application lane while it is draining."
      ));
    }
    return this.#coordinator.settleCurrentApplicationEffects();
  }

  waitForProjectionAfter(sequence: number): Promise<number> {
    if (this.#state !== "open") {
      return Promise.reject(bootstrapError(
        "ELECTRON_CHROMIUM_RUNTIME_DRAINING",
        "The Chromium runtime cannot await a projection while it is draining."
      ));
    }
    return this.#coordinator.waitForProjectionAfter(sequence);
  }

  desktopE2eStatusPresentation(windowId: string): number | undefined {
    if (this.#state !== "open") return undefined;
    return this.#executor.desktopE2eStatusPresentation(windowId);
  }

  advanceLifecycle(lifecycleEpoch: number): void {
    if (this.#state === "open") this.#executor.advanceLifecycle(lifecycleEpoch);
  }

  observeExternalForeground(lifecycleEpoch: number): void {
    if (this.#state === "open") {
      this.#executor.observeExternalForeground(lifecycleEpoch);
    }
  }

  inspectFullscreenToolbar(
    windowId: string
  ): ChromiumRuntimeFullscreenToolbarInspection {
    if (this.#state !== "open") {
      throw bootstrapError(
        "ELECTRON_CHROMIUM_RUNTIME_DRAINING",
        "The native fullscreen toolbar cannot be observed while draining."
      );
    }
    return this.#executor.inspectFullscreenToolbar(windowId);
  }

  inspectWindowsRuntimeWindowPlacement(
    windowId?: string
  ): readonly WindowsRuntimeWindowPlacementInspection[] {
    if (this.#state !== "open" || !this.#windowPlacement) {
      throw bootstrapError(
        "ELECTRON_WINDOWS_RUNTIME_PLACEMENT_OBSERVATION_UNAVAILABLE",
        "The Windows runtime placement receipt journal is unavailable."
      );
    }
    return this.#windowPlacement.inspect(windowId);
  }

  applyWindowPreferences(
    preferences: import("../../shared/generated").RuntimeWindowPreferencesRecord
  ): Promise<void> {
    if (this.#state !== "open") {
      return Promise.reject(bootstrapError(
        "ELECTRON_CHROMIUM_RUNTIME_DRAINING",
        "The native runtime cannot apply window preferences while draining."
      ));
    }
    return this.#hosts.applyWindowPreferences(preferences);
  }

  refreshRoleOverlays(roleIds: readonly string[]): Promise<unknown> {
    if (this.#state !== "open") {
      return Promise.reject(bootstrapError(
        "ELECTRON_CHROMIUM_RUNTIME_DRAINING",
        "The Chromium runtime cannot refresh overlays while it is draining."
      ));
    }
    return this.#overlayCoordinator.refresh(roleIds);
  }

  refreshRoleFonts(roleIds: readonly string[]): Promise<unknown> {
    if (this.#state !== "open") {
      return Promise.reject(bootstrapError(
        "ELECTRON_CHROMIUM_RUNTIME_DRAINING",
        "The Chromium runtime cannot refresh browser fonts while it is draining."
      ));
    }
    return this.#fontsCoordinator.refresh(roleIds);
  }

  /** Synchronously closes all runtime ingress and invalidates a clean-exit owner. */
  beginFatalEventStreamFailure(): void {
    if (this.#fatalGeneration > 0) return;
    this.#fatalGeneration += 1;
    if (this.#state === "open") this.#state = "draining";
    this.#closeNativeActionIngress();
  }

  /** Closes native/general runtime admission before renderer commands drain. */
  beginCleanExit(): void {
    if (this.#cleanExitGeneration !== null) return;
    if (this.#shutdownPromise || this.#state !== "open" || this.#fatalGeneration > 0) {
      throw bootstrapError(
        "ELECTRON_CHROMIUM_CLEAN_EXIT_TOO_LATE",
        "The Chromium clean-exit boundary cannot begin after runtime shutdown."
      );
    }
    this.#cleanExitGeneration = this.#fatalGeneration;
    this.#state = "draining";
    this.#closeNativeActionIngress();
  }

  /**
   * Freezes native event/effect intake, captures the final live Game Window
   * cohort, and closes every native surface before the caller marks the Rust
   * recovery journal clean. A close failure therefore leaves the previous
   * unclean journal intact instead of masquerading as a normal exit.
   */
  prepareCleanExit(
    persist: (snapshot: ChromiumRuntimeExecutorSnapshot) => Promise<unknown>
  ): Promise<void> {
    if (this.#cleanExitPromise) return this.#cleanExitPromise;
    try {
      this.beginCleanExit();
    } catch (error) {
      return Promise.reject(error);
    }
    const cleanExitGeneration = this.#cleanExitGeneration;
    if (cleanExitGeneration === null) {
      return Promise.reject(bootstrapError(
        "ELECTRON_CHROMIUM_CLEAN_EXIT_TOO_LATE",
        "The Chromium clean-exit boundary cannot begin after runtime shutdown."
      ));
    }
    this.#cleanExitPromise = this.#drainRuntimeIntake().then(async () => {
      this.#requireCleanExitGeneration(cleanExitGeneration);
      const snapshot = this.#executor.snapshot();
      await this.#executor.dispose();
      this.#requireCleanExitGeneration(cleanExitGeneration);
      await persist(snapshot);
      this.#requireCleanExitGeneration(cleanExitGeneration);
    });
    return this.#cleanExitPromise;
  }

  shutdown(): Promise<void> {
    if (this.#shutdownPromise) return this.#shutdownPromise;
    if (this.#state === "closed") return Promise.resolve();
    this.#state = "draining";
    this.#shutdownPromise = this.#shutdownInOrder().catch((error: unknown) => {
      this.#shutdownPromise = null;
      throw error;
    });
    return this.#shutdownPromise;
  }

  async #shutdownInOrder(): Promise<void> {
    await this.#drainRuntimeIntake();
    await this.#executor.dispose();
    this.#fontsCoordinator.dispose();
    await this.#managedShortcuts.dispose();
    this.#overlayCoordinator.dispose();
    this.#roleReloadCoordinator?.dispose();
    this.#automaticInputContext.dispose();
    try {
      await this.#core.shutdown();
    } finally {
      this.#coordinator.finishEventStreamObservation();
    }
    this.#state = "closed";
  }

  #drainRuntimeIntake(): Promise<void> {
    if (this.#intakeDrainPromise) return this.#intakeDrainPromise;
    this.#closeNativeActionIngress();
    this.#intakeDrainPromise = Promise.resolve()
      .then(() => this.#drainPlatformEvents?.())
      .then(() => this.#windowPlacement?.drain())
      .then(() => this.#navigationFailureReporter.closeAndDrain())
      .then(() => this.#workspaceWebNavigationFailureReporter.closeAndDrain())
      .then(() => this.#roleReloadCoordinator?.dispose())
      .then(() => this.#popupCoordinator.dispose())
      .then(() => this.#coordinator.dispose());
    return this.#intakeDrainPromise;
  }

  #requireCleanExitGeneration(generation: number): void {
    if (this.#fatalGeneration === generation) return;
    throw bootstrapError(
      "ELECTRON_CHROMIUM_CLEAN_EXIT_INVALIDATED",
      "A fatal Core event-stream failure invalidated the pending clean-exit commit."
    );
  }
}
