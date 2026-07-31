import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { formatRuntimeTabTooltip, isRuntimeTabAction } from "../src/shared/runtimeTabs";

const systemRuntimeSource = await readFile(
  new URL("../src-tauri/src/system_runtime.rs", import.meta.url),
  "utf8"
);

describe("runtime tab shell-neutral contracts", () => {
  it("accepts only bounded runtime tab action shapes", () => {
    expect(isRuntimeTabAction({ type: "activate", tabId: "tab-1" })).toBe(true);
    expect(isRuntimeTabAction({ type: "move", tabId: "tab-1", windowId: "window-22" })).toBe(true);
    expect(isRuntimeTabAction({
      type: "tabDragStart",
      sessionId: "drag-1",
      tabId: "tab-1",
      screenX: 100,
      screenY: 200
    })).toBe(true);
    expect(isRuntimeTabAction({ type: "tabDragMove", sessionId: "drag-1", screenX: 120, screenY: 220 })).toBe(true);
    expect(isRuntimeTabAction({ type: "tabDragDrop", sessionId: "drag-1", windowId: "window-22", beforeTabId: "tab-2" })).toBe(true);
    expect(isRuntimeTabAction({ type: "tabDragEnd", sessionId: "drag-1", cancelled: false })).toBe(true);
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
    expect(isRuntimeTabAction({ type: "move", tabId: "tab-1", windowId: "" })).toBe(false);
    expect(isRuntimeTabAction({ type: "move", tabId: "tab-1", displayId: 22 })).toBe(false);
    expect(isRuntimeTabAction({ type: "tabDragMove", sessionId: "drag-1", screenX: Number.NaN, screenY: 0 })).toBe(false);
    expect(isRuntimeTabAction({ type: "tabDragEnd", sessionId: "drag-1", cancelled: "no" })).toBe(false);
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
    expect(systemRuntimeSource).toContain(
      '"workspaceTemplate": presented\n                                    .workspace_template\n                                    .or_else(|| live.workspace_template.clone())'
    );
  });
});
