import { BaseWindow, Menu } from "electron";
import type { CoreAppSnapshotRecord } from "../../shared/generated";
import { RionBridgeError } from "../ipc/errors";
import type { ChromiumRuntimeBootstrap } from "./chromiumRuntimeBootstrap";
import type { ChromiumRuntimeExecutorSnapshot } from "./chromiumRuntimeEffectExecutor";
import type { MacosAppKitRuntimeTabMenuItem } from "./macosAppKitRuntimeTabMenu";
import { macosRuntimeTabMenuTemplate } from "./macosRuntimeTabMenuTemplate";

export function popupMacosRuntimeMenu(input: Readonly<{
  items: readonly MacosAppKitRuntimeTabMenuItem[]; parentNativeHostId: number;
}>): void {
  const parent = BaseWindow.fromId(input.parentNativeHostId);
  if (!parent || parent.isDestroyed()) {
    throw new RionBridgeError({
      code: "ELECTRON_MACOS_APPKIT_MENU_PARENT_STALE",
      message: "The retained AppKit menu lost its exact native parent."
    });
  }
  Menu.buildFromTemplate(macosRuntimeTabMenuTemplate(input.items)).popup({ window: parent });
}

export async function readRuntimeMenuSnapshot(input: Readonly<{
  settleNativeEvents: () => Promise<unknown>;
  runtime: Pick<ChromiumRuntimeBootstrap, "settleCurrentApplicationEffects" | "settleCurrentProjection">;
  readCore: () => Promise<CoreAppSnapshotRecord>;
  readNative: () => ChromiumRuntimeExecutorSnapshot;
}>) {
  await input.settleNativeEvents();
  await input.runtime.settleCurrentApplicationEffects();
  await input.runtime.settleCurrentProjection();
  const core = await input.readCore();
  await input.runtime.settleCurrentProjection();
  return { core, native: input.readNative() };
}

export { macosRuntimeTabMenuLanguage } from "./macosRuntimeTabMenuTemplate";
