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
const windowControls = document.querySelector<HTMLElement>(
  "[data-runtime-window-controls]"
);
const dividerLayer = document.querySelector<HTMLElement>(
  "[data-runtime-workspace-dividers]"
);

if (!bridge || !toolbar || !revealEdge || !tabs || !windowControls ||
    !dividerLayer) {
  throw new Error("The bundled Windows runtime-host document is incomplete.");
}

let current: WindowsRuntimeHostProjection | null = null;
let resizeEventCount = 0;
let activeTabDrag: Readonly<{
  element: HTMLElement;
  gestureId: string;
  item: HTMLElement;
  originalOrder: readonly string[];
  pointerId: number;
  projectionRevision: number;
  startX: number;
  startY: number;
  tabId: string;
}> & { dragging: boolean } | null = null;
const suppressedClicks = new Set<string>();
const dividerElements = new Map<string, HTMLButtonElement>();
const activePointers = new Map<number, {
  readonly element: HTMLButtonElement;
  readonly gestureId: string;
  readonly owner: WindowsRuntimeWorkspaceDividerProjection;
  pointerSequence: number;
}>();
const tabMenu = document.createElement("div");
tabMenu.className = "runtime-tab-menu";
tabMenu.dataset.runtimeTabMenu = "";
tabMenu.hidden = true;
tabMenu.setAttribute("role", "menu");
document.body.append(tabMenu);

function submit(type: WindowsRuntimeHostToolbarCommand["type"]): void {
  if (!current) return;
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

function closeTabMenu(): void {
  tabMenu.hidden = true;
  tabMenu.replaceChildren();
  delete tabMenu.dataset.tabId;
}

function menuButton(
  label: string,
  action: string,
  activate: () => void
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.runtimeTabMenuAction = action;
  button.setAttribute("role", "menuitem");
  button.textContent = label;
  button.addEventListener("click", () => {
    closeTabMenu();
    activate();
  });
  return button;
}

function openTabMenu(event: MouseEvent, tabId: string): void {
  const projection = current;
  const tab = projection?.tabs.find((candidate) =>
    candidate.tabId === tabId && !candidate.hidden
  );
  if (!projection || !tab) return;
  event.preventDefault();
  closeTabMenu();
  const moveButtons = projection.moveTargets.map((target) => {
    const button = menuButton(`Move to ${target.name}`, "moveTab", () => {
      bridge!.submit({
        projectionRevision: projection.projectionRevision,
        tabId,
        targetWindowGeneration: target.windowGeneration,
        targetWindowId: target.windowId,
        type: "moveTab",
        windowId: projection.windowId
      });
    });
    button.dataset.targetWindowId = target.windowId;
    button.dataset.targetWindowGeneration = String(target.windowGeneration);
    return button;
  });
  const reload = menuButton("Reload", "reloadTab", () => {
    bridge!.submit({
      lifecycleEpoch: projection.lifecycleEpoch,
      projectionRevision: projection.projectionRevision,
      tabId,
      topologyRevision: projection.topologyRevision,
      type: "reloadTab",
      windowGeneration: projection.windowGeneration,
      windowId: projection.windowId
    });
  });
  const muteLabels = navigator.language.startsWith("ja")
    ? ["タブをミュート", "タブのミュートを解除"]
    : /zh-(?:TW|HK|Hant)/iu.test(navigator.language)
      ? ["分頁靜音", "取消分頁靜音"]
      : navigator.language.startsWith("zh")
        ? ["标签页静音", "取消标签页静音"]
        : ["Mute tab", "Unmute tab"];
  const mute = menuButton(muteLabels[tab.audioMuted ? 1 : 0]!, "setTabMuted", () => {
    bridge!.submit({
      muted: !tab.audioMuted,
      projectionRevision: projection.projectionRevision,
      tabId,
      type: "setTabMuted",
      windowId: projection.windowId
    });
  });
  mute.setAttribute("role", "menuitemcheckbox");
  mute.setAttribute("aria-checked", String(tab.audioMuted));
  const hide = menuButton("Hide tab", "hideTab", () => submitTab(tabId, "hideTab"));
  hide.disabled = projection.tabs.filter((candidate) => !candidate.hidden).length <= 1;
  tabMenu.append(
    reload,
    mute,
    hide,
    ...moveButtons,
    menuButton("Move to new window", "moveTabToNewWindow", () =>
      submitTab(tabId, "moveTabToNewWindow")
    )
  );
  tabMenu.dataset.tabId = tabId;
  tabMenu.hidden = false;
  const bounds = tabMenu.getBoundingClientRect();
  const left = Math.max(8, Math.min(event.clientX, window.innerWidth - bounds.width - 8));
  const top = Math.max(8, Math.min(event.clientY, window.innerHeight - bounds.height - 8));
  tabMenu.style.left = `${left}px`;
  tabMenu.style.top = `${top}px`;
  tabMenu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
}

function visibleTabElements(): HTMLElement[] {
  return [...tabs!.querySelectorAll<HTMLElement>(".runtime-tab[data-tab-id]")];
}

function visibleTabOrder(): string[] {
  return visibleTabElements().map((element) => element.dataset.tabId!);
}

function releaseTabPointer(active: NonNullable<typeof activeTabDrag>): void {
  active.element.dataset.dragging = "false";
  if (active.element.hasPointerCapture(active.pointerId)) {
    active.element.releasePointerCapture(active.pointerId);
  }
}

function cancelTabDrag(): void {
  const active = activeTabDrag;
  activeTabDrag = null;
  if (!active) return;
  releaseTabPointer(active);
}

function previewTabDrag(event: PointerEvent): void {
  const active = activeTabDrag;
  if (!active || active.pointerId !== event.pointerId) return;
  if (!active.dragging) {
    const distance = Math.abs(event.clientX - active.startX) +
      Math.abs(event.clientY - active.startY);
    if (distance < 8) return;
    active.dragging = true;
    active.element.dataset.dragging = "true";
  }
  const siblings = visibleTabElements().filter((element) => element !== active.item);
  const before = siblings.find((element) => {
    const bounds = element.getBoundingClientRect();
    return event.clientX < bounds.left + bounds.width / 2;
  });
  tabs!.insertBefore(active.item, before ?? null);
  event.preventDefault();
}

function finishTabDrag(event: PointerEvent, cancelled: boolean): void {
  const active = activeTabDrag;
  if (!active || active.pointerId !== event.pointerId) return;
  activeTabDrag = null;
  releaseTabPointer(active);
  if (!active.dragging || cancelled) return;
  suppressedClicks.add(active.tabId);
  const orderedVisibleTabIds = visibleTabOrder();
  if (
    orderedVisibleTabIds.length === active.originalOrder.length &&
    orderedVisibleTabIds.every((tabId, index) => tabId === active.originalOrder[index])
  ) {
    return;
  }
  const index = orderedVisibleTabIds.indexOf(active.tabId);
  const beforeTabId = orderedVisibleTabIds[index + 1];
  const projection = current;
  if (!projection || projection.projectionRevision !== active.projectionRevision) return;
  bridge!.submit({
    ...(beforeTabId === undefined ? {} : { beforeTabId }),
    gestureId: active.gestureId,
    orderedVisibleTabIds,
    projectionRevision: active.projectionRevision,
    tabId: active.tabId,
    type: "reorderTab",
    windowId: projection.windowId
  });
}

function bindTabPointer(
  element: HTMLElement,
  item: HTMLElement,
  tabId: string
): void {
  element.addEventListener("pointerdown", (event) => {
    if (!event.isPrimary || event.button !== 0 || activeTabDrag || !current) return;
    closeTabMenu();
    activeTabDrag = {
      dragging: false,
      element,
      gestureId: crypto.randomUUID(),
      item,
      originalOrder: visibleTabOrder(),
      pointerId: event.pointerId,
      projectionRevision: current.projectionRevision,
      startX: event.clientX,
      startY: event.clientY,
      tabId
    };
    element.setPointerCapture(event.pointerId);
  });
  element.addEventListener("pointermove", previewTabDrag);
  element.addEventListener("pointerup", (event) => finishTabDrag(event, false));
  element.addEventListener("pointercancel", (event) => finishTabDrag(event, true));
}

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

function bindDividerPointer(element: HTMLButtonElement): void {
  element.addEventListener("pointerdown", (event) => {
    if (!event.isPrimary || event.button !== 0 || activePointers.has(event.pointerId) ||
        !current) return;
    const owner = current.workspaceDividers.find((divider) =>
      divider.visible && dividerKey(divider) === element.dataset.dividerKey
    );
    if (!owner) return;
    const gestureId = crypto.randomUUID();
    activePointers.set(event.pointerId, {
      element,
      gestureId,
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
    const active = activePointers.get(event.pointerId);
    if (!active || !current) return;
    submitDivider(
      event.pointerId,
      "move",
      requestedDividerPosition(event, active.owner, current)
    );
  });
  element.addEventListener("pointerup", (event) =>
    finishDividerPointer(event.pointerId, "end"));
  element.addEventListener("pointercancel", (event) =>
    finishLostDividerPointer(event.pointerId));
  element.addEventListener("lostpointercapture", (event) =>
    finishLostDividerPointer(event.pointerId));
}

function finishLostDividerPointer(pointerId: number): void {
  const active = activePointers.get(pointerId);
  if (!active) return;
  // A Windows child WebContentsView can take the pointer after the divider
  // crosses into role content. Chromium then reports capture loss instead of
  // the physical mouse-up. A delivered move is already Core-authoritative, so
  // that native boundary commits the visible result; capture loss before any
  // move remains a true cancellation.
  finishDividerPointer(pointerId, active.pointerSequence > 1 ? "end" : "cancel");
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

function render(projection: WindowsRuntimeHostProjection): void {
  cancelTabDrag();
  closeTabMenu();
  current = projection;
  toolbar!.hidden = !projection.toolbarVisible;
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
    activate.setAttribute("aria-label", `Activate ${tab.name}`);
    activate.setAttribute("aria-pressed", String(tab.active));
    bindTabPointer(activate, item, tab.tabId);
    const label = document.createElement("span");
    label.textContent = tab.name;
    activate.append(label);
    const loading = new Set(["activating", "attaching", "loading"])
      .has(tab.phase);
    if (loading) {
      activate.setAttribute("aria-label", `Activate ${tab.name}, loading`);
      const progress = document.createElement("span");
      progress.className = "runtime-tab-loading";
      progress.dataset.runtimeTabLoading = "";
      progress.setAttribute("aria-label", `${tab.name} loading`);
      progress.setAttribute("role", "status");
      activate.append(progress);
    } else if (tab.phase === "degraded" || tab.phase === "failed") {
      const status = document.createElement("span");
      status.className = "runtime-tab-status";
      status.dataset.runtimeTabStatus = tab.phase;
      status.setAttribute("aria-label", `${tab.name} ${tab.phase}`);
      status.setAttribute("role", "status");
      status.textContent = tab.phase === "failed" ? "Failed" : "Degraded";
      activate.append(status);
    }
    activate.addEventListener("click", (event) => {
      if (suppressedClicks.delete(tab.tabId)) {
        event.preventDefault();
        return;
      }
      submitTab(tab.tabId, "activateTab");
    });
    const close = document.createElement("button");
    close.type = "button";
    close.className = "runtime-tab-close";
    close.dataset.runtimeTabClose = "";
    close.dataset.tabId = tab.tabId;
    close.setAttribute("aria-label", `Stop and close ${tab.name}`);
    close.textContent = "\u00d7";
    close.addEventListener("click", () => submitTab(tab.tabId, "closeTab"));
    item.append(activate, close);
    item.addEventListener("contextmenu", (event) => openTabMenu(event, tab.tabId));
    return item;
  }));
  renderDividers(projection);
  document.documentElement.dataset.fullscreen = String(projection.fullscreen);
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
}

revealEdge.addEventListener("pointerenter", () => submit("revealToolbar"));
toolbar.addEventListener("pointerleave", () => submit("hideToolbar"));
windowControls.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) return;
  const command = target.dataset.windowCommand;
  if (
    command === "closeWindow" || command === "minimizeWindow" ||
    command === "toggleMaximizeWindow"
  ) {
    submit(command);
  }
});
document.addEventListener("pointerdown", (event) => {
  if (!tabMenu.hidden && !tabMenu.contains(event.target as Node)) closeTabMenu();
}, { capture: true });
document.addEventListener("pointerup", (event) =>
  finishDividerPointer(event.pointerId, "end"), { capture: true });
document.addEventListener("pointercancel", (event) =>
  finishLostDividerPointer(event.pointerId), { capture: true });
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeTabMenu();
});
window.addEventListener("blur", () => {
  closeTabMenu();
  cancelDividerPointers();
});
window.addEventListener("resize", () => {
  resizeEventCount += 1;
  document.documentElement.dataset.runtimeResizeEventCount = String(resizeEventCount);
});
bridge.onProjection(render);
