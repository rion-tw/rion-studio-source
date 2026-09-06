export const WINDOWS_RUNTIME_HOST_PROJECTION_CHANNEL =
  "rion:windows-runtime-host:projection";
export const WINDOWS_RUNTIME_HOST_COMMAND_CHANNEL =
  "rion:windows-runtime-host:command";

import type { LayoutBounds, RuntimeTabActivationPhaseRecord } from "./generated";

export interface WindowsRuntimeHostTabProjection {
  readonly active: boolean;
  readonly audioMuted: boolean;
  readonly hidden: boolean;
  readonly name: string;
  readonly phase: RuntimeTabActivationPhaseRecord;
  readonly tabId: string;
}

export interface WindowsRuntimeHostMoveTargetProjection {
  readonly name: string;
  readonly windowGeneration: number;
  readonly windowId: string;
}

export interface WindowsRuntimeHostProjection {
  readonly activeTabId: string | null;
  readonly alwaysShowToolbarInFullScreen: boolean;
  readonly contentBounds: LayoutBounds;
  readonly fullscreen: boolean;
  readonly lifecycleEpoch: number;
  readonly moveTargets: readonly WindowsRuntimeHostMoveTargetProjection[];
  readonly projectionRevision: number;
  readonly tabs: readonly WindowsRuntimeHostTabProjection[];
  readonly toolbarVisible: boolean;
  readonly topologyRevision: number;
  readonly windowGeneration: number;
  readonly windowId: string;
  readonly workspaceDividers: readonly WindowsRuntimeWorkspaceDividerProjection[];
}

export interface WindowsRuntimeWorkspaceDividerProjection {
  readonly attemptGeneration: string;
  readonly axis: "horizontal" | "vertical";
  readonly bounds: LayoutBounds;
  readonly dividerIndex: number;
  readonly tabId: string;
  readonly visible: boolean;
}

export type WindowsRuntimeHostToolbarCommand = Readonly<{
  projectionRevision: number;
  type:
    | "closeWindow"
    | "hideToolbar"
    | "minimizeWindow"
    | "revealToolbar"
    | "toggleMaximizeWindow";
  windowId: string;
}>;

type WindowsRuntimeHostTabCommandBase = Readonly<{
  projectionRevision: number;
  tabId: string;
  windowId: string;
}>;

export type WindowsRuntimeHostTabCommand =
  | WindowsRuntimeHostTabCommandBase & Readonly<{ type: "activateTab" }>
  | WindowsRuntimeHostTabCommandBase & Readonly<{ type: "closeTab" }>
  | WindowsRuntimeHostTabCommandBase & Readonly<{ type: "hideTab" }>
  | WindowsRuntimeHostTabCommandBase & Readonly<{ type: "setTabMuted"; muted: boolean }>
  | WindowsRuntimeHostTabCommandBase & Readonly<{ type: "moveTabToNewWindow" }>
  | WindowsRuntimeHostTabCommandBase & Readonly<{
      lifecycleEpoch: number;
      topologyRevision: number;
      type: "reloadTab";
      windowGeneration: number;
    }>
  | WindowsRuntimeHostTabCommandBase & Readonly<{
      targetWindowGeneration: number;
      targetWindowId: string;
      type: "moveTab";
    }>
  | WindowsRuntimeHostTabCommandBase & Readonly<{
      beforeTabId?: string;
      gestureId: string;
      orderedVisibleTabIds: readonly string[];
      type: "reorderTab";
    }>;

export type WindowsRuntimeWorkspaceDividerPointerCommand = Readonly<{
  attemptGeneration: string;
  dividerIndex: number;
  gestureId: string;
  phase: "start" | "move" | "end" | "cancel";
  pointerSequence: number;
  projectionRevision: number;
  requestedPosition?: number;
  tabId: string;
  type: "workspaceDividerPointer";
  windowId: string;
}>;

export type WindowsRuntimeHostCommand =
  | WindowsRuntimeHostToolbarCommand
  | WindowsRuntimeHostTabCommand
  | WindowsRuntimeWorkspaceDividerPointerCommand;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim() &&
    ![...value].some((character) => character.codePointAt(0)! <= 0x1f);
}

function validBounds(value: unknown): value is LayoutBounds {
  if (!isRecord(value) || Object.keys(value).length !== 4) return false;
  const values = [value.x, value.y, value.width, value.height];
  return values.every(Number.isSafeInteger) && Number(value.width) >= 1 &&
    Number(value.height) >= 1 &&
    Number.isSafeInteger(Number(value.x) + Number(value.width)) &&
    Number.isSafeInteger(Number(value.y) + Number(value.height));
}

function containsBounds(parent: LayoutBounds, child: LayoutBounds): boolean {
  return child.x >= parent.x && child.y >= parent.y &&
    child.x + child.width <= parent.x + parent.width &&
    child.y + child.height <= parent.y + parent.height;
}

function validUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      .test(value);
}

export function isWindowsRuntimeHostProjection(
  value: unknown
): value is WindowsRuntimeHostProjection {
  if (!isRecord(value) || Object.keys(value).length !== 13 ||
      !validIdentifier(value.windowId) ||
      !Number.isSafeInteger(value.projectionRevision) ||
      Number(value.projectionRevision) < 1 ||
      !Number.isSafeInteger(value.windowGeneration) ||
      Number(value.windowGeneration) < 1 ||
      !Number.isSafeInteger(value.topologyRevision) ||
      Number(value.topologyRevision) < 1 ||
      !Number.isSafeInteger(value.lifecycleEpoch) ||
      Number(value.lifecycleEpoch) < 1 ||
      !validBounds(value.contentBounds) ||
      typeof value.fullscreen !== "boolean" ||
      typeof value.toolbarVisible !== "boolean" ||
      typeof value.alwaysShowToolbarInFullScreen !== "boolean" ||
      (value.activeTabId !== null && !validIdentifier(value.activeTabId)) ||
      !Array.isArray(value.tabs) || !Array.isArray(value.moveTargets) ||
      !Array.isArray(value.workspaceDividers) || value.moveTargets.length > 64 ||
      value.workspaceDividers.length > 128) {
    return false;
  }
  const seen = new Set<string>();
  let activeCount = 0;
  let projectedActiveTabId: string | null = null;
  for (const tab of value.tabs) {
    if (!isRecord(tab) || Object.keys(tab).length !== 6 ||
        !validIdentifier(tab.tabId) || !validIdentifier(tab.name) ||
        typeof tab.active !== "boolean" || typeof tab.hidden !== "boolean" ||
        typeof tab.audioMuted !== "boolean" ||
        (tab.active && tab.hidden) ||
        !new Set([
          "dormant",
          "activating",
          "attaching",
          "loading",
          "ready",
          "degraded",
          "failed"
        ]).has(String(tab.phase)) || seen.has(tab.tabId)) {
      return false;
    }
    seen.add(tab.tabId);
    if (tab.active) {
      activeCount += 1;
      projectedActiveTabId = tab.tabId;
    }
  }
  if (!(activeCount <= 1 &&
    (value.activeTabId === null
      ? activeCount === 0
      : activeCount === 1 && projectedActiveTabId === value.activeTabId))) {
    return false;
  }
  const moveTargetIds = new Set<string>();
  for (const target of value.moveTargets) {
    if (!isRecord(target) || Object.keys(target).length !== 3 ||
        !validIdentifier(target.windowId) || !validIdentifier(target.name) ||
        target.windowId === value.windowId || moveTargetIds.has(target.windowId) ||
        !Number.isSafeInteger(target.windowGeneration) ||
        Number(target.windowGeneration) < 1) {
      return false;
    }
    moveTargetIds.add(target.windowId);
  }
  const dividerKeys = new Set<string>();
  for (const divider of value.workspaceDividers) {
    if (!isRecord(divider) || Object.keys(divider).length !== 6 ||
        !validIdentifier(divider.tabId) ||
        !validIdentifier(divider.attemptGeneration) ||
        !["horizontal", "vertical"].includes(String(divider.axis)) ||
        !Number.isSafeInteger(divider.dividerIndex) ||
        Number(divider.dividerIndex) < 0 ||
        Number(divider.dividerIndex) > 4_294_967_295 ||
        typeof divider.visible !== "boolean" || !validBounds(divider.bounds) ||
        !containsBounds(value.contentBounds, divider.bounds) ||
        !seen.has(String(divider.tabId)) ||
        (divider.visible && divider.tabId !== value.activeTabId)) {
      return false;
    }
    const key = `${divider.tabId}:${divider.dividerIndex}`;
    if (dividerKeys.has(key)) return false;
    dividerKeys.add(key);
  }
  return true;
}

export function isWindowsRuntimeHostCommand(
  value: unknown
): value is WindowsRuntimeHostCommand {
  if (!isRecord(value) || !validIdentifier(value.windowId) ||
      !Number.isSafeInteger(value.projectionRevision) ||
      Number(value.projectionRevision) < 1) {
    return false;
  }
  if (value.type !== "workspaceDividerPointer") {
    if (value.type === "setTabMuted") {
      return Object.keys(value).length === 5 && validIdentifier(value.tabId) &&
        typeof value.muted === "boolean";
    }
    if (value.type === "reloadTab") {
      return Object.keys(value).length === 7 && validIdentifier(value.tabId) &&
        Number.isSafeInteger(value.windowGeneration) &&
        Number(value.windowGeneration) >= 1 &&
        Number.isSafeInteger(value.topologyRevision) &&
        Number(value.topologyRevision) >= 1 &&
        Number.isSafeInteger(value.lifecycleEpoch) &&
        Number(value.lifecycleEpoch) >= 1;
    }
    if ([
      "activateTab",
      "closeTab",
      "hideTab",
      "moveTabToNewWindow"
    ].includes(String(value.type))) {
      return Object.keys(value).length === 4 && validIdentifier(value.tabId);
    }
    if (value.type === "moveTab") {
      return Object.keys(value).length === 6 && validIdentifier(value.tabId) &&
        validIdentifier(value.targetWindowId) &&
        Number.isSafeInteger(value.targetWindowGeneration) &&
        Number(value.targetWindowGeneration) >= 1;
    }
    if (value.type === "reorderTab") {
      const beforeTabId = value.beforeTabId;
      return Object.keys(value).length === (beforeTabId === undefined ? 6 : 7) &&
        validIdentifier(value.tabId) && validUuid(value.gestureId) &&
        (beforeTabId === undefined || (
          validIdentifier(beforeTabId) && beforeTabId !== value.tabId
        )) && Array.isArray(value.orderedVisibleTabIds) &&
        value.orderedVisibleTabIds.length >= 1 &&
        value.orderedVisibleTabIds.length <= 128 &&
        value.orderedVisibleTabIds.every(validIdentifier) &&
        new Set(value.orderedVisibleTabIds).size ===
          value.orderedVisibleTabIds.length &&
        value.orderedVisibleTabIds.includes(value.tabId);
    }
    return Object.keys(value).length === 3 && new Set([
      "closeWindow",
      "hideToolbar",
      "minimizeWindow",
      "revealToolbar",
      "toggleMaximizeWindow"
    ]).has(String(value.type));
  }
  const phase = String(value.phase);
  const move = phase === "move";
  return Object.keys(value).length === (move ? 10 : 9) &&
    validIdentifier(value.tabId) && validIdentifier(value.attemptGeneration) &&
    validUuid(value.gestureId) &&
    Number.isSafeInteger(value.pointerSequence) &&
    Number(value.pointerSequence) >= 1 &&
    Number.isSafeInteger(value.dividerIndex) && Number(value.dividerIndex) >= 0 &&
    Number(value.dividerIndex) <= 4_294_967_295 &&
    ["start", "move", "end", "cancel"].includes(phase) &&
    (move
      ? typeof value.requestedPosition === "number" &&
        Number.isFinite(value.requestedPosition) &&
        value.requestedPosition >= 0 && value.requestedPosition <= 1
      : !("requestedPosition" in value));
}
