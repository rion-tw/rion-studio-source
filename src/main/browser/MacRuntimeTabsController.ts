import { existsSync } from "node:fs";
import { createRequire } from "node:module";

import type { BaseWindow } from "electron";

import {
  isRuntimeTabAction,
  type RuntimeTabAction,
  type RuntimeTabChromeState
} from "../../shared/runtimeTabs";
import type { AppLanguage, WorkspaceLayoutTemplate } from "../../shared/types";

export type MacRuntimeTabsFullscreenPolicy = "always" | "autoHide";

export interface MacRuntimeTabsContentLayout {
  heightInset: number;
  valid: boolean;
  yOffset: number;
}

export interface MacRuntimeTabsController {
  destroy(): void;
  getContentLayout(): MacRuntimeTabsContentLayout;
  prepareFullscreenTransition(fullscreen: boolean): void;
  setFullscreenPolicy(policy: MacRuntimeTabsFullscreenPolicy): void;
  setRevealLocked(locked: boolean): void;
  update(state: RuntimeTabChromeState): void;
}

export type MacRuntimeTabsControllerFactory = (
  window: BaseWindow,
  onAction: (action: RuntimeTabAction) => void,
  onContentLayoutChange: (layout: MacRuntimeTabsContentLayout) => void
) => MacRuntimeTabsController;

interface MacRuntimeTabsNativeTab {
  active: boolean;
  iconDataUrl?: string;
  id: string;
  name: string;
  roleCount: number;
  type: "role" | "workspace";
  workspaceTemplate?: WorkspaceLayoutTemplate;
}

export interface MacRuntimeTabsNativeState {
  displayId: number;
  labels: {
    add: string;
    more: string;
  };
  tabs: MacRuntimeTabsNativeTab[];
}

export interface MacRuntimeTabsNativeAddon {
  createController(
    windowHandle: Buffer,
    callback: (action: unknown) => void,
    contentLayoutCallback: (layout: unknown) => void
  ): number;
  destroyController(controllerId: number): void;
  getContentLayout(controllerId: number): unknown;
  prepareFullscreenTransition(controllerId: number, fullscreen: boolean): void;
  protocolVersion: number;
  setFullscreenPolicy(
    controllerId: number,
    policy: MacRuntimeTabsFullscreenPolicy
  ): void;
  setRevealLocked(controllerId: number, locked: boolean): void;
  updateController(controllerId: number, state: MacRuntimeTabsNativeState): void;
}

const labels: Record<AppLanguage, MacRuntimeTabsNativeState["labels"]> = {
  en: {
    add: "Open role or workspace",
    more: "More actions"
  },
  "zh-TW": {
    add: "開啟角色或工作區",
    more: "更多操作"
  },
  "zh-CN": {
    add: "打开角色或工作区",
    more: "更多操作"
  },
  ja: {
    add: "ロールまたはワークスペースを開く",
    more: "その他の操作"
  }
};

const NATIVE_PROTOCOL_VERSION = 4;
const INVALID_CONTENT_LAYOUT: MacRuntimeTabsContentLayout = {
  heightInset: 0,
  valid: false,
  yOffset: 0
};

export function isMacRuntimeTabsContentLayout(
  value: unknown
): value is MacRuntimeTabsContentLayout {
  if (!value || typeof value !== "object") return false;
  const layout = value as Record<string, unknown>;
  return typeof layout.valid === "boolean" &&
    Number.isInteger(layout.heightInset) &&
    (layout.heightInset as number) >= 0 &&
    Number.isInteger(layout.yOffset) &&
    (layout.yOffset as number) >= 0 &&
    (layout.heightInset as number) >= (layout.yOffset as number);
}

export function toMacRuntimeTabsNativeState(
  state: RuntimeTabChromeState
): MacRuntimeTabsNativeState {
  return {
    displayId: state.displayId,
    labels: labels[state.language],
    tabs: state.tabs
      .filter((tab) => tab.displayId === state.displayId && !tab.hidden)
      .map((tab) => ({
        active: tab.active,
        ...(state.tabIconDataUrls[tab.id]
          ? { iconDataUrl: state.tabIconDataUrls[tab.id] }
          : {}),
        id: tab.id,
        name: tab.name,
        roleCount: tab.type === "workspace" ? tab.roleIds.length : 0,
        type: tab.type,
        ...(state.tabWorkspaceTemplates[tab.id]
          ? { workspaceTemplate: state.tabWorkspaceTemplates[tab.id] }
          : {})
      }))
  };
}

export function createMacRuntimeTabsControllerFactory(
  nativeAddon: MacRuntimeTabsNativeAddon
): MacRuntimeTabsControllerFactory {
  if (nativeAddon.protocolVersion !== NATIVE_PROTOCOL_VERSION) {
    throw new Error(
      `Unsupported macOS runtime tabs protocol ${nativeAddon.protocolVersion}; expected ${NATIVE_PROTOCOL_VERSION}.`
    );
  }

  return (window, onAction, onContentLayoutChange) => {
    let destroyed = false;
    const controllerId = nativeAddon.createController(
      window.getNativeWindowHandle(),
      (action) => {
        if (!destroyed && isRuntimeTabAction(action)) onAction(action);
      },
      (layout) => {
        if (!destroyed && isMacRuntimeTabsContentLayout(layout)) {
          onContentLayoutChange(layout);
        }
      }
    );

    return {
      destroy: () => {
        if (destroyed) return;
        destroyed = true;
        nativeAddon.destroyController(controllerId);
      },
      getContentLayout: () => {
        if (destroyed) return INVALID_CONTENT_LAYOUT;
        const layout = nativeAddon.getContentLayout(controllerId);
        return isMacRuntimeTabsContentLayout(layout)
          ? layout
          : INVALID_CONTENT_LAYOUT;
      },
      prepareFullscreenTransition: (fullscreen) => {
        if (!destroyed) {
          nativeAddon.prepareFullscreenTransition(controllerId, fullscreen);
        }
      },
      setFullscreenPolicy: (policy) => {
        if (!destroyed) nativeAddon.setFullscreenPolicy(controllerId, policy);
      },
      setRevealLocked: (locked) => {
        if (!destroyed) nativeAddon.setRevealLocked(controllerId, locked);
      },
      update: (state) => {
        if (!destroyed) {
          nativeAddon.updateController(controllerId, toMacRuntimeTabsNativeState(state));
        }
      }
    };
  };
}

export function loadMacRuntimeTabsControllerFactory(
  addonPath: string,
  logger: Pick<Console, "warn"> = console
): MacRuntimeTabsControllerFactory | undefined {
  if (!existsSync(addonPath)) {
    logger.warn(
      `macOS runtime tabs addon was not found at ${addonPath}; using the HTML fallback.`
    );
    return undefined;
  }

  try {
    const require = createRequire(import.meta.url);
    const nativeAddon = require(addonPath) as MacRuntimeTabsNativeAddon;
    return createMacRuntimeTabsControllerFactory(nativeAddon);
  } catch (error) {
    logger.warn(
      "Failed to load the macOS runtime tabs addon; using the HTML fallback.",
      error
    );
    return undefined;
  }
}
