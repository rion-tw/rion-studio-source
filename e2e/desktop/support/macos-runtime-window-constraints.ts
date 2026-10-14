import { browser } from "@wdio/globals";
import {
  electronDesktopE2eGameWindowRuntime,
  electronDesktopE2eFullscreenToolbarRuntime,
  type ElectronDesktopE2eFullscreenToolbarRuntimeInspection,
  type ElectronDesktopE2eGameWindowRuntimeInspection
} from "./electron-driver";

type Owner = NonNullable<ElectronDesktopE2eGameWindowRuntimeInspection["currentRuntime"]>;
type Inspection = Pick<ElectronDesktopE2eFullscreenToolbarRuntimeInspection,
  "hostKind" | "native" | "topologyRevision" | "windowGeneration" | "windowId">;

function exactOwner(inspection: Inspection, runtime: ElectronDesktopE2eGameWindowRuntimeInspection): Owner {
  const owner = runtime.currentRuntime;
  if (inspection.hostKind !== "appkit" || runtime.windowId !== inspection.windowId ||
      !owner || owner.hostKind !== "appkit-chromium" || !owner.visible ||
      owner.nativeDisplay.presentation !== "normal" || owner.windowId !== inspection.windowId ||
      owner.windowGeneration !== inspection.windowGeneration ||
      owner.topologyRevision !== inspection.topologyRevision ||
      inspection.native.windowId !== owner.windowId ||
      inspection.native.windowGeneration !== owner.windowGeneration ||
      inspection.native.topologyRevision !== owner.topologyRevision ||
      !Number.isSafeInteger(owner.windowGeneration) || owner.windowGeneration <= 0 ||
      !Number.isSafeInteger(owner.topologyRevision) || owner.topologyRevision <= 0 ||
      !Number.isSafeInteger(owner.parentNativeHostId) || owner.parentNativeHostId <= 0 ||
      !owner.appKitIdentity || !owner.appKitIdentity.launchGeneration ||
      owner.appKitIdentity.logicalWindowId !== owner.windowId ||
      !Number.isSafeInteger(owner.appKitIdentity.nativeGeneration) ||
      owner.appKitIdentity.nativeGeneration <= 0 ||
      owner.coreTabIds.length !== owner.nativeTabIds.length ||
      owner.coreTabIds.some((tabId, index) => tabId !== owner.nativeTabIds[index])) {
    throw new Error("Mac resize constraints require the exact visible Core/AppKit owner");
  }
  return owner;
}

function exactMinimum(inspection: Inspection, current: ElectronDesktopE2eFullscreenToolbarRuntimeInspection) {
  const minimum = current.native.appKit?.minimumFrameSize;
  const expected = inspection.native.appKit?.minimumFrameSize;
  if (current.hostKind !== "appkit" || current.presentation !== "normal" ||
      current.windowId !== inspection.windowId || current.windowGeneration !== inspection.windowGeneration ||
      current.topologyRevision !== inspection.topologyRevision ||
      current.native.windowId !== current.windowId ||
      current.native.windowGeneration !== current.windowGeneration ||
      current.native.topologyRevision !== current.topologyRevision || !minimum || !expected ||
      ![minimum.width, minimum.height].every(value => Number.isFinite(value) && value > 0) ||
      minimum.width !== expected.width || minimum.height !== expected.height) {
    throw new Error("Mac resize constraints require the exact current AppKit minimum frame size");
  }
  return minimum;
}

/** Read actual NSWindow constraints through its fenced native controller; never mutate it. */
export async function readMacosRuntimeWindowConstraints(input: Readonly<{
  inspection: Inspection; processId: number;
}>) {
  if (!Number.isSafeInteger(input.processId) || input.processId <= 1) {
    throw new Error("Mac resize constraints require an exact native process");
  }
  const before = exactOwner(input.inspection,
    await electronDesktopE2eGameWindowRuntime(input.inspection.windowId));
  const minimum = exactMinimum(input.inspection,
    await electronDesktopE2eFullscreenToolbarRuntime(input.inspection.windowId));
  const native = await browser.electron.execute((electron, target) => {
    const host = electron.BaseWindow.fromId(target.parentNativeHostId);
    const assertLive = () => {
      if (process.pid !== target.processId || !host || host.isDestroyed() ||
          host.id !== target.parentNativeHostId ||
          electron.BaseWindow.fromId(target.parentNativeHostId) !== host ||
          !host.isVisible() || host.isMinimized() || host.isFullScreen() || host.isMaximized()) {
        throw new Error("Mac resize constraints lost the exact live normal BaseWindow");
      }
    };
    assertLive();
    if (!host) throw new Error("Mac resize constraints have no native BaseWindow");
    const handle = host.getNativeWindowHandle().toString("hex");
    if (!handle || /^0+$/u.test(handle)) throw new Error("Mac resize constraints have no native handle");
    const frame = host.getBounds();
    const afterHandle = host.getNativeWindowHandle().toString("hex");
    assertLive();
    if (afterHandle !== handle ||
        ![frame.width, frame.height].every(value => Number.isSafeInteger(value) && value > 0)) {
      throw new Error("Mac resize constraints native readback changed or is invalid");
    }
    return { processId: process.pid, parentNativeHostId: host.id, nativeWindowHandle: handle,
      frame };
  }, { processId: input.processId, parentNativeHostId: before.parentNativeHostId });
  exactMinimum(input.inspection,
    await electronDesktopE2eFullscreenToolbarRuntime(input.inspection.windowId));
  const after = exactOwner(input.inspection,
    await electronDesktopE2eGameWindowRuntime(input.inspection.windowId));
  if (after.parentNativeHostId !== before.parentNativeHostId ||
      after.appKitIdentity!.launchGeneration !== before.appKitIdentity!.launchGeneration ||
      after.appKitIdentity!.nativeGeneration !== before.appKitIdentity!.nativeGeneration ||
      after.coreTabIds.length !== before.coreTabIds.length ||
      after.coreTabIds.some((tabId, index) => tabId !== before.coreTabIds[index])) {
    throw new Error("Mac resize constraints Core/AppKit owner changed during the native read");
  }
  return { ...native, minimumWidth: minimum.width, minimumHeight: minimum.height,
    windowId: after.windowId, windowGeneration: after.windowGeneration,
    topologyRevision: after.topologyRevision, appKitIdentity: after.appKitIdentity! };
}
