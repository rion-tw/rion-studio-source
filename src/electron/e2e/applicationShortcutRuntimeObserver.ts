import { BrowserWindow } from "electron";
import { writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import type { RuntimeWindowZoomReceiptRecord } from "../../shared/generated";
import type { CoreAddonClient } from "../core/coreAddonClient";
import type { ChromiumGlobalWebPresentationRegistry } from
  "../main/chromiumGlobalWebPresentationRegistry";
import type { ChromiumRuntimeBootstrap } from "../main/chromiumRuntimeBootstrap";
import type { ChromiumRuntimeHostPort } from "../main/chromiumRuntimeHostPorts";
import { ChromiumRuntimeNativeWindowController } from
  "../main/chromiumRuntimeNativeWindowController";
import type { ChromiumRoleSurfaceRegistry } from
  "../main/chromiumRoleSurfaceRegistry";
import {
  ELECTRON_DESKTOP_E2E_WINDOW_ZOOM_JOURNAL_CAPACITY,
  ElectronDesktopE2eWindowZoomJournal,
  parseElectronDesktopE2eApplicationShortcutRuntimeInspection,
  type ElectronDesktopE2eApplicationShortcutRuntimeInspection
} from "./applicationShortcutRuntimeInspection";
import type { ElectronDesktopE2eSenderPort } from "./desktopE2eBridge";

interface RoleSurfaceOwner {
  readonly generation: number;
  readonly registry: ChromiumRoleSurfaceRegistry;
  readonly tabId: string;
}

interface GlobalWebSurfaceOwner {
  readonly generation: number;
  readonly registry: ChromiumGlobalWebPresentationRegistry;
  readonly slotId: string;
}

interface PopupHostOwner {
  readonly admission: Readonly<{
    parent: Readonly<{ parentWindowId: string }>;
  }>;
  readonly host: ChromiumRuntimeHostPort;
}

export interface ElectronDesktopE2eApplicationShortcutRuntimeObserverInput {
  readonly artifactDirectory: string | undefined;
  readonly platform: () => "darwin" | "win32";
  readonly readCore: () => CoreAddonClient | null;
  readonly readRuntime: () => Pick<ChromiumRuntimeBootstrap, "snapshot"> | null;
  readonly globalWebSurfaceOwners: ReadonlyMap<string, GlobalWebSurfaceOwner>;
  readonly popupHostOwners: ReadonlyMap<string, PopupHostOwner>;
  readonly roleSurfaceOwners: ReadonlyMap<string, RoleSurfaceOwner>;
}

function finiteZoom(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) &&
    value >= 0.25 && value <= 5;
}

function effectiveZoom(base: number, windowFactor: number): number {
  return Math.min(5, Math.max(0.25, base * windowFactor));
}

function sameNumber(left: number, right: number): boolean {
  return Math.abs(left - right) <= Number.EPSILON * 16;
}

/** E2E-only observer for exact application-menu runtime-window shortcuts. */
export class ElectronDesktopE2eApplicationShortcutRuntimeObserver {
  readonly #input: ElectronDesktopE2eApplicationShortcutRuntimeObserverInput;
  readonly #observations: ElectronDesktopE2eApplicationShortcutRuntimeInspection[] = [];
  readonly #zoomJournal = new ElectronDesktopE2eWindowZoomJournal();

  constructor(input: ElectronDesktopE2eApplicationShortcutRuntimeObserverInput) {
    this.#input = input;
  }

  install(): void {
    const controller = ChromiumRuntimeNativeWindowController.prototype;
    const originalZoomRuntimeWindow = controller.zoomRuntimeWindow;
    const appendZoomReceipt = (receipt: RuntimeWindowZoomReceiptRecord): void =>
      this.#zoomJournal.append(receipt);
    controller.zoomRuntimeWindow = async function (target, action) {
      const receipt = await originalZoomRuntimeWindow.call(this, target, action);
      appendZoomReceipt(receipt);
      return receipt;
    };
  }

  async read(
    windowId: string,
    sender: ElectronDesktopE2eSenderPort
  ): Promise<ElectronDesktopE2eApplicationShortcutRuntimeInspection> {
    const core = this.#input.readCore();
    const runtime = this.#input.readRuntime();
    if (!core || !runtime) {
      throw new Error(
        `Runtime window ${windowId} has no observed Core/native shortcut owner.`
      );
    }
    const coreSnapshot = await core.invoke({ type: "appSnapshot" });
    const nativeSnapshot = runtime.snapshot();
    const logicalWindows = coreSnapshot.logicalWindows.filter(
      (window) => window.windowId === windowId
    );
    const browserWindows = coreSnapshot.browserRuntime.windows.filter(
      (window) => window.windowId === windowId
    );
    const nativeWindows = nativeSnapshot.windows.filter(
      (window) => window.windowId === windowId
    );
    if (
      logicalWindows.length !== 1 || browserWindows.length !== 1 ||
      nativeWindows.length !== 1
    ) {
      throw new Error(
        `Runtime window ${windowId} has divergent Core/browser/native shortcut ownership.`
      );
    }
    const logical = logicalWindows[0]!;
    const browserRuntime = browserWindows[0]!;
    const native = nativeWindows[0]!;
    const nativeWindowZoomFactor = native.windowZoomFactor;
    const coreTabIds = logical.tabs.map((tab) => tab.id);
    if (
      !logical.activeTabId || logical.activeTabId !== browserRuntime.activeTabId ||
      logical.activeTabId !== native.activeTabId ||
      logical.windowGeneration !== native.windowGeneration ||
      logical.revision !== native.topologyRevision ||
      logical.presentation !== native.presentation ||
      JSON.stringify(coreTabIds) !== JSON.stringify(browserRuntime.tabIds) ||
      JSON.stringify(coreTabIds) !== JSON.stringify(native.tabIds) ||
      !Number.isSafeInteger(native.parentNativeHostId) ||
      (native.parentNativeHostId ?? 0) < 1 || !finiteZoom(nativeWindowZoomFactor)
    ) {
      throw new Error(`Runtime window ${windowId} lost its exact shortcut fence.`);
    }
    const platform = this.#input.platform();
    if (
      (platform === "darwin" && !native.appKitIdentity) ||
      (platform === "win32" && native.appKitIdentity)
    ) {
      throw new Error(`Runtime window ${windowId} has an invalid native shortcut host.`);
    }
    if (
      !finiteZoom(logical.windowZoomFactor) ||
      !sameNumber(logical.windowZoomFactor, nativeWindowZoomFactor)
    ) {
      throw new Error(`Runtime window ${windowId} has a stale direct Core zoom factor.`);
    }

    const mainWindow = this.#readMainWindow(sender);
    const roleSurfaces = Object.freeze(nativeSnapshot.roles
      .filter((role) => role.windowId === windowId)
      .map((role) => {
        const owner = this.#input.roleSurfaceOwners.get(role.roleId);
        if (
          !owner || owner.generation !== role.generation || owner.tabId !== role.tabId
        ) {
          throw new Error(
            `Role ${role.roleId} lost its exact shortcut surface owner.`
          );
        }
        const projection = owner.registry.readProjection(role.roleId, role.generation);
        const baseZoomFactor = role.zoomFactor ?? 1;
        if (
          !finiteZoom(baseZoomFactor) || !finiteZoom(projection.zoomFactor) ||
          !sameNumber(
            projection.zoomFactor,
            effectiveZoom(baseZoomFactor, nativeWindowZoomFactor)
          )
        ) {
          throw new Error(`Role ${role.roleId} has a stale shortcut zoom readback.`);
        }
        return Object.freeze({
          appliedZoomFactor: projection.zoomFactor,
          baseZoomFactor,
          generation: role.generation,
          roleId: role.roleId,
          tabId: role.tabId,
          visible: projection.visible
        });
      })
      .sort((left, right) => left.roleId.localeCompare(right.roleId)));
    const globalWebSurfaces = Object.freeze(nativeSnapshot.webSurfaces
      .filter((surface) => surface.windowId === windowId)
      .map((surface) => {
        const owner = this.#input.globalWebSurfaceOwners.get(surface.surfaceId);
        if (
          !owner || owner.generation !== surface.generation ||
          owner.slotId !== surface.slotId
        ) {
          throw new Error(
            `Global Web surface ${surface.surfaceId} lost its exact shortcut owner.`
          );
        }
        const projection = owner.registry.readProjection(
          surface.surfaceId,
          surface.generation
        );
        const baseZoomFactor = surface.zoomFactor ?? 1;
        if (
          !finiteZoom(baseZoomFactor) || !finiteZoom(projection.zoomFactor) ||
          !sameNumber(
            projection.zoomFactor,
            effectiveZoom(baseZoomFactor, nativeWindowZoomFactor)
          )
        ) {
          throw new Error(
            `Global Web surface ${surface.surfaceId} has a stale shortcut zoom readback.`
          );
        }
        return Object.freeze({
          appliedZoomFactor: projection.zoomFactor,
          baseZoomFactor,
          generation: surface.generation,
          slotId: surface.slotId,
          surfaceId: surface.surfaceId,
          tabId: surface.tabId,
          visible: projection.visible
        });
      })
      .sort((left, right) => left.surfaceId.localeCompare(right.surfaceId)));
    const livePopupCount = [...this.#input.popupHostOwners.values()].filter(
      ({ admission, host }) => admission.parent.parentWindowId === windowId &&
        !host.isDestroyed()
    ).length;
    if (livePopupCount !== 0) {
      throw new Error(
        `Runtime window ${windowId} has a live popup without exact shortcut zoom evidence.`
      );
    }

    const zoomObservations = this.#zoomJournal.read(
      windowId,
      native.windowGeneration
    );
    const inspection = parseElectronDesktopE2eApplicationShortcutRuntimeInspection({
      coreWindow: Object.freeze({
        activeTabId: logical.activeTabId,
        presentation: logical.presentation,
        tabIds: Object.freeze([...coreTabIds]),
        topologyRevision: logical.revision,
        windowGeneration: logical.windowGeneration,
        windowId,
        windowZoomFactor: logical.windowZoomFactor
      }),
      globalWebSurfaces,
      mainWindow,
      nativeWindow: Object.freeze({
        activeTabId: native.activeTabId,
        appKitIdentity: native.appKitIdentity
          ? Object.freeze({ ...native.appKitIdentity })
          : null,
        focused: native.focused,
        hostKind: native.appKitIdentity ? "appkit-chromium" : "bundled-chromium",
        parentNativeHostId: native.parentNativeHostId!,
        presentation: native.presentation,
        tabIds: Object.freeze([...native.tabIds]),
        topologyRevision: native.topologyRevision,
        visible: native.visible,
        windowGeneration: native.windowGeneration,
        windowId,
        windowZoomFactor: nativeWindowZoomFactor
      }),
      popupSurfaces: Object.freeze([]),
      roleSurfaces,
      windowId,
      zoomJournal: Object.freeze({
        capacity: ELECTRON_DESKTOP_E2E_WINDOW_ZOOM_JOURNAL_CAPACITY,
        journalVersion: 1,
        observations: zoomObservations
      })
    });
    const prior = this.#observations.at(-1);
    if (JSON.stringify(prior) !== JSON.stringify(inspection)) {
      this.#observations.push(inspection);
      this.#writeObservations();
    }
    return inspection;
  }

  #readMainWindow(
    sender: ElectronDesktopE2eSenderPort
  ): ElectronDesktopE2eApplicationShortcutRuntimeInspection["mainWindow"] {
    if (!Number.isSafeInteger(sender.id) || (sender.id ?? 0) < 1) {
      throw new Error("The application-shortcut sender has no exact WebContents identity.");
    }
    const owners = BrowserWindow.getAllWindows().filter((window) =>
      !window.isDestroyed() && window.webContents.id === sender.id &&
      window.webContents.getURL() === sender.getURL());
    if (owners.length !== 1) {
      throw new Error("The application-shortcut sender has no exact main BrowserWindow.");
    }
    const owner = owners[0]!;
    const zoomFactor = owner.webContents.getZoomFactor();
    if (!finiteZoom(zoomFactor)) {
      throw new Error("The main BrowserWindow has an invalid zoom readback.");
    }
    return Object.freeze({
      browserWindowId: owner.id,
      fullscreen: owner.isFullScreen(),
      webContentsId: owner.webContents.id,
      zoomFactor
    });
  }

  #writeObservations(): void {
    const directory = this.#input.artifactDirectory;
    if (!directory || !isAbsolute(directory)) return;
    writeFileSync(
      join(directory, "electron-application-shortcut-runtime-observations.json"),
      `${JSON.stringify(this.#observations, null, 2)}\n`
    );
  }
}
