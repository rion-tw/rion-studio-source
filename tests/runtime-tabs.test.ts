import { describe, expect, it } from "vitest";

import { isRuntimeTabAction } from "../src/shared/runtimeTabs";

describe("runtime tab shared contracts", () => {
  it("accepts only bounded runtime chrome action shapes", () => {
    expect(isRuntimeTabAction({ type: "activate", tabId: "tab-1" })).toBe(true);
    expect(isRuntimeTabAction({ type: "move", tabId: "tab-1", displayId: -22 })).toBe(true);
    expect(isRuntimeTabAction({ type: "reorder", tabId: "tab-1", beforeTabId: "tab-2" })).toBe(true);
    expect(isRuntimeTabAction({ type: "openLauncher" })).toBe(true);
    expect(isRuntimeTabAction({ type: "openTabMenu", tabId: "tab-1" })).toBe(true);
    expect(isRuntimeTabAction({ type: "fullscreenToolbarEnter" })).toBe(true);
    expect(isRuntimeTabAction({ type: "fullscreenToolbarLeave" })).toBe(true);
    expect(isRuntimeTabAction({ type: "windowControl", control: "close" })).toBe(true);
    expect(isRuntimeTabAction({ type: "windowControl", control: "toggleFullscreen" })).toBe(true);

    expect(isRuntimeTabAction({ type: "activate", tabId: "" })).toBe(false);
    expect(isRuntimeTabAction({ type: "move", tabId: "tab-1", displayId: 1.5 })).toBe(false);
    expect(isRuntimeTabAction({ type: "openLauncher", itemId: "role-1" })).toBe(false);
    expect(isRuntimeTabAction({ type: "openTabMenu", tabId: "" })).toBe(false);
    expect(isRuntimeTabAction({ type: "windowControl", control: "fullscreen" })).toBe(false);
    expect(isRuntimeTabAction({ type: "windowControl", control: "close", displayId: 1 })).toBe(false);
  });
});
