import { invoke } from "@tauri-apps/api/core";

import type { RuntimeTabAction, RuntimeTabChromeState } from "../../shared/runtimeTabs";

declare global {
  interface Window {
    __rionApplyRuntimeTabState?: (state: RuntimeTabChromeState) => void;
  }
}

const root = document.querySelector<HTMLDivElement>("#tabs")!;
const add = document.querySelector<HTMLButtonElement>("#add")!;
let current: RuntimeTabChromeState | undefined;

const dispatch = (action: RuntimeTabAction): void => {
  void invoke("rion_runtime_tab_action", { action }).catch(() => undefined);
};

function render(state: RuntimeTabChromeState): void {
  current = state;
  document.documentElement.lang = state.language;
  document.body.dataset.toolbarVisible = String(state.toolbarVisible);
  root.replaceChildren(...state.tabs
    .filter((tab) => tab.displayId === state.displayId && !tab.hidden)
    .map((tab) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `tab${tab.active ? " active" : ""}`;
      button.dataset.tabId = tab.id;
      button.draggable = true;
      button.role = "tab";
      button.title = tab.type === "workspace" && (tab.roleNames?.length ?? 0) > 0
        ? `${tab.name}${state.language.startsWith("zh") ? "：" : ":"}${(tab.roleNames ?? []).join(", ")}`
        : tab.name;
      const iconUrl = state.tabIconDataUrls[tab.id];
      const icon = iconUrl ? document.createElement("img") : document.createElement("span");
      icon.className = `icon${iconUrl ? "" : " fallback"}`;
      if (icon instanceof HTMLImageElement) icon.src = iconUrl;
      else icon.textContent = tab.type === "workspace" ? "W" : "R";
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = tab.name;
      button.append(icon, name);
      if (tab.audioMuted || tab.audible) {
        const audio = document.createElement("span");
        audio.className = "audio";
        audio.textContent = tab.audioMuted ? "⌁" : "◖";
        audio.role = "img";
        audio.ariaLabel = tab.audioMuted
          ? state.language === "zh-TW" ? "分頁已靜音" : state.language === "zh-CN" ? "标签页已静音" : state.language === "ja" ? "タブはミュート中" : "Tab muted"
          : state.language === "zh-TW" ? "正在播放聲音" : state.language === "zh-CN" ? "正在播放声音" : state.language === "ja" ? "音声を再生中" : "Playing audio";
        button.append(audio);
      }
      const more = document.createElement("span");
      more.className = "more";
      more.textContent = "•••";
      more.addEventListener("click", (event) => {
        event.stopPropagation();
        dispatch({ type: "openTabMenu", tabId: tab.id });
      });
      button.append(more);
      const close = document.createElement("span");
      close.className = "close";
      close.textContent = "×";
      close.role = "button";
      close.tabIndex = 0;
      close.ariaLabel = state.language === "zh-TW" ? "停止並關閉分頁" : state.language === "zh-CN"
        ? "停止并关闭标签页" : state.language === "ja" ? "停止してタブを閉じる" : "Stop and close tab";
      close.addEventListener("click", (event) => {
        event.stopPropagation();
        dispatch({ type: "stop", tabId: tab.id });
      });
      close.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          event.stopPropagation();
          dispatch({ type: "stop", tabId: tab.id });
        }
      });
      button.append(close);
      button.addEventListener("click", () => dispatch({ type: "activate", tabId: tab.id }));
      button.addEventListener("auxclick", (event) => {
        if (event.button === 1) dispatch({ type: "stop", tabId: tab.id });
      });
      button.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        dispatch({ type: "openTabMenu", tabId: tab.id });
      });
      button.addEventListener("dragstart", (event) => {
        button.classList.add("dragging");
        event.dataTransfer?.setData("text/rion-runtime-tab", tab.id);
      });
      button.addEventListener("dragend", () => button.classList.remove("dragging"));
      button.addEventListener("dragover", (event) => event.preventDefault());
      button.addEventListener("drop", (event) => {
        event.preventDefault();
        const tabId = event.dataTransfer?.getData("text/rion-runtime-tab");
        if (tabId && tabId !== tab.id) dispatch({ type: "reorder", tabId, beforeTabId: tab.id });
      });
      return button;
    }));
  add.title = state.language === "zh-TW" ? "開啟角色或工作區" : state.language === "zh-CN"
    ? "打开角色或工作区" : state.language === "ja" ? "ロールまたはワークスペースを開く"
      : "Open role or workspace";
}

window.__rionApplyRuntimeTabState = render;
document.body.addEventListener("pointerenter", () => {
  if (current?.fullscreen && !current.alwaysShowToolbarInFullScreen) {
    dispatch({ type: "fullscreenToolbarEnter" });
  }
});
document.body.addEventListener("pointerleave", () => {
  if (current?.fullscreen && !current.alwaysShowToolbarInFullScreen) {
    dispatch({ type: "fullscreenToolbarLeave" });
  }
});
addEventListener("keydown", (event) => {
  if (event.key !== "Tab" || !event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return;
  event.preventDefault();
  dispatch({ type: "activateAdjacent", direction: event.shiftKey ? "previous" : "next" });
}, true);
add.addEventListener("click", () => dispatch({ type: "openLauncher" }));
add.addEventListener("contextmenu", (event) => event.preventDefault());
add.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") dispatch({ type: "openLauncher" });
});

void current;
