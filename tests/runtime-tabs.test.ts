import { describe, expect, it } from "vitest";

import { createRuntimeTabLaunchItems, isRuntimeTabAction } from "../src/shared/runtimeTabs";
import type { EmbeddedRuntimeState, LaunchWorkspace, Role } from "../src/shared/types";

const role = {
  id: "role-1",
  gameId: "game-1",
  name: "Main",
  launchUrl: "https://example.com/play",
  windowWidth: 1280,
  windowHeight: 720,
  notes: "",
  authState: "authenticated",
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z"
} satisfies Role;

const workspace = {
  id: "workspace-1",
  browserLaunchMode: "inherit",
  browserZoomMode: "fixed",
  browserZoomPercent: 100,
  name: "Party",
  template: "single",
  resourcePolicy: { mode: "unrestricted" },
  slots: [],
  targetDisplayId: 22,
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z"
} satisfies LaunchWorkspace;

describe("runtime tab shared contracts", () => {
  it("marks running and hidden launcher items from runtime-only state", () => {
    const state: EmbeddedRuntimeState = {
      windows: [{
        displayId: 11,
        bounds: { x: 0, y: 0, width: 1200, height: 800 },
        visible: false,
        activeTabId: "tab-1",
        tabCount: 1
      }],
      tabs: [{
        id: "tab-1",
        type: "workspace",
        sourceId: workspace.id,
        name: workspace.name,
        displayId: 11,
        roleIds: [role.id],
        hidden: false,
        active: false
      }]
    };

    expect(createRuntimeTabLaunchItems([role], [workspace], state)).toEqual([
      { id: role.id, name: role.name, type: "role", running: true, hidden: true },
      {
        id: workspace.id,
        name: workspace.name,
        type: "workspace",
        running: true,
        hidden: true,
        targetDisplayId: 22
      }
    ]);
  });

  it("accepts only bounded runtime chrome action shapes", () => {
    expect(isRuntimeTabAction({ type: "activate", tabId: "tab-1" })).toBe(true);
    expect(isRuntimeTabAction({ type: "move", tabId: "tab-1", displayId: -22 })).toBe(true);
    expect(isRuntimeTabAction({ type: "reorder", tabId: "tab-1", beforeTabId: "tab-2" })).toBe(true);
    expect(isRuntimeTabAction({ type: "setOverlay", open: true })).toBe(true);
    expect(isRuntimeTabAction({ type: "launch", itemType: "workspace", itemId: "workspace-1" })).toBe(true);

    expect(isRuntimeTabAction({ type: "activate", tabId: "" })).toBe(false);
    expect(isRuntimeTabAction({ type: "move", tabId: "tab-1", displayId: 1.5 })).toBe(false);
    expect(isRuntimeTabAction({ type: "setOverlay", open: "yes" })).toBe(false);
    expect(isRuntimeTabAction({ type: "launch", itemType: "game", itemId: "game-1" })).toBe(false);
  });
});
