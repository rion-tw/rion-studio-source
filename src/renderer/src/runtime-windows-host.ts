import { runtimeTabStripLabels } from "./i18n";
import { createRuntimeTabToolbar } from "./runtimeTabToolbar";
import { createRuntimeTabDrag } from "./runtimeTabDrag";
import type {
  WindowsRuntimeHostCommand,
  WindowsRuntimeHostProjection,
  WindowsRuntimeHostToolbarCommand,
  WindowsRuntimeWorkspaceDividerPointerCommand,
  WindowsRuntimeWorkspaceDividerProjection
} from "../../shared/windowsRuntimeHost";

declare global {
  interface Window {
    rionStudioWindowsRuntimeHost?: Readonly<{
      onProjection: (
        listener: (projection: WindowsRuntimeHostProjection) => void
      ) => () => void;
      submit: (command: WindowsRuntimeHostCommand) => void;
    }>;
  }
}

const bridge = window.rionStudioWindowsRuntimeHost;
const toolbar = document.querySelector<HTMLElement>("[data-runtime-toolbar]");
const revealEdge = document.querySelector<HTMLElement>("[data-runtime-reveal-edge]");
const tabs = document.querySelector<HTMLElement>("[data-runtime-tabs]");
const windowName = document.querySelector<HTMLElement>(
  "[data-runtime-window-name]"
);
const windowControls = document.querySelector<HTMLElement>(
  "[data-runtime-window-controls]"
);
const dividerLayer = document.querySelector<HTMLElement>(
  "[data-runtime-workspace-dividers]"
);

if (!bridge || !toolbar || !revealEdge || !tabs || !windowName ||
    !windowControls || !dividerLayer) {
  throw new Error("The bundled Windows runtime-host document is incomplete.");
}

const workspaceBackground = document.createElement("div");
workspaceBackground.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:-1";
workspaceBackground.setAttribute("aria-hidden", "true");
document.body.prepend(workspaceBackground);

let current: WindowsRuntimeHostProjection | null = null;
let resizeEventCount = 0;
const dividerElements = new Map<string, HTMLButtonElement>();
const activePointers = new Map<number, {
  readonly element: HTMLButtonElement;
  readonly gestureId: string;
  readonly initialPosition: number;
  readonly owner: WindowsRuntimeWorkspaceDividerProjection;
  lastRequestedPosition: number;
  pointerSequence: number;
}>();

function submit(type: WindowsRuntimeHostToolbarCommand["type"]): void {
  if (!current) return;
  if ((type === "hideToolbar" || type === "revealToolbar") &&
      (!current.fullscreen || current.alwaysShowToolbarInFullScreen ||
       current.toolbarVisible === (type === "revealToolbar"))) return;
  bridge!.submit({
    projectionRevision: current.projectionRevision,
    type,
    windowId: current.windowId
  });
}

function submitTab(
  tabId: string,
  type: "activateTab" | "closeTab" | "hideTab" | "moveTabToNewWindow"
): void {
  if (!current) return;
  bridge!.submit({
    projectionRevision: current.projectionRevision,
    tabId,
    type,
    windowId: current.windowId
  });
}

function openTabMenu(event: MouseEvent | KeyboardEvent, tabId: string): void {
  if (!current) return;
  event.preventDefault();
  bridge!.submit({ type: "openTabMenu", tabId, windowId: current.windowId,
    projectionRevision: current.projectionRevision });
}

const tabDrag = createRuntimeTabDrag({ toolbar, tabs, current: () => current,
  submit: command => bridge!.submit(command), closeMenu: () => undefined });

const tabToolbar = createRuntimeTabToolbar(tabs, () => submit("openLauncher"), () => tabDrag.geometry());

function dividerKey(
  divider: Pick<WindowsRuntimeWorkspaceDividerProjection, "tabId" | "dividerIndex">
): string {
  return `${divider.tabId}:${divider.dividerIndex}`;
}

function submitDivider(
  pointerId: number,
  phase: WindowsRuntimeWorkspaceDividerPointerCommand["phase"],
  requestedPosition?: number
): void {
  const projection = current;
  const active = activePointers.get(pointerId);
  if (!projection || !active) return;
  active.pointerSequence += 1;
  bridge!.submit({
    attemptGeneration: active.owner.attemptGeneration,
    dividerIndex: active.owner.dividerIndex,
    gestureId: active.gestureId,
    phase,
    pointerSequence: active.pointerSequence,
    projectionRevision: projection.projectionRevision,
    ...(phase === "move" ? { requestedPosition } : {}),
    tabId: active.owner.tabId,
    type: "workspaceDividerPointer",
    windowId: projection.windowId
  });
}

function requestedDividerPosition(
  event: PointerEvent,
  owner: WindowsRuntimeWorkspaceDividerProjection,
  projection: WindowsRuntimeHostProjection
): number {
  const bounds = projection.contentBounds;
  const raw = owner.axis === "vertical"
    ? (event.clientX - bounds.x) / bounds.width
    : (event.clientY - bounds.y) / bounds.height;
  return Math.max(0, Math.min(1, raw));
}

function submitDividerMove(event: PointerEvent, terminalOnly = false): void {
  const active = activePointers.get(event.pointerId);
  if (!active || !current) return;
  const requestedPosition = requestedDividerPosition(event, active.owner, current);
  if (terminalOnly && requestedPosition === active.lastRequestedPosition) return;
  active.lastRequestedPosition = requestedPosition;
  submitDivider(event.pointerId, "move", requestedPosition);
}

function bindDividerPointer(element: HTMLButtonElement): void {
  element.addEventListener("pointerdown", (event) => {
    if (!event.isPrimary || event.button !== 0 || activePointers.has(event.pointerId) ||
        !current) return;
    const owner = current.workspaceDividers.find((divider) =>
      divider.visible && dividerKey(divider) === element.dataset.dividerKey
    );
    if (!owner) return;
    const gestureId = crypto.randomUUID();
    const initialPosition = requestedDividerPosition(event, owner, current);
    activePointers.set(event.pointerId, {
      element,
      gestureId,
      initialPosition,
      lastRequestedPosition: initialPosition,
      owner,
      pointerSequence: 0
    });
    dividerLayer!.dataset.dragging = "true";
    element.dataset.dragging = "true";
    element.setPointerCapture(event.pointerId);
    submitDivider(event.pointerId, "start");
    event.preventDefault();
  });
  element.addEventListener("pointermove", (event) => {
    submitDividerMove(event);
  });
  element.addEventListener("pointerup", (event) => {
    submitDividerMove(event, true);
    finishDividerPointer(event.pointerId, "end");
  });
  element.addEventListener("pointercancel", (event) =>
    finishDividerPointer(event.pointerId, "cancel"));
  element.addEventListener("lostpointercapture", (event) =>
    finishLostDividerPointer(event));
}

function finishLostDividerPointer(event: PointerEvent): void {
  const active = activePointers.get(event.pointerId);
  if (!active) return;
  // A Windows child WebContentsView can take the pointer after the divider
  // crosses into role content. The capture-loss event owns Chromium's terminal
  // pointer coordinate even when no destination pointermove reached this view.
  submitDividerMove(event, true);
  finishDividerPointer(
    event.pointerId,
    active.lastRequestedPosition !== active.initialPosition ? "end" : "cancel"
  );
}

function finishDividerPointer(
  pointerId: number,
  phase: "end" | "cancel"
): void {
  const active = activePointers.get(pointerId);
  if (!active) return;
  submitDivider(pointerId, phase);
  activePointers.delete(pointerId);
  active.element.dataset.dragging = "false";
  if (activePointers.size === 0) dividerLayer!.dataset.dragging = "false";
  if (active.element.hasPointerCapture(pointerId)) {
    active.element.releasePointerCapture(pointerId);
  }
}

function cancelDividerPointers(): void {
  for (const pointerId of [...activePointers.keys()]) {
    finishDividerPointer(pointerId, "cancel");
  }
}

function renderDividers(projection: WindowsRuntimeHostProjection): void {
  const liveKeys = new Set<string>();
  for (const divider of projection.workspaceDividers) {
    const key = dividerKey(divider);
    liveKeys.add(key);
    let element = dividerElements.get(key);
    if (!element) {
      element = document.createElement("button");
      element.type = "button";
      element.className = "runtime-workspace-divider";
      element.dataset.dividerKey = key;
      element.setAttribute("role", "separator");
      bindDividerPointer(element);
      dividerElements.set(key, element);
      dividerLayer!.append(element);
    }
    element.dataset.axis = divider.axis;
    element.dataset.tabId = divider.tabId;
    element.dataset.dividerIndex = String(divider.dividerIndex);
    element.setAttribute("aria-orientation",
      divider.axis === "vertical" ? "vertical" : "horizontal");
    element.setAttribute("aria-label", divider.axis === "vertical"
      ? "Resize workspace columns"
      : "Resize workspace rows");
    element.hidden = !divider.visible;
    element.style.left = `${divider.bounds.x}px`;
    element.style.top = `${divider.bounds.y}px`;
    element.style.width = `${divider.bounds.width}px`;
    element.style.height = `${divider.bounds.height}px`;
  }
  const retainedByPointer = new Set(
    [...activePointers.values()].map((active) => active.element.dataset.dividerKey)
  );
  for (const [key, element] of dividerElements) {
    if (liveKeys.has(key) || retainedByPointer.has(key)) continue;
    element.remove();
    dividerElements.delete(key);
  }
}

const slotStatusLayer = document.createElement("div");
slotStatusLayer.className = "workspace-slot-status-layer";
document.body.append(slotStatusLayer);

function renderSlotLoads(projection: WindowsRuntimeHostProjection): void {
  slotStatusLayer.replaceChildren(...(projection.workspaceSlotLoads ?? []).map((slot) => {
    const status = document.createElement("section");
    status.className = "workspace-slot-status";
    status.dataset.workspaceSlotStatus = slot.record.slotId;
    status.dataset.phase = slot.record.phase;
    status.setAttribute("role", "status");
    Object.assign(status.style, { left: `${slot.bounds.x}px`, top: `${slot.bounds.y}px`,
      width: `${slot.bounds.width}px`, height: `${slot.bounds.height}px` });
    if (slot.record.phase === "loading") {
      status.setAttribute("aria-label", slot.record.loadingLabel ?? "Loading");
      const spinner = document.createElement("span");
      spinner.className = "runtime-tab-loading workspace-slot-spinner";
      status.append(spinner);
    } else {
      const label = document.createElement("span");
      label.textContent = slot.record.failureLabel ?? "Unable to load this section";
      status.append(label);
      if (slot.record.retryable) {
        const retry = document.createElement("button");
        retry.textContent = slot.record.retryLabel ?? "Retry";
        retry.addEventListener("click", () => {
          if (!current) return;
          retry.disabled = true;
          bridge!.submit({ type: "retryWorkspaceSlot", windowId: current.windowId,
            projectionRevision: current.projectionRevision, record: slot.record });
        });
        status.append(retry);
      }
    }
    return status;
  }));
}

function render(projection: WindowsRuntimeHostProjection): void {
  renderSlotLoads(projection);
  current = projection;
  const labels = runtimeTabStripLabels(projection.appearance?.language ?? "en");
  document.documentElement.lang = projection.appearance?.language ?? "en";
  document.documentElement.dataset.theme = projection.appearance?.theme ?? "light";
  document.documentElement.style.colorScheme = projection.appearance?.theme ?? "light";
  for (const [command, label] of Object.entries({ minimizeWindow: labels.minimizeWindow, closeWindow: labels.closeWindow,
    toggleMaximizeWindow: projection.windowMaximized || projection.fullscreen ? labels.restoreWindow : labels.maximizeWindow })) {
    const button = windowControls!.querySelector<HTMLButtonElement>(`[data-window-command="${command}"]`);
    if (button) { button.setAttribute("aria-label", label); button.title = label; }
  }
  workspaceBackground.style.background = projection.workspaceBackground === "black" ? "#000" : "transparent";
  toolbar!.hidden = !projection.toolbarVisible;
  windowName!.textContent = projection.windowName;
  windowName!.hidden = projection.windowName.length === 0;
  revealEdge!.hidden = projection.toolbarVisible || !projection.fullscreen ||
    projection.alwaysShowToolbarInFullScreen;
  tabs!.replaceChildren(...projection.tabs.filter((tab) => !tab.hidden).map((tab) => {
    const item = document.createElement("div");
    item.className = "runtime-tab";
    item.dataset.active = String(tab.active);
    item.dataset.phase = tab.phase;
    item.dataset.tabId = tab.tabId;
    const activate = document.createElement("button");
    activate.type = "button";
    activate.className = "runtime-tab-activate";
    activate.dataset.runtimeTabActivate = "";
    activate.dataset.tabId = tab.tabId;
    activate.setAttribute("aria-label", projection.appearance?.language && projection.appearance.language !== "en" ? tab.name : `Activate ${tab.name}`);
    activate.title = tab.name;
    activate.setAttribute("aria-pressed", String(tab.active));
    tabDrag.bind(activate, tab.tabId);
    const label = document.createElement("span");
    label.textContent = tab.name;
    activate.append(label);
    const loading = new Set(["activating", "attaching", "loading"])
      .has(tab.phase);
    if (loading) {
      activate.setAttribute("aria-label", !projection.appearance || projection.appearance.language === "en"
        ? `Activate ${tab.name}, loading` : `${tab.name}, ${labels.statusActivating}`);
      const progress = document.createElement("span");
      progress.className = "runtime-tab-loading";
      progress.dataset.runtimeTabLoading = "";
      progress.setAttribute("aria-label", `${tab.name}, ${labels.statusActivating}`);
      progress.setAttribute("role", "status");
      activate.append(progress);
    } else if (tab.phase === "degraded" || tab.phase === "failed") {
      const status = document.createElement("span");
      status.className = "runtime-tab-status";
      status.dataset.runtimeTabStatus = tab.phase;
      status.setAttribute("aria-label", `${tab.name} ${tab.phase}`);
      status.setAttribute("role", "status");
      status.textContent = "!";
      status.title = tab.phase === "failed" ? labels.statusFailed : labels.statusDegraded;
      activate.append(status);
    }
    activate.addEventListener("click", () => submitTab(tab.tabId, "activateTab"));
    activate.addEventListener("auxclick", event => {
      if (event.button === 1) { event.preventDefault(); submitTab(tab.tabId, "closeTab"); }
    });
    activate.addEventListener("keydown", event => {
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) openTabMenu(event, tab.tabId);
    });
    const close = document.createElement("button");
    close.type = "button";
    close.className = "runtime-tab-close";
    close.dataset.runtimeTabClose = "";
    close.dataset.tabId = tab.tabId;
    close.setAttribute("aria-label", projection.appearance?.language && projection.appearance.language !== "en" ? `${labels.closeTab}: ${tab.name}` : `Stop and close ${tab.name}`);
    close.hidden = projection.alwaysHideTabCloseButton === true;
    close.textContent = "\u00d7";
    close.addEventListener("click", () => submitTab(tab.tabId, "closeTab"));
    if (tab.audioMuted) {
      const muted = document.createElement("span");
      muted.className = "runtime-tab-muted";
      muted.textContent = "♪̸";
      muted.setAttribute("aria-label", labels.tabMuted);
      muted.title = labels.tabMuted;
      activate.append(muted);
    }
    item.append(activate, close);
    item.addEventListener("contextmenu", (event) => openTabMenu(event, tab.tabId));
    return item;
  }));
  tabToolbar.render(labels, projection.activeTabId);
  renderDividers(projection);
  document.documentElement.dataset.fullscreen = String(projection.fullscreen);
  document.documentElement.dataset.windowMaximized =
    String(projection.windowMaximized);
  document.documentElement.dataset.toolbarVisible = String(projection.toolbarVisible);
  document.documentElement.dataset.runtimeContentHeight =
    String(projection.contentBounds.height);
  document.documentElement.dataset.runtimeContentWidth =
    String(projection.contentBounds.width);
  document.documentElement.dataset.runtimeContentX = String(projection.contentBounds.x);
  document.documentElement.dataset.runtimeContentY = String(projection.contentBounds.y);
  document.documentElement.dataset.runtimeProjectionRevision =
    String(projection.projectionRevision);
  document.documentElement.dataset.runtimeLifecycleEpoch =
    String(projection.lifecycleEpoch);
  document.documentElement.dataset.runtimeResizeEventCount = String(resizeEventCount);
  document.documentElement.dataset.runtimeTopologyRevision =
    String(projection.topologyRevision);
  document.documentElement.dataset.runtimeWindowGeneration =
    String(projection.windowGeneration);
  document.documentElement.dataset.runtimeWindowId = projection.windowId;
  tabDrag.geometry();
}

revealEdge.addEventListener("pointerenter", () => submit("revealToolbar"));
toolbar.addEventListener("pointerleave", () => submit("hideToolbar"));
windowControls.addEventListener("click", (event) => {
  // The glyph, not the button, owns the click target inside each control.
  const target = event.target instanceof Element
    ? event.target.closest("button")
    : null;
  if (!(target instanceof HTMLButtonElement)) return;
  const command = target.dataset.windowCommand;
  if (
    command === "closeWindow" || command === "minimizeWindow" ||
    command === "toggleMaximizeWindow"
  ) {
    submit(command);
  }
});
document.addEventListener("pointerup", (event) => {
  submitDividerMove(event, true);
  finishDividerPointer(event.pointerId, "end");
}, { capture: true });
document.addEventListener("pointercancel", (event) =>
  finishDividerPointer(event.pointerId, "cancel"), { capture: true });
window.addEventListener("blur", () => {
  cancelDividerPointers();
});
window.addEventListener("resize", () => {
  resizeEventCount += 1;
  document.documentElement.dataset.runtimeResizeEventCount = String(resizeEventCount);
});
bridge.onProjection(render);
