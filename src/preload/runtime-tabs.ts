import { ipcRenderer } from "electron";

import {
  RUNTIME_TABS_ACTION_CHANNEL,
  RUNTIME_TABS_STATE_CHANNEL,
  type RuntimeTabAction,
  type RuntimeTabChromeState
} from "../shared/runtimeTabs";
import type { AppLanguage } from "../shared/types";

type LabelKey = "add" | "hide" | "more";

const translations: Record<AppLanguage, Record<LabelKey, string>> = {
  en: {
    add: "Open role or workspace",
    hide: "Hide tab (keeps running)",
    more: "More actions"
  },
  "zh-TW": {
    add: "開啟角色或工作區",
    hide: "隱藏分頁（保持運行）",
    more: "更多操作"
  },
  "zh-CN": {
    add: "打开角色或工作区",
    hide: "隐藏标签页（保持运行）",
    more: "更多操作"
  },
  ja: {
    add: "ロールまたはワークスペースを開く",
    hide: "タブを非表示（実行を継続）",
    more: "その他の操作"
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

    const marker = element("span", `runtime-tab-marker ${tab.type}`);
    marker.textContent = tab.type === "workspace" ? "▦" : "●";
    const name = element("span", "runtime-tab-name");
    name.textContent = tab.name;
    const count = element("span", "runtime-tab-count");
    count.textContent = tab.type === "workspace" ? String(tab.roleIds.length) : "";
    const hide = eyeOffButton(label("hide"), () => send({ type: "hide", tabId: tab.id }));
    const more = iconButton("⋯", label("more"), () => send({ type: "openTabMenu", tabId: tab.id }));
    hide.classList.add("runtime-tab-action");
    more.classList.add("runtime-tab-action");
    tabButton.append(marker, name, count, hide, more);
    tabs.append(tabButton);
  }

  const add = iconButton("+", label("add"), () => send({ type: "openLauncher" }));
  add.classList.add("runtime-add");
  bar.append(tabs, add);
  root.append(bar);
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

function eyeOffButton(labelText: string, onClick: () => void): HTMLButtonElement {
  const button = iconButton("", labelText, onClick);
  button.innerHTML = `<svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 3 18 18"/><path d="M10.6 10.6a2 2 0 0 0 2.8 2.8"/><path d="M9.9 4.2A10.7 10.7 0 0 1 12 4c7 0 10 8 10 8a16 16 0 0 1-2.1 3.4"/><path d="M6.6 6.6C3.5 8.5 2 12 2 12s3 8 10 8a10.7 10.7 0 0 0 5.4-1.4"/></svg>`;
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
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    html, body, #runtime-tabs-root { height: 100%; margin: 0; overflow: hidden; }
    body { background: transparent; color: rgba(255,255,255,.92); user-select: none; }
    button { font: inherit; }
    .runtime-bar { -webkit-app-region: drag; align-items: center; background: rgba(26,27,31,.88); border-bottom: 1px solid rgba(255,255,255,.12); display: flex; gap: 6px; height: 40px; overflow: hidden; padding: 4px 10px; }
    .runtime-bar.is-collapsed { background: transparent; border-bottom: 0; height: 2px; padding: 0; }
    .runtime-bar.is-collapsed > * { visibility: hidden; }
    :root[data-platform="darwin"] .runtime-bar { padding-left: 82px; }
    :root[data-platform="darwin"] .runtime-bar.is-collapsed { padding-left: 0; }
    :root[data-platform="win32"] .runtime-bar { padding-left: max(10px, env(titlebar-area-x, 0px)); padding-right: max(10px, calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw))); }
    :root[data-platform="win32"] .runtime-bar.is-collapsed { padding-left: 0; padding-right: 0; }
    .runtime-tab-list { display: flex; flex: 1; gap: 4px; min-width: 0; overflow-x: auto; scrollbar-width: none; }
    .runtime-tab-list::-webkit-scrollbar { display: none; }
    .runtime-tab, .runtime-icon-button { -webkit-app-region: no-drag; }
    .runtime-tab { align-items: center; background: rgba(255,255,255,.055); border: 1px solid transparent; border-radius: 7px; color: inherit; display: flex; flex: 0 1 210px; gap: 6px; height: 31px; min-width: 108px; overflow: hidden; padding: 0 6px 0 9px; }
    .runtime-tab:hover { background: rgba(255,255,255,.1); }
    .runtime-tab.is-active { background: rgba(255,255,255,.16); border-color: rgba(255,255,255,.15); }
    .runtime-tab-marker { color: #9ca3af; font-size: 11px; }
    .runtime-tab-marker.workspace { color: #8ab4ff; }
    .runtime-tab-name { flex: 1; overflow: hidden; text-align: left; text-overflow: ellipsis; white-space: nowrap; }
    .runtime-tab-count { color: rgba(255,255,255,.55); font-size: 10px; }
    .runtime-icon-button { align-items: center; background: transparent; border: 0; border-radius: 5px; color: rgba(255,255,255,.72); display: inline-flex; height: 23px; justify-content: center; min-width: 23px; padding: 0; }
    .runtime-icon-button:hover { background: rgba(255,255,255,.13); color: white; }
    .runtime-tab-action { opacity: 0; }
    .runtime-tab:hover .runtime-tab-action, .runtime-tab.is-active .runtime-tab-action { opacity: 1; }
    .runtime-add { flex: 0 0 30px; font-size: 19px; height: 30px; }
    @media (prefers-color-scheme: light) {
      body { color: rgba(20,20,24,.9); }
      .runtime-bar { background: rgba(244,244,246,.91); border-bottom-color: rgba(0,0,0,.14); }
      .runtime-bar.is-collapsed { background: transparent; border-bottom: 0; }
      .runtime-tab { background: rgba(0,0,0,.045); }
      .runtime-tab:hover { background: rgba(0,0,0,.08); }
      .runtime-tab.is-active { background: rgba(255,255,255,.82); border-color: rgba(0,0,0,.12); }
      .runtime-icon-button { color: rgba(0,0,0,.65); }
      .runtime-icon-button:hover { background: rgba(0,0,0,.08); color: black; }
    }
  `;
  document.head.append(style);
}
