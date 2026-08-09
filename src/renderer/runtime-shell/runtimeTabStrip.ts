import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";

import {
  Columns2,
  Gamepad2,
  Grid2x2,
  Square,
  Volume2,
  VolumeX,
  X,
  type LucideIcon
} from "lucide-react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { RuntimeTabAction, RuntimeTabStripState } from "../../shared/runtimeTabs";
import type {
  RuntimeTabIntentReceiptRecord,
  RuntimeTabIntentRecord,
  RuntimeTabChromeProjectionRecord,
  SystemRuntimeOperationSummaryRecord
} from "../../shared/generated";
import type { WorkspaceLayoutTemplate } from "../../shared/types";
import { handleSystemRuntimeReceipt } from "../src/app/systemRuntimeReceipt";
import {
  optimisticallyActivateAdjacentTab,
  optimisticallyActivateTab,
  optimisticallyCloseTab
} from "./runtimeTabStrip/drag";
import {
  installRuntimeTabStrip,
  tabElements
} from "./runtimeTabStrip/entry";
import { announceChromeReady } from "./runtimeTabStrip/chromeProjection";

declare global {
  interface Window {
    __rionApplyRuntimeTabState?: (state: RuntimeTabStripState) => void;
    __rionApplyRuntimeTabChromeMutation?: (
      revision: number,
      mutation: () => void
    ) => void;
    __rionApplyRuntimeTabChromeProjection?: (
      projection: RuntimeTabChromeProjectionRecord
    ) => void;
    __rionEnsureRuntimeTab?: (tab: ProvisionalRuntimeTab) => void;
    __rionPendingRuntimeTabOrder?: string[];
    __rionPendingRuntimeTabEnsures?: ProvisionalRuntimeTab[];
    __rionPendingRuntimeTabChromeMutations?: Array<{
      mutation: () => void;
      revision: number;
    }>;
    __rionPendingRuntimeTabs?: ProvisionalRuntimeTab[];
    __rionRemoveRuntimeTab?: (tabId: string, nextTabId?: string) => void;
    __rionReorderRuntimeTabs?: (tabIds: string[]) => void;
    __rionReserveRuntimeTab?: (tab: ProvisionalRuntimeTab) => void;
    __rionSetActiveRuntimeTab?: (tabId?: string) => void;
    __rionRuntimeTabChromeReady?: boolean;
    __rionAnnounceRuntimeTabChromeReady?: () => void;
    __rionRuntimeTabChromeIdentity?: {
      lifecycleEpoch: number;
      windowGeneration: number;
      windowId: string;
    };
    __rionRuntimeTabWindowsMicaEnabled?: boolean;
    __rionUpdateRuntimeTabMetadata?: (tab: RuntimeTabMetadata) => void;
    __rionUpdateRuntimeTabMetadataBatch?: (tabs: RuntimeTabMetadata[]) => void;
  }
}

export function applyRuntimeTabWindowsMaterial(): void {
  document.documentElement.dataset.windowsMica =
    window.__rionRuntimeTabWindowsMicaEnabled === true ? "enabled" : "fallback";
}

applyRuntimeTabWindowsMaterial();

type ProvisionalRuntimeTab = {
  id: string;
  name: string;
  type: "role" | "workspace";
  workspaceTemplate?: WorkspaceLayoutTemplate | null;
};

type RuntimeTabMetadata = ProvisionalRuntimeTab & {
  audible: boolean;
  audioMuted: boolean;
  closeLabel: string;
  hideCloseButton: boolean;
  iconDataUrl?: string | null;
  mutedLabel: string;
  phase: "reserved" | "attaching" | "loading" | "ready" | "degraded" | "failed";
  playingLabel: string;
  sourceId: string;
  tooltip: string;
};

export const root = document.querySelector<HTMLDivElement>("#tabs")!;
export const add = document.querySelector<HTMLButtonElement>("#add")!;
export const scrollLeftButton = document.querySelector<HTMLButtonElement>("#scroll-left")!;
export const scrollRightButton = document.querySelector<HTMLButtonElement>("#scroll-right")!;
export const windowIdentity = document.querySelector<HTMLElement>("#window-identity")!;
export const windowName = document.querySelector<HTMLElement>("#window-name")!;
export const windowDragRegion = document.querySelector<HTMLElement>("#window-drag-region")!;
export const windowControls = document.querySelector<HTMLElement>("#window-controls")!;
export const windowMinimizeButton = document.querySelector<HTMLButtonElement>("#window-minimize")!;
export const windowMaximizeButton = document.querySelector<HTMLButtonElement>("#window-maximize")!;
export const windowCloseButton = document.querySelector<HTMLButtonElement>("#window-close")!;

export const runtimeState = {
  activeTabId: undefined as string | undefined,
  chromeHydrated: false,
  current: undefined as RuntimeTabStripState | undefined,
  optimisticActiveTabId: undefined as string | undefined,
  intentSequence: 0,
  projectionRevision: 0,
  topologyRevision: 0,
  rendererInstanceId: globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
  renderRevision: 0,
  scrollControlsFrame: undefined as number | undefined
};

export const workspaceTemplateByTabId = new Map<string, WorkspaceLayoutTemplate>();
const iconMarkup = new Map<LucideIcon, string>();
export const iconSignatureByButton = new WeakMap<HTMLButtonElement, string>();
export const audioSignatureByButton = new WeakMap<HTMLButtonElement, string>();
export const reorderAnimationFrameByElement = new Map<HTMLElement, number>();
export const OVERFLOW_EPSILON = 1;
export type RuntimeTabModel = RuntimeTabStripState["tabs"][number];
let runtimeTabReorderBarrier: Promise<void> = Promise.resolve();

export function logicalRuntimeTabOrder(): string[] {
  return tabElements().flatMap((tab) => tab.dataset.tabId ? [tab.dataset.tabId] : []);
}

export function createLucideSvg(Icon: LucideIcon): SVGSVGElement {
  let markup = iconMarkup.get(Icon);
  if (!markup) {
    markup = renderToStaticMarkup(createElement(Icon, {
      "aria-hidden": true,
      className: "glyph",
      focusable: false,
      size: 16,
      strokeWidth: 2
    }));
    iconMarkup.set(Icon, markup);
  }
  const template = document.createElement("template");
  template.innerHTML = markup;
  return template.content.querySelector<SVGSVGElement>("svg")!;
}

function fallbackIconForTab(
  type: ProvisionalRuntimeTab["type"],
  workspaceTemplate?: WorkspaceLayoutTemplate | null
): LucideIcon {
  if (type === "role") return Gamepad2;
  if (workspaceTemplate === "single") return Square;
  if (workspaceTemplate?.includes("columns")
    || workspaceTemplate?.includes("left")
    || workspaceTemplate?.includes("right")) {
    return Columns2;
  }
  return Grid2x2;
}

export function createTabIcon(
  type: ProvisionalRuntimeTab["type"],
  iconDataUrl?: string | null,
  workspaceTemplate?: WorkspaceLayoutTemplate | null
): HTMLImageElement | HTMLSpanElement {
  if (iconDataUrl) {
    const image = document.createElement("img");
    image.alt = "";
    image.className = "icon";
    image.draggable = false;
    image.src = iconDataUrl;
    return image;
  }
  const fallback = document.createElement("span");
  fallback.className = "icon fallback";
  fallback.ariaHidden = "true";
  fallback.append(createLucideSvg(fallbackIconForTab(type, workspaceTemplate)));
  return fallback;
}

export function createAudioIndicator(
  audioMuted: boolean,
  audible: boolean,
  mutedLabel: string,
  playingLabel: string
): HTMLSpanElement {
  const audio = document.createElement("span");
  audio.className = "audio";
  if (!audioMuted && !audible) {
    audio.classList.add("idle");
    audio.ariaHidden = "true";
    return audio;
  }
  audio.role = "img";
  audio.ariaLabel = audioMuted ? mutedLabel : playingLabel;
  audio.append(createLucideSvg(audioMuted ? VolumeX : Volume2));
  return audio;
}

export const dispatch = (action: RuntimeTabAction): void => {
  if (action.type === "activate") optimisticallyActivateTab(action.tabId);
  else if (action.type === "activateAdjacent") optimisticallyActivateAdjacentTab(action.direction);
  else if (action.type === "stop") optimisticallyCloseTab(action.tabId);
  const committedAction = action.type === "stop" ? (() => {
    runtimeState.intentSequence += 1;
    const intent: RuntimeTabIntentRecord = {
      adapterSequence: runtimeState.intentSequence,
      intentId: globalThis.crypto?.randomUUID?.()
        ?? `${runtimeState.rendererInstanceId}-${runtimeState.intentSequence}`,
      intentKind: "stop",
      rendererInstanceId: runtimeState.rendererInstanceId,
      tabId: action.tabId
    };
    return { type: "stop", intent };
  })() : action;
  const invokeAction = () => invoke<
    RuntimeTabIntentReceiptRecord | SystemRuntimeOperationSummaryRecord | null
  >(
    "rion_runtime_tab_action",
    { action: committedAction }
  );
  const invocation = action.type === "windowControl" && action.control === "close"
    ? runtimeTabReorderBarrier.then(invokeAction)
    : invokeAction();
  void invocation.then(async (receipt) => {
    if (action.type === "stop") {
      const intentReceipt = receipt as RuntimeTabIntentReceiptRecord | null;
      if (!intentReceipt) return;
      if (!intentReceipt.topologyCommitted) {
        announceChromeReady(
          runtimeState.rendererInstanceId,
          window.__rionRuntimeTabChromeIdentity
        );
      }
      if (intentReceipt.status === "degraded"
        || intentReceipt.status === "failed"
        || intentReceipt.status === "indeterminate") {
        await emit("rion://shell-error", {
          code: intentReceipt.failureCode ?? "SYSTEM_TAB_STOP_DEGRADED",
          message: intentReceipt.topologyCommitted
            ? "The tab was closed, but native cleanup completed with reduced guarantees."
            : "The tab close intent was rejected before the live topology commit."
        });
      }
      return;
    }
    const operationReceipt = receipt as SystemRuntimeOperationSummaryRecord | null;
    const handlesReceipt = action.type === "hide"
      || action.type === "move"
      || action.type === "reorder"
      || (action.type === "windowControl" && action.control !== "close");
    if (!handlesReceipt || !operationReceipt) return;
    try {
      handleSystemRuntimeReceipt(operationReceipt);
      if (operationReceipt.status === "degraded") {
        await emit("rion://shell-error", {
          code: operationReceipt.failureCode ?? "SYSTEM_NATIVE_OPERATION_DEGRADED",
          message: "The native window operation completed with reduced guarantees."
        });
      }
    } catch (error) {
      const issue = error as { code?: string; message?: string };
      await emit("rion://shell-error", {
        code: issue.code ?? operationReceipt.failureCode ?? "SYSTEM_NATIVE_OPERATION_FAILED",
        message: issue.message ?? "The native window operation failed."
      });
    }
  }).catch(async (error: unknown) => {
    if (action.type !== "stop") return;
    announceChromeReady(
      runtimeState.rendererInstanceId,
      window.__rionRuntimeTabChromeIdentity
    );
    const issue = error as { code?: string; message?: string };
    await emit("rion://shell-error", {
      code: issue.code ?? "SYSTEM_TAB_STOP_RECEIPT_FAILED",
      message: issue.message ?? "The authoritative tab close receipt was unavailable."
    });
  });
};

async function invokeRuntimeTabReorder(
  tabId: string,
  beforeTabId?: string
): Promise<SystemRuntimeOperationSummaryRecord["status"] | undefined> {
  const receipt = await invoke<SystemRuntimeOperationSummaryRecord | null>(
    "rion_runtime_tab_action",
    {
      action: {
        type: "reorder",
        tabId,
        ...(beforeTabId ? { beforeTabId } : {})
      }
    }
  );
  if (!receipt) return undefined;
  if (receipt.status === "applied" || receipt.status === "degraded") {
    handleSystemRuntimeReceipt(receipt);
  }
  if (receipt.status === "degraded") {
    await emit("rion://shell-error", {
      code: receipt.failureCode ?? "SYSTEM_NATIVE_OPERATION_DEGRADED",
      message: "The native tab order completed with reduced guarantees."
    });
  }
  return receipt.status;
}

export function commitRuntimeTabReorder(
  tabId: string,
  beforeTabId?: string
): Promise<SystemRuntimeOperationSummaryRecord["status"] | undefined> {
  const operation = runtimeTabReorderBarrier.then(
    () => invokeRuntimeTabReorder(tabId, beforeTabId)
  );
  runtimeTabReorderBarrier = operation.then(
    () => undefined,
    () => undefined
  );
  return operation;
}

export function reportRuntimeTabSortFailure(
  status: SystemRuntimeOperationSummaryRecord["status"] | "invokeRejected"
): void {
  void emit("rion://shell-error", {
    code: status === "invokeRejected"
      ? "SYSTEM_NATIVE_OPERATION_FAILED"
      : `SYSTEM_TAB_REORDER_${status.toUpperCase()}`,
    message: "The native tab order could not be committed."
  });
}

export function createCloseControl(tabId: string, label: string): HTMLSpanElement {
  const control = document.createElement("span");
  control.className = "close";
  control.role = "button";
  control.tabIndex = -1;
  control.ariaLabel = label;
  control.ariaHidden = "true";
  control.append(createLucideSvg(X));
  control.addEventListener("pointerdown", (event) => event.stopPropagation());
  control.addEventListener("click", (event) => {
    event.stopPropagation();
    dispatch({ type: "stop", tabId });
  });
  control.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    dispatch({ type: "stop", tabId });
  });
  return control;
}

export function syncCloseControlState(button: HTMLButtonElement): void {
  const close = button.querySelector<HTMLElement>(".close");
  if (!close) return;
  const visible = button.classList.contains("active");
  close.tabIndex = visible ? 0 : -1;
  close.ariaHidden = String(!visible);
}

export function installTabButtonInteractions(button: HTMLButtonElement, tabId: string): void {
  button.draggable = false;
  button.addEventListener("click", () => dispatch({ type: "activate", tabId }));
  button.addEventListener("auxclick", (event) => {
    if (event.button === 1) dispatch({ type: "stop", tabId });
  });
  button.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    dispatch({ type: "openTabMenu", tabId });
  });
  button.addEventListener("keydown", (event) => {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    event.preventDefault();
    event.stopPropagation();
    dispatch({ type: "openTabMenu", tabId });
  });
}

installRuntimeTabStrip();
