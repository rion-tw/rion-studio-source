import { writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import type {
  BrowserTabReloadReceiptRecord,
  ChromiumPopupAdmissionRecord,
  ChromiumPopupNativeHostReceiptRecord,
  CoreCommand,
  CoreCommandResult
} from "../../shared/generated";
import { isWindowsRuntimeHostCommand } from "../../shared/windowsRuntimeHost";
import { CoreAddonClient } from "../core/coreAddonClient";
import { RionBridgeError } from "../ipc/errors";
import type { ChromiumRuntimeBootstrap } from
  "../main/chromiumRuntimeBootstrap";
import type { ChromiumRuntimeHostPort } from
  "../main/chromiumRuntimeHostPorts";
import type { ChromiumRoleSurfaceRegistry } from
  "../main/chromiumRoleSurfaceRegistry";
import { WindowsRuntimeHostChromeController } from
  "../main/windowsRuntimeHostChromeController";
import {
  ELECTRON_DESKTOP_E2E_RUNTIME_TAB_RELOAD_JOURNAL_CAPACITY,
  parseElectronDesktopE2eRuntimeTabReloadInspection,
  type ElectronDesktopE2eReloadCommand,
  type ElectronDesktopE2eRuntimeTabReloadFailure,
  type ElectronDesktopE2eRuntimeTabReloadInspection,
  type ElectronDesktopE2eRuntimeTabReloadObservation,
  type ElectronDesktopE2eWindowsReloadCommand
} from "./runtimeTabReloadInspection";

interface RoleSurfaceOwner {
  readonly generation: number;
  readonly registry: ChromiumRoleSurfaceRegistry;
  readonly tabId: string;
}

interface PopupHostOwner {
  readonly admission: ChromiumPopupAdmissionRecord;
  readonly host: ChromiumRuntimeHostPort;
  readonly receipt: ChromiumPopupNativeHostReceiptRecord;
}

export interface ElectronDesktopE2eRuntimeTabReloadObserverInput {
  readonly artifactDirectory: string | undefined;
  readonly platform: () => "darwin" | "win32";
  readonly popupHostOwners: ReadonlyMap<string, PopupHostOwner>;
  readonly readRuntime: () => Pick<ChromiumRuntimeBootstrap, "snapshot"> | null;
  readonly roleSurfaceOwners: ReadonlyMap<string, RoleSurfaceOwner>;
}

function cloneReceipt(
  receipt: BrowserTabReloadReceiptRecord
): Readonly<BrowserTabReloadReceiptRecord> {
  const roles = receipt.roles.map((role) => Object.freeze({ ...role }));
  Object.freeze(roles);
  return Object.freeze({
    receipt: Object.freeze({ ...receipt.receipt }),
    roles
  });
}

/** Observes visible Reload and owns one explicit E2E-only failure precondition. */
export class ElectronDesktopE2eRuntimeTabReloadObserver {
  readonly #input: ElectronDesktopE2eRuntimeTabReloadObserverInput;
  #failNext: Readonly<{
    tabId: string;
    topologyRevision: number;
    windowGeneration: number;
    windowId: string;
  }> | null = null;
  readonly #failures: ElectronDesktopE2eRuntimeTabReloadFailure[] = [];
  readonly #observations: ElectronDesktopE2eRuntimeTabReloadObservation[] = [];
  readonly #windowsMenuCaptures: Readonly<
    ElectronDesktopE2eWindowsReloadCommand & { sequence: number }
  >[] = [];

  constructor(input: ElectronDesktopE2eRuntimeTabReloadObserverInput) {
    this.#input = input;
  }

  failNext(windowId: string, tabId: string): void {
    if (this.#failNext) {
      throw new Error("A controlled Reload failure is already armed.");
    }
    const runtime = this.#input.readRuntime();
    const snapshot = runtime?.snapshot();
    const owners = snapshot?.windows.filter(
      (window) => window.windowId === windowId && window.visible &&
        window.activeTabId === tabId && window.tabIds.includes(tabId)
    ) ?? [];
    const roles = snapshot?.roles.filter((role) =>
      role.windowId === windowId && role.tabId === tabId
    ) ?? [];
    const role = roles[0];
    const surface = role && this.#input.roleSurfaceOwners.get(role.roleId);
    if (owners.length !== 1 || roles.length !== 1 || !role || !surface ||
        surface.generation !== role.generation || surface.tabId !== tabId ||
        !surface.registry.readProjection(role.roleId, role.generation).visible) {
      throw new Error("The controlled Reload failure target is not current.");
    }
    surface.registry.currentRolePreloadFrame(role.roleId, role.generation);
    this.#failNext = Object.freeze({
      tabId,
      topologyRevision: owners[0]!.topologyRevision,
      windowGeneration: owners[0]!.windowGeneration,
      windowId
    });
  }

  #consumeFailure(request: ElectronDesktopE2eReloadCommand): RionBridgeError | null {
    const armed = this.#failNext;
    if (!armed || armed.windowId !== request.windowId ||
        armed.tabId !== request.tabId) return null;
    this.#failNext = null;
    if (armed.windowGeneration !== request.windowGeneration ||
        armed.topologyRevision !== request.topologyRevision) {
      return new RionBridgeError({
        code: "ELECTRON_DESKTOP_E2E_RUNTIME_TAB_RELOAD_ARM_STALE",
        message: "The desktop E2E Reload failure arm lost its exact fence."
      });
    }
    const platform = this.#input.platform();
    const menuCapture = platform === "win32"
      ? [...this.#windowsMenuCaptures].reverse().find((capture) =>
          capture.tabId === request.tabId &&
          capture.windowId === request.windowId &&
          capture.windowGeneration === request.windowGeneration &&
          capture.topologyRevision === request.topologyRevision &&
          capture.lifecycleEpoch === request.lifecycleEpoch
        )
      : null;
    if (platform === "win32" && !menuCapture) {
      return new RionBridgeError({
        code: "ELECTRON_DESKTOP_E2E_RUNTIME_TAB_RELOAD_CAPTURE_MISSING",
        message: "The desktop E2E Reload failure has no visible menu capture."
      });
    }
    this.#failures.push(Object.freeze({
      failureCode: "ELECTRON_DESKTOP_E2E_RUNTIME_TAB_RELOAD_INJECTED",
      menuProjectionRevision: menuCapture?.projectionRevision ?? null,
      request: Object.freeze({ ...request }),
      sequence: this.#failures.length + 1
    }));
    if (this.#failures.length >
      ELECTRON_DESKTOP_E2E_RUNTIME_TAB_RELOAD_JOURNAL_CAPACITY) {
      this.#failures.shift();
    }
    return new RionBridgeError({
      code: "ELECTRON_DESKTOP_E2E_RUNTIME_TAB_RELOAD_INJECTED",
      message: "The desktop E2E harness injected one controlled Reload failure."
    });
  }

  install(): void {
    const observations = this.#observations;
    const consumeFailure = (request: ElectronDesktopE2eReloadCommand) =>
      this.#consumeFailure(request);
    const core = CoreAddonClient.prototype;
    const originalInvoke = core.invoke;
    core.invoke = function <Command extends CoreCommand>(
      command: Command
    ): Promise<CoreCommandResult<Command>> {
      if (command.type === "browserRuntimeTabReload") {
        const failure = consumeFailure(command as ElectronDesktopE2eReloadCommand);
        if (failure) {
          return Promise.reject(failure) as Promise<CoreCommandResult<Command>>;
        }
      }
      const terminal = originalInvoke.call(this, command) as
        Promise<CoreCommandResult<Command>>;
      if (command.type !== "browserRuntimeTabReload") return terminal;
      const request = command as ElectronDesktopE2eReloadCommand;
      return terminal.then((receipt) => {
        const reloadReceipt = receipt as BrowserTabReloadReceiptRecord;
        observations.push(Object.freeze({
          receipt: cloneReceipt(reloadReceipt),
          request: Object.freeze({ ...request }),
          sequence: observations.length + 1
        }));
        if (observations.length >
          ELECTRON_DESKTOP_E2E_RUNTIME_TAB_RELOAD_JOURNAL_CAPACITY) {
          observations.shift();
        }
        return receipt;
      }) as Promise<CoreCommandResult<Command>>;
    };

    const captures = this.#windowsMenuCaptures;
    const controller = WindowsRuntimeHostChromeController.prototype;
    const originalHandleCommand = controller.handleCommand;
    controller.handleCommand = function (url, candidate) {
      const terminal = originalHandleCommand.call(this, url, candidate);
      if (!isWindowsRuntimeHostCommand(candidate) ||
          candidate.type !== "reloadTab") return terminal;
      captures.push(Object.freeze({
        ...candidate,
        sequence: captures.length + 1
      }));
      if (captures.length >
        ELECTRON_DESKTOP_E2E_RUNTIME_TAB_RELOAD_JOURNAL_CAPACITY) {
        captures.shift();
      }
      return terminal;
    };
  }

  read(windowId: string): ElectronDesktopE2eRuntimeTabReloadInspection {
    const platform = this.#input.platform();
    const runtime = this.#input.readRuntime();
    if (!runtime) throw new Error(`Runtime window ${windowId} is unavailable.`);
    const snapshot = runtime.snapshot();
    const windows = snapshot.windows.filter((window) => window.windowId === windowId);
    if (windows.length !== 1) {
      throw new Error(`Runtime window ${windowId} has no exact native Reload owner.`);
    }
    const native = windows[0]!;
    const roles = Object.freeze(snapshot.roles
      .filter((role) => role.windowId === windowId)
      .map((role) => {
        const owner = this.#input.roleSurfaceOwners.get(role.roleId);
        if (!owner || owner.generation !== role.generation ||
            owner.tabId !== role.tabId) {
          throw new Error(`Role ${role.roleId} lost its exact Reload surface.`);
        }
        const frame = owner.registry.currentRolePreloadFrame(
          role.roleId,
          role.generation
        );
        const projection = owner.registry.readProjection(role.roleId, role.generation);
        return Object.freeze({
          documentInstanceId: frame.documentInstanceId,
          ownerGeneration: role.ownerGeneration,
          roleId: role.roleId,
          surfaceGeneration: role.generation,
          tabId: role.tabId,
          visible: projection.visible
        });
      })
      .sort((left, right) => left.roleId.localeCompare(right.roleId)));
    const popups = Object.freeze([...this.#input.popupHostOwners.values()]
      .filter(({ admission, host }) =>
        admission.parent.parentWindowId === windowId && !host.isDestroyed()
      )
      .map(({ admission, host, receipt }) => Object.freeze({
        appKitIdentity: receipt.appkitIdentity
          ? Object.freeze({ ...receipt.appkitIdentity })
          : null,
        hostKind: receipt.platform === "macos"
          ? "appkit-chromium" as const
          : "bundled-chromium" as const,
        logicalWindowId: receipt.logicalWindowId,
        nativeHostId: receipt.nativeHostId,
        openOperationId: admission.openOperationId,
        popupId: admission.popupId,
        visible: host.readProjection().visible
      }))
      .sort((left, right) => left.popupId.localeCompare(right.popupId)));
    const observations = Object.freeze(this.#observations.filter(
      (observation) => observation.request.windowId === windowId &&
        observation.request.windowGeneration === native.windowGeneration
    ).map((observation, index) => Object.freeze({
      ...observation,
      sequence: index + 1
    })));
    const failures = Object.freeze(this.#failures.filter(
      (failure) => failure.request.windowId === windowId &&
        failure.request.windowGeneration === native.windowGeneration
    ).map((failure, index) => Object.freeze({ ...failure, sequence: index + 1 })));
    const windowsMenuCaptures = Object.freeze(this.#windowsMenuCaptures.filter(
      (capture) => capture.windowId === windowId &&
        capture.windowGeneration === native.windowGeneration
    ).map((capture, index) => Object.freeze({ ...capture, sequence: index + 1 })));
    const inspection = parseElectronDesktopE2eRuntimeTabReloadInspection({
      capacity: ELECTRON_DESKTOP_E2E_RUNTIME_TAB_RELOAD_JOURNAL_CAPACITY,
      failures,
      journalVersion: 1,
      nativeWindow: Object.freeze({
        appKitIdentity: native.appKitIdentity
          ? Object.freeze({ ...native.appKitIdentity })
          : null,
        hostKind: native.appKitIdentity
          ? "appkit-chromium"
          : "bundled-chromium",
        parentNativeHostId: native.parentNativeHostId,
        tabIds: Object.freeze([...native.tabIds]),
        topologyRevision: native.topologyRevision,
        windowGeneration: native.windowGeneration
      }),
      observations,
      platform,
      popups,
      roles,
      windowId,
      windowsMenuCaptures
    });
    if (this.#input.artifactDirectory &&
        isAbsolute(this.#input.artifactDirectory)) {
      writeFileSync(
        join(
          this.#input.artifactDirectory,
          "electron-runtime-tab-reload-observations.json"
        ),
        `${JSON.stringify(inspection, null, 2)}\n`
      );
    }
    return inspection;
  }
}
