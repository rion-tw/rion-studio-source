import { readSourceTree as readFile } from "./helpers/readSourceTree";

import { describe, expect, it } from "vitest";

import { formatRuntimeTabTooltip, isRuntimeTabAction } from "../src/shared/runtimeTabs";

const systemRuntimeSource = await readFile(
  new URL("../src-tauri/src/system_runtime.rs", import.meta.url),
  "utf8"
);

describe("runtime tab shell-neutral contracts", () => {
  it("accepts only bounded runtime tab action shapes", () => {
    expect(isRuntimeTabAction({ type: "activate", tabId: "tab-1" })).toBe(true);
    expect(isRuntimeTabAction({
      type: "stop",
      tabId: "tab-1",
      orderedTabIds: ["tab-2"],
      activeTabId: "tab-2",
      windowGeneration: 4
    })).toBe(true);
    expect(isRuntimeTabAction({ type: "move", tabId: "tab-1", windowId: "window-22" })).toBe(true);
    expect(isRuntimeTabAction({
      type: "tabDragStart",
      sessionId: "drag-1",
      tabId: "tab-1",
      screenX: 100,
      screenY: 200,
      grabRatioX: 0.25,
      grabRatioY: 0.5,
      tabWidth: 180,
      tabHeight: 30
    })).toBe(true);
    expect(isRuntimeTabAction({ type: "tabDragMove", sessionId: "drag-1", screenX: 120, screenY: 220 })).toBe(true);
    expect(isRuntimeTabAction({ type: "tabDragHover", sessionId: "drag-1", windowId: "window-22", screenX: 120, screenY: 220, tabWidth: 160, tabHeight: 28, beforeTabId: "tab-2" })).toBe(true);
    expect(isRuntimeTabAction({ type: "tabDragDrop", sessionId: "drag-1", windowId: "window-22", screenX: 120, screenY: 220, orderedTabIds: ["tab-1", "tab-2"], beforeTabId: "tab-2" })).toBe(true);
    expect(isRuntimeTabAction({ type: "tabDragEnd", sessionId: "drag-1", cancelled: false, screenX: 120, screenY: 220 })).toBe(true);
    expect(isRuntimeTabAction({ type: "tabDragSourceEnd", sessionId: "drag-1", cancelled: false, dropAccepted: true, screenX: 120, screenY: 220 })).toBe(true);
    expect(isRuntimeTabAction({ type: "tabDragCancel", sessionId: "drag-1" })).toBe(true);
    expect(isRuntimeTabAction({ type: "reorder", tabId: "tab-1", beforeTabId: "tab-2" })).toBe(true);
    expect(isRuntimeTabAction({ type: "openLauncher" })).toBe(true);
    expect(isRuntimeTabAction({ type: "openTabMenu", tabId: "tab-1" })).toBe(true);
    expect(isRuntimeTabAction({ type: "fullscreenToolbarEnter" })).toBe(true);
    expect(isRuntimeTabAction({ type: "fullscreenToolbarLeave" })).toBe(true);
    expect(isRuntimeTabAction({ type: "activateAdjacent", direction: "next" })).toBe(true);
    expect(isRuntimeTabAction({ type: "applicationShortcut", command: "zoomIn" })).toBe(true);
    expect(isRuntimeTabAction({ type: "windowControl", control: "close" })).toBe(true);

    expect(isRuntimeTabAction({ type: "activate", tabId: "" })).toBe(false);
    expect(isRuntimeTabAction({
      type: "stop",
      tabId: "tab-1",
      orderedTabIds: ["tab-2", "tab-2"]
    })).toBe(false);
    expect(isRuntimeTabAction({ type: "move", tabId: "tab-1", windowId: "" })).toBe(false);
    expect(isRuntimeTabAction({ type: "move", tabId: "tab-1", displayId: 22 })).toBe(false);
    expect(isRuntimeTabAction({ type: "tabDragStart", sessionId: "drag-1", tabId: "tab-1", screenX: 0, screenY: 0, grabRatioX: 1.2, grabRatioY: 0.5, tabWidth: 100, tabHeight: 30 })).toBe(false);
    expect(isRuntimeTabAction({ type: "tabDragMove", sessionId: "drag-1", screenX: Number.NaN, screenY: 0 })).toBe(false);
    expect(isRuntimeTabAction({ type: "tabDragDrop", sessionId: "drag-1", windowId: "window-22", screenX: 0, screenY: 0 })).toBe(false);
    expect(isRuntimeTabAction({ type: "tabDragDrop", sessionId: "drag-1", windowId: "window-22", screenX: 0, screenY: 0, orderedTabIds: ["tab-1", "tab-1"] })).toBe(false);
    expect(isRuntimeTabAction({ type: "tabDragDrop", sessionId: "drag-1", windowId: "window-22", screenX: 0, screenY: 0, orderedTabIds: [""] })).toBe(false);
    expect(isRuntimeTabAction({ type: "tabDragDrop", sessionId: "drag-1", windowId: "window-22", screenX: 0, screenY: 0, orderedTabIds: Array.from({ length: 257 }, (_, index) => `tab-${index}`) })).toBe(false);
    expect(isRuntimeTabAction({ type: "tabDragDrop", sessionId: "drag-1", windowId: "window-22", screenX: 0, screenY: 0, orderedTabIds: ["tab-1"], unexpected: true })).toBe(false);
    expect(isRuntimeTabAction({ type: "tabDragHover", sessionId: "drag-1", windowId: "window-22", screenX: 0, screenY: 0, tabWidth: 160, tabHeight: 28, orderedTabIds: ["tab-1"] })).toBe(false);
    expect(isRuntimeTabAction({ type: "tabDragEnd", sessionId: "drag-1", cancelled: "no" })).toBe(false);
    expect(isRuntimeTabAction({ type: "tabDragSourceEnd", sessionId: "drag-1", cancelled: false, dropAccepted: "yes", screenX: 0, screenY: 0 })).toBe(false);
    expect(isRuntimeTabAction({ type: "openLauncher", itemId: "role-1" })).toBe(false);
    expect(isRuntimeTabAction({ type: "windowControl", control: "fullscreen" })).toBe(false);
    expect(isRuntimeTabAction({ type: "activateAdjacent", direction: "up" })).toBe(false);
    expect(isRuntimeTabAction({ type: "applicationShortcut", command: "quit" })).toBe(false);
    expect(isRuntimeTabAction({ type: "applicationShortcut", command: "zoomIn", extra: true })).toBe(false);
  });

  it("preserves workspace role details in localized tooltips", () => {
    const tab = { name: "Daily", type: "workspace" as const, roleNames: ["One", "Two"] };
    expect(formatRuntimeTabTooltip(tab, "en")).toBe("Daily:One, Two");
    expect(formatRuntimeTabTooltip(tab, "zh-TW")).toBe("Daily：One, Two");
  });

  it("forwards workspace templates through every Windows tab metadata path", () => {
    expect(systemRuntimeSource.match(/"workspaceTemplate": workspace_template/g)).toHaveLength(3);
    expect(
      systemRuntimeSource.match(
        /#\[cfg\(any\(windows, target_os = "macos"\)\)\]\s+workspace_template: Option<String>,/g
      )
    ).toHaveLength(2);
    expect(
      systemRuntimeSource.match(
        /#\[cfg\(any\(windows, target_os = "macos"\)\)\]\s+let workspace_template/g
      )
    ).toHaveLength(6);
    expect(systemRuntimeSource).toContain(
      '"workspaceTemplate": presented\n                                    .workspace_template\n                                    .or_else(|| live.workspace_template.clone())'
    );
  });
});
