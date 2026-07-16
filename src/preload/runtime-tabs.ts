import { ipcRenderer } from "electron";

import {
  RUNTIME_TABS_ACTION_CHANNEL,
  RUNTIME_TABS_LAUNCH_ITEMS_CHANNEL,
  RUNTIME_TABS_STATE_CHANNEL,
  type RuntimeTabAction,
  type RuntimeTabChromeState,
  type RuntimeTabLaunchItem
} from "../shared/runtimeTabs";
import type { AppLanguage } from "../shared/types";

type LabelKey = "add" | "display" | "hide" | "more" | "move" | "running" |
  "runningHidden" | "search" | "stop";

const translations: Record<AppLanguage, Record<LabelKey, string>> = {
  en: {
    add: "Open role or workspace", display: "Display", hide: "Hide tab (keeps running)",
    more: "More actions", move: "Move to display", running: "Running",
    runningHidden: "Running · hidden", search: "Search roles and workspaces", stop: "Stop and close"
  },
  "zh-TW": {
    add: "開啟角色或工作區", display: "顯示器", hide: "隱藏分頁（保持運行）",
    more: "更多操作", move: "移至顯示器", running: "運行中",
    runningHidden: "運行中 · 已隱藏", search: "搜尋角色與工作區", stop: "停止並關閉"
  },
  "zh-CN": {
    add: "打开角色或工作区", display: "显示器", hide: "隐藏标签页（保持运行）",
    more: "更多操作", move: "移至显示器", running: "运行中",
    runningHidden: "运行中 · 已隐藏", search: "搜索角色和工作区", stop: "停止并关闭"
  },
  ja: {
    add: "ロールまたはワークスペースを開く", display: "ディスプレイ", hide: "タブを非表示（実行を継続）",
    more: "その他の操作", move: "ディスプレイへ移動", running: "実行中",
    runningHidden: "実行中 · 非表示", search: "ロールとワークスペースを検索", stop: "停止して閉じる"
  }
};

let currentState: RuntimeTabChromeState | undefined;
let overlayOpen = false;

window.addEventListener("DOMContentLoaded", () => {
  document.documentElement.dataset.platform = process.platform;
  installStyles();
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closePopovers();
  });
  document.addEventListener("pointerdown", (event) => {
    const target = event.target instanceof Element ? event.target : undefined;
    if (overlayOpen && !target?.closest(".runtime-popover, .runtime-icon-button")) closePopovers();
  });
  window.addEventListener("blur", closePopovers);
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
  return dataTransfer?.getData("application/x-rion-runtime-tab") || dataTransfer?.getData("text/plain") || "";
}

function render(): void {
  const root = document.getElementById("runtime-tabs-root");
  if (!root || !currentState) return;
  root.replaceChildren();

  const bar = element("div", "runtime-bar");
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

  for (const tab of currentState.tabs.filter((item) => item.displayId === currentState?.displayId && !item.hidden)) {
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
    const more = iconButton("⋯", label("more"), (event) => openTabMenu(event.currentTarget as HTMLElement, tab.id));
    hide.classList.add("runtime-tab-action");
    more.classList.add("runtime-tab-action");
    tabButton.append(marker, name, count, hide, more);
    tabs.append(tabButton);
  }

  const add = iconButton("+", label("add"), (event) => void openLauncher(event.currentTarget as HTMLElement));
  add.classList.add("runtime-add");
  bar.append(tabs, add);
  root.append(bar);
}

async function openLauncher(anchor: HTMLElement): Promise<void> {
  closePopovers();
  openChromeOverlay();
  let items: RuntimeTabLaunchItem[];
  try {
    items = await ipcRenderer.invoke(RUNTIME_TABS_LAUNCH_ITEMS_CHANNEL) as RuntimeTabLaunchItem[];
  } catch (error) {
    closePopovers();
    throw error;
  }
  const popover = element("section", "runtime-popover runtime-launcher");
  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = label("search");
  search.setAttribute("aria-label", label("search"));
  const list = element("div", "runtime-launch-list");
  const draw = (): void => {
    const query = search.value.trim().toLocaleLowerCase();
    list.replaceChildren();
    for (const item of items.filter((candidate) => !query || candidate.name.toLocaleLowerCase().includes(query))) {
      const button = element("button", "runtime-launch-item");
      button.type = "button";
      button.innerHTML = `<span>${item.type === "workspace" ? "▦" : "●"}</span><span></span><small></small>`;
      (button.children[1] as HTMLElement).textContent = item.name;
      (button.children[2] as HTMLElement).textContent = item.running
        ? label(item.hidden ? "runningHidden" : "running")
        : "";
      button.addEventListener("click", () => {
        send({ type: "launch", itemType: item.type, itemId: item.id });
        closePopovers();
      });
      list.append(button);
    }
  };
  search.addEventListener("input", draw);
  popover.append(search, list);
  positionPopover(popover, anchor);
  document.body.append(popover);
  draw();
  search.focus();
}

function openTabMenu(anchor: HTMLElement, tabId: string): void {
  closePopovers();
  openChromeOverlay();
  const popover = element("section", "runtime-popover runtime-menu");
  const moveLabel = element("p", "runtime-menu-label");
  moveLabel.textContent = label("move");
  popover.append(moveLabel);
  for (const display of currentState?.displays ?? []) {
    const button = element("button", "runtime-menu-item");
    button.type = "button";
    button.textContent = display.label || `${label("display")} ${display.id}`;
    button.disabled = display.id === currentState?.displayId;
    button.addEventListener("click", () => {
      send({ type: "move", tabId, displayId: display.id });
      closePopovers();
    });
    popover.append(button);
  }
  const stop = element("button", "runtime-menu-item is-danger");
  stop.type = "button";
  stop.textContent = label("stop");
  stop.addEventListener("click", () => {
    send({ type: "stop", tabId });
    closePopovers();
  });
  popover.append(stop);
  positionPopover(popover, anchor);
  document.body.append(popover);
}

function iconButton(text: string, label: string, onClick: (event: MouseEvent) => void): HTMLButtonElement {
  const button = element("button", "runtime-icon-button");
  button.type = "button";
  button.textContent = text;
  button.title = label;
  button.setAttribute("aria-label", label);
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick(event);
  });
  return button;
}

function eyeOffButton(labelText: string, onClick: (event: MouseEvent) => void): HTMLButtonElement {
  const button = iconButton("", labelText, onClick);
  button.innerHTML = `<svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 3 18 18"/><path d="M10.6 10.6a2 2 0 0 0 2.8 2.8"/><path d="M9.9 4.2A10.7 10.7 0 0 1 12 4c7 0 10 8 10 8a16 16 0 0 1-2.1 3.4"/><path d="M6.6 6.6C3.5 8.5 2 12 2 12s3 8 10 8a10.7 10.7 0 0 0 5.4-1.4"/></svg>`;
  return button;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

function positionPopover(popover: HTMLElement, anchor: HTMLElement): void {
  const rect = anchor.getBoundingClientRect();
  popover.style.top = `${Math.ceil(rect.bottom + 6)}px`;
  popover.style.right = `${Math.max(8, Math.ceil(window.innerWidth - rect.right))}px`;
}

function closePopovers(): void {
  document.querySelectorAll(".runtime-popover").forEach((node) => node.remove());
  if (!overlayOpen) return;
  overlayOpen = false;
  document.body.classList.remove("runtime-overlay-open");
  send({ type: "setOverlay", open: false });
}

function openChromeOverlay(): void {
  overlayOpen = true;
  document.body.classList.add("runtime-overlay-open");
  send({ type: "setOverlay", open: true });
}

function installStyles(): void {
  const style = document.createElement("style");
  style.textContent = `
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    html, body, #runtime-tabs-root { height: 100%; margin: 0; overflow: hidden; }
    body { background: transparent; color: rgba(255,255,255,.92); user-select: none; }
    body.runtime-overlay-open { background: rgba(12,13,16,.72); }
    button, input { font: inherit; }
    .runtime-bar { -webkit-app-region: drag; align-items: center; background: rgba(26,27,31,.88); border-bottom: 1px solid rgba(255,255,255,.12); display: flex; gap: 6px; height: 40px; padding: 4px 10px; }
    :root[data-platform="darwin"] .runtime-bar { padding-left: 82px; }
    :root[data-platform="win32"] .runtime-bar { padding-left: max(10px, env(titlebar-area-x, 0px)); padding-right: max(10px, calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw))); }
    .runtime-tab-list { display: flex; flex: 1; gap: 4px; min-width: 0; overflow-x: auto; scrollbar-width: none; }
    .runtime-tab-list::-webkit-scrollbar { display: none; }
    .runtime-tab, .runtime-icon-button, .runtime-launch-item, .runtime-menu-item, input { -webkit-app-region: no-drag; }
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
    .runtime-popover { -webkit-app-region: no-drag; background: rgba(34,35,40,.98); border: 1px solid rgba(255,255,255,.14); border-radius: 10px; box-shadow: 0 18px 48px rgba(0,0,0,.42); color: white; max-height: min(520px, calc(100vh - 54px)); position: fixed; z-index: 1000; }
    .runtime-launcher { padding: 9px; width: min(360px, calc(100vw - 16px)); }
    .runtime-launcher input { background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.15); border-radius: 7px; color: white; height: 34px; outline: none; padding: 0 10px; width: 100%; }
    .runtime-launch-list { display: grid; gap: 3px; margin-top: 8px; max-height: 400px; overflow: auto; }
    .runtime-launch-item { align-items: center; background: transparent; border: 0; border-radius: 7px; color: white; display: grid; gap: 8px; grid-template-columns: 16px 1fr auto; min-height: 36px; padding: 6px 8px; text-align: left; }
    .runtime-launch-item:hover, .runtime-menu-item:hover { background: rgba(255,255,255,.1); }
    .runtime-launch-item small { color: rgba(255,255,255,.52); }
    .runtime-menu { min-width: 210px; padding: 6px; }
    .runtime-menu-label { color: rgba(255,255,255,.5); font-size: 11px; margin: 5px 8px; }
    .runtime-menu-item { background: transparent; border: 0; border-radius: 6px; color: white; display: block; padding: 8px; text-align: left; width: 100%; }
    .runtime-menu-item:disabled { opacity: .42; }
    .runtime-menu-item.is-danger { border-top: 1px solid rgba(255,255,255,.1); color: #fca5a5; margin-top: 5px; }
    @media (prefers-color-scheme: light) {
      body { color: rgba(20,20,24,.9); }
      .runtime-bar { background: rgba(244,244,246,.91); border-bottom-color: rgba(0,0,0,.14); }
      .runtime-tab { background: rgba(0,0,0,.045); }
      .runtime-tab:hover { background: rgba(0,0,0,.08); }
      .runtime-tab.is-active { background: rgba(255,255,255,.82); border-color: rgba(0,0,0,.12); }
      .runtime-icon-button { color: rgba(0,0,0,.65); }
      .runtime-icon-button:hover { background: rgba(0,0,0,.08); color: black; }
    }
  `;
  document.head.append(style);
}
