import { ipcRenderer } from "electron";

import {
  RUNTIME_TABS_ACTION_CHANNEL,
  RUNTIME_TABS_STATE_CHANNEL,
  type RuntimeTabAction,
  type RuntimeTabChromeState
} from "../shared/runtimeTabs";
import type {
  AppLanguage,
  EmbeddedRuntimeTabSummary,
  WorkspaceLayoutTemplate
} from "../shared/types";
import { workspaceLayoutIconNodes } from "../shared/workspaceLayoutIcons";

type LabelKey = "add" | "close" | "enterFullScreen" | "exitFullScreen" |
  "minimize" | "more" | "zoom";

const translations: Record<AppLanguage, Record<LabelKey, string>> = {
  en: {
    add: "Open role or workspace",
    close: "Close game window",
    enterFullScreen: "Enter full screen",
    exitFullScreen: "Exit full screen",
    minimize: "Minimize game window",
    more: "More actions",
    zoom: "Zoom game window"
  },
  "zh-TW": {
    add: "開啟角色或工作區",
    close: "關閉遊戲視窗",
    enterFullScreen: "進入全螢幕",
    exitFullScreen: "離開全螢幕",
    minimize: "最小化遊戲視窗",
    more: "更多操作",
    zoom: "縮放遊戲視窗"
  },
  "zh-CN": {
    add: "打开角色或工作区",
    close: "关闭游戏窗口",
    enterFullScreen: "进入全屏",
    exitFullScreen: "退出全屏",
    minimize: "最小化游戏窗口",
    more: "更多操作",
    zoom: "缩放游戏窗口"
  },
  ja: {
    add: "ロールまたはワークスペースを開く",
    close: "ゲームウインドウを閉じる",
    enterFullScreen: "フルスクリーンにする",
    exitFullScreen: "フルスクリーンを解除",
    minimize: "ゲームウインドウを最小化",
    more: "その他の操作",
    zoom: "ゲームウインドウを拡大／復元"
  }
};

let currentState: RuntimeTabChromeState | undefined;

window.addEventListener("DOMContentLoaded", () => {
  document.documentElement.dataset.platform = process.platform;
  installStyles();
  render();
});

ipcRenderer.on(RUNTIME_TABS_STATE_CHANNEL, (_event, state: RuntimeTabChromeState) => {
  currentState = state;
  render();
});

function send(action: RuntimeTabAction): void {
  ipcRenderer.send(RUNTIME_TABS_ACTION_CHANNEL, action);
}

function label(key: LabelKey): string {
  return translations[currentState?.language ?? "en"][key];
}

function getDraggedTabId(dataTransfer: DataTransfer | null | undefined): string {
  return dataTransfer?.getData("application/x-rion-runtime-tab") ||
    dataTransfer?.getData("text/plain") || "";
}

function render(): void {
  const root = document.getElementById("runtime-tabs-root");
  if (!root || !currentState) return;
  root.replaceChildren();

  const bar = element("div", `runtime-bar${currentState.toolbarVisible ? "" : " is-collapsed"}`);
  if (currentState.fullscreen && !currentState.alwaysShowToolbarInFullScreen) {
    bar.addEventListener("pointerenter", () => send({ type: "fullscreenToolbarEnter" }));
    bar.addEventListener("pointerleave", () => send({ type: "fullscreenToolbarLeave" }));
  }

  const tabs = element("div", "runtime-tab-list");
  tabs.setAttribute("role", "tablist");
  tabs.addEventListener("dragover", (event) => event.preventDefault());
  tabs.addEventListener("drop", (event) => {
    event.preventDefault();
    const tabId = getDraggedTabId(event.dataTransfer);
    const source = currentState?.tabs.find((tab) => tab.id === tabId);
    if (!tabId || !currentState || !source) return;
    send(source.displayId === currentState.displayId
      ? { type: "reorder", tabId }
      : { type: "move", tabId, displayId: currentState.displayId });
  });

  for (const tab of currentState.tabs.filter(
    (item) => item.displayId === currentState?.displayId && !item.hidden
  )) {
    const tabButton = element("div", `runtime-tab${tab.active ? " is-active" : ""}`);
    tabButton.draggable = true;
    tabButton.tabIndex = 0;
    tabButton.setAttribute("role", "tab");
    tabButton.setAttribute("aria-selected", String(tab.active));
    tabButton.title = tab.name;
    tabButton.addEventListener("click", () => send({ type: "activate", tabId: tab.id }));
    tabButton.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        send({ type: "activate", tabId: tab.id });
      }
    });
    tabButton.addEventListener("dragstart", (event) => {
      event.dataTransfer?.setData("application/x-rion-runtime-tab", tab.id);
      event.dataTransfer?.setData("text/plain", tab.id);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    });
    tabButton.addEventListener("dragover", (event) => event.preventDefault());
    tabButton.addEventListener("drop", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const movedTabId = getDraggedTabId(event.dataTransfer);
      const source = currentState?.tabs.find((item) => item.id === movedTabId);
      if (!movedTabId || movedTabId === tab.id || !currentState || !source) return;
      send(source.displayId === currentState.displayId
        ? { type: "reorder", tabId: movedTabId, beforeTabId: tab.id }
        : { type: "move", tabId: movedTabId, displayId: currentState.displayId });
    });

    const marker = createTabMarker(tab);
    const name = element("span", "runtime-tab-name");
    name.textContent = tab.name;
    const count = element("span", "runtime-tab-count");
    count.textContent = tab.type === "workspace" ? String(tab.roleIds.length) : "";
    const more = iconButton("⋯", label("more"), () => send({ type: "openTabMenu", tabId: tab.id }));
    more.classList.add("runtime-tab-action");
    tabButton.append(marker, name, count, more);
    tabs.append(tabButton);
  }

  const add = iconButton("+", label("add"), () => send({ type: "openLauncher" }));
  add.classList.add("runtime-add");
  tabs.append(add);
  if (process.platform === "darwin") bar.append(createTrafficLights());
  bar.append(tabs);
  root.append(bar);
}

function createTrafficLights(): HTMLDivElement {
  const controls = element("div", "runtime-window-controls");
  const close = trafficLight("close", "×", label("close"), () => {
    send({ type: "windowControl", control: "close" });
  });
  const minimize = trafficLight("minimize", "−", label("minimize"), () => {
    send({ type: "windowControl", control: "minimize" });
  });
  minimize.disabled = Boolean(currentState?.windowFullscreen);
  const fullscreenLabel = label(currentState?.windowFullscreen ? "exitFullScreen" : "enterFullScreen");
  const fullscreen = trafficLight("fullscreen", "↗", fullscreenLabel, (event) => {
    send({
      type: "windowControl",
      control: event.altKey ? "zoom" : "toggleFullscreen"
    });
  });
  controls.append(close, minimize, fullscreen);
  return controls;
}

function createTabMarker(tab: EmbeddedRuntimeTabSummary): HTMLSpanElement {
  const marker = element("span", `runtime-tab-marker ${tab.type}`);
  marker.setAttribute("aria-hidden", "true");
  if (tab.type === "workspace") {
    marker.append(createWorkspaceLayoutIcon(
      currentState?.tabWorkspaceTemplates[tab.id] ?? "two_columns"
    ));
    return marker;
  }

  const showFallback = () => marker.replaceChildren(createGamepadIcon());
  const iconDataUrl = currentState?.tabIconDataUrls[tab.id];
  if (!iconDataUrl) {
    showFallback();
    return marker;
  }

  const image = document.createElement("img");
  image.alt = "";
  image.draggable = false;
  image.addEventListener("error", showFallback, { once: true });
  image.src = iconDataUrl;
  marker.append(image);
  return marker;
}

function createGamepadIcon(): SVGSVGElement {
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("stroke-width", "1.8");

  const paths = [
    "M6 11h4M8 9v4M15 12h.01M18 10h.01",
    "M17.32 5H6.68a4 4 0 0 0-3.79 2.7l-1.71 5.12A3.2 3.2 0 0 0 4.22 17H5a2 2 0 0 0 1.6-.8l.6-.8a2 2 0 0 1 1.6-.8h6.4a2 2 0 0 1 1.6.8l.6.8A2 2 0 0 0 19 17h.78a3.2 3.2 0 0 0 3.04-4.18L21.11 7.7A4 4 0 0 0 17.32 5Z"
  ];
  paths.forEach((value) => {
    const path = document.createElementNS(namespace, "path");
    path.setAttribute("d", value);
    svg.append(path);
  });
  return svg;
}

function createWorkspaceLayoutIcon(template: WorkspaceLayoutTemplate): SVGSVGElement {
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("stroke-width", "2");

  workspaceLayoutIconNodes[template].forEach(([elementName, attributes]) => {
    const element = document.createElementNS(namespace, elementName);
    Object.entries(attributes).forEach(([name, value]) => {
      if (name !== "key") element.setAttribute(name, value);
    });
    svg.append(element);
  });
  return svg;
}

function trafficLight(
  kind: "close" | "minimize" | "fullscreen",
  glyph: string,
  labelText: string,
  onClick: (event: MouseEvent) => void
): HTMLButtonElement {
  const button = element("button", `runtime-traffic-light ${kind}`);
  button.type = "button";
  button.textContent = glyph;
  button.title = labelText;
  button.setAttribute("aria-label", labelText);
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick(event);
  });
  return button;
}

function iconButton(text: string, labelText: string, onClick: () => void): HTMLButtonElement {
  const button = element("button", "runtime-icon-button");
  button.type = "button";
  button.textContent = text;
  button.title = labelText;
  button.setAttribute("aria-label", labelText);
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

function installStyles(): void {
  const style = document.createElement("style");
  style.textContent = `
    :root {
      color-scheme: light dark;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
      --runtime-text: rgba(255,255,255,.9);
      --runtime-muted: rgba(255,255,255,.54);
      --runtime-bar-material: rgba(24,25,29,.58);
      --runtime-bar-highlight: rgba(255,255,255,.045);
      --runtime-edge: rgba(255,255,255,.095);
      --runtime-tab-hover: rgba(255,255,255,.065);
      --runtime-tab-active: rgba(255,255,255,.115);
      --runtime-tab-border: rgba(255,255,255,.11);
      --runtime-tab-divider: rgba(255,255,255,.075);
      --runtime-tab-highlight: rgba(255,255,255,.075);
      --runtime-control-hover: rgba(255,255,255,.1);
      --runtime-focus: rgba(138,180,255,.72);
      --runtime-workspace: #9bbcff;
    }
    * { box-sizing: border-box; }
    html, body, #runtime-tabs-root { height: 100%; margin: 0; overflow: hidden; }
    body {
      background: transparent;
      color: var(--runtime-text);
      font-size: 12px;
      line-height: 1;
      user-select: none;
      -webkit-font-smoothing: antialiased;
      text-rendering: optimizeLegibility;
    }
    button { color: inherit; font: inherit; }
    .runtime-bar {
      -webkit-app-region: drag;
      align-items: center;
      background:
        linear-gradient(180deg, var(--runtime-bar-highlight) 0%, transparent 72%),
        var(--runtime-bar-material);
      border-bottom: 1px solid var(--runtime-edge);
      display: flex;
      gap: 6px;
      height: 40px;
      overflow: hidden;
      padding: 4px 10px;
      -webkit-backdrop-filter: blur(24px) saturate(1.18);
      backdrop-filter: blur(24px) saturate(1.18);
    }
    .runtime-bar.is-collapsed { background: transparent; border-bottom: 0; height: 2px; padding: 0; }
    .runtime-bar.is-collapsed > * { visibility: hidden; }
    :root[data-platform="darwin"] .runtime-bar { height: 100%; }
    :root[data-platform="darwin"] .runtime-bar:not(.is-collapsed) {
      padding-top: max(4px, calc(100vh - 36px));
    }
    :root[data-platform="darwin"] .runtime-bar.is-collapsed { padding-left: 0; }
    :root[data-platform="win32"] .runtime-bar { padding-left: max(10px, env(titlebar-area-x, 0px)); padding-right: max(10px, calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw))); }
    :root[data-platform="win32"] .runtime-bar.is-collapsed { padding-left: 0; padding-right: 0; }
    .runtime-tab-list { align-items: center; display: flex; flex: 1; gap: 4px; min-width: 0; overflow-x: auto; scrollbar-width: none; }
    .runtime-tab-list::-webkit-scrollbar { display: none; }
    .runtime-tab, .runtime-icon-button, .runtime-window-controls, .runtime-traffic-light { -webkit-app-region: no-drag; }
    .runtime-window-controls { align-items: center; display: flex; flex: 0 0 auto; gap: 8px; margin: 0 7px 0 4px; }
    .runtime-traffic-light { align-items: center; border: 0; border-radius: 50%; color: transparent; display: inline-flex; font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 9px; font-weight: 700; height: 13px; justify-content: center; line-height: 13px; padding: 0; width: 13px; }
    .runtime-window-controls:hover .runtime-traffic-light { color: rgba(28,28,30,.75); }
    .runtime-traffic-light.close { background: #ff5f57; border: 1px solid #e0443e; }
    .runtime-traffic-light.minimize { background: #febc2e; border: 1px solid #d89e24; }
    .runtime-traffic-light.fullscreen { background: #28c840; border: 1px solid #1aaa32; }
    .runtime-traffic-light:disabled { background: #5d5d61; border-color: #4c4c50; color: transparent; }
    .runtime-tab {
      align-items: center;
      background: transparent;
      border: 1px solid transparent;
      border-radius: 8px;
      color: inherit;
      display: flex;
      flex: 0 1 auto;
      gap: 5px;
      height: 30px;
      max-width: 220px;
      min-width: 96px;
      overflow: visible;
      padding: 0 4px 0 9px;
      position: relative;
      transition: background-color 120ms ease, border-color 120ms ease;
      width: max-content;
    }
    .runtime-tab + .runtime-tab::before,
    .runtime-tab + .runtime-add::before {
      background: var(--runtime-tab-divider);
      content: "";
      height: 14px;
      pointer-events: none;
      position: absolute;
      top: 50%;
      transform: translate(-50%, -50%);
      width: 1px;
    }
    .runtime-tab + .runtime-tab::before { left: -3px; }
    .runtime-tab + .runtime-add::before { left: -2px; }
    .runtime-tab:hover { background: var(--runtime-tab-hover); }
    .runtime-tab.is-active {
      background:
        linear-gradient(180deg, var(--runtime-tab-highlight) 0%, transparent 68%),
        var(--runtime-tab-active);
      border-color: var(--runtime-tab-border);
    }
    .runtime-tab:focus-visible {
      border-color: var(--runtime-focus);
      outline: none;
    }
    .runtime-tab-marker {
      align-items: center;
      color: var(--runtime-muted);
      display: inline-flex;
      flex: 0 0 14px;
      font-size: 10px;
      height: 14px;
      justify-content: center;
      line-height: 1;
      text-align: center;
      width: 14px;
    }
    .runtime-tab-marker img { border-radius: 3px; display: block; height: 14px; object-fit: cover; width: 14px; }
    .runtime-tab-marker svg { display: block; height: 14px; width: 14px; }
    .runtime-tab-marker.workspace { color: var(--runtime-workspace); font-size: 11px; }
    .runtime-tab-name {
      flex: 0 1 auto;
      font-size: 12px;
      font-weight: 500;
      letter-spacing: -.01em;
      line-height: 1;
      min-width: 0;
      overflow: hidden;
      text-align: left;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .runtime-tab-count { color: var(--runtime-muted); font-size: 9px; font-variant-numeric: tabular-nums; }
    .runtime-tab-count:empty { display: none; }
    .runtime-icon-button {
      align-items: center;
      background: transparent;
      border: 0;
      border-radius: 6px;
      color: var(--runtime-muted);
      display: inline-flex;
      flex: 0 0 auto;
      height: 22px;
      justify-content: center;
      min-width: 22px;
      padding: 0;
      transition: background-color 120ms ease, color 120ms ease, opacity 120ms ease;
    }
    .runtime-icon-button:hover, .runtime-icon-button:focus-visible {
      background: var(--runtime-control-hover);
      color: var(--runtime-text);
    }
    .runtime-icon-button:focus-visible { box-shadow: inset 0 0 0 1px var(--runtime-focus); outline: none; }
    .runtime-tab-action { margin-left: auto; opacity: 0; }
    .runtime-tab:hover .runtime-tab-action,
    .runtime-tab.is-active .runtime-tab-action,
    .runtime-tab:focus-within .runtime-tab-action { opacity: 1; }
    .runtime-add { flex: 0 0 28px; font-size: 18px; font-weight: 400; height: 28px; position: relative; }
    @media (prefers-color-scheme: light) {
      :root {
        --runtime-text: rgba(24,24,28,.88);
        --runtime-muted: rgba(24,24,28,.52);
        --runtime-bar-material: rgba(244,245,247,.62);
        --runtime-bar-highlight: rgba(255,255,255,.34);
        --runtime-edge: rgba(26,28,34,.1);
        --runtime-tab-hover: rgba(20,22,28,.052);
        --runtime-tab-active: rgba(255,255,255,.68);
        --runtime-tab-border: rgba(24,26,32,.095);
        --runtime-tab-divider: rgba(24,26,32,.075);
        --runtime-tab-highlight: rgba(255,255,255,.52);
        --runtime-control-hover: rgba(20,22,28,.07);
        --runtime-focus: rgba(36,99,235,.62);
        --runtime-workspace: #3867bd;
      }
    }
    @media (prefers-reduced-transparency: reduce) {
      :root { --runtime-bar-material: rgb(43,44,49); --runtime-bar-highlight: transparent; }
      .runtime-bar { -webkit-backdrop-filter: none; backdrop-filter: none; }
    }
    @media (prefers-color-scheme: light) and (prefers-reduced-transparency: reduce) {
      :root { --runtime-bar-material: rgb(238,239,242); }
    }
    @media (prefers-reduced-motion: reduce) {
      .runtime-tab, .runtime-icon-button { transition: none; }
    }
  `;
  document.head.append(style);
}
