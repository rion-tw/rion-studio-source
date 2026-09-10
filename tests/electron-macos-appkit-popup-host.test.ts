import { describe, expect, it } from "vitest";

import { classifyMacosPopupAction } from
  "../src/electron/main/macosAppKitPopupHost";

const popupId = "10000000-0000-4000-8000-000000000001";
const windowId = `popup-${popupId}`;

function classify(action: Readonly<Record<string, unknown>>) {
  return classifyMacosPopupAction(popupId, windowId, action);
}

describe("macOS AppKit popup action policy", () => {
  it.each([
    { type: "openLauncher", sourceWindowId: windowId },
    { type: "openTabMenu", sourceWindowId: windowId, tabId: popupId },
    {
      type: "tabDragStart",
      sourceWindowId: windowId,
      tabId: popupId
    },
    { type: "tabDragMove", sourceWindowId: windowId },
    { type: "tabDragEnd", sourceWindowId: windowId },
    {
      type: "tabDragHover",
      sourceWindowId: windowId,
      tabId: popupId,
      targetWindowId: windowId
    },
    {
      type: "tabDragDrop",
      sourceWindowId: windowId,
      tabId: popupId,
      targetWindowId: windowId
    }
  ])("ignores a queued popup-local $type action", (action) => {
    expect(classify(action)).toBe("ignore");
  });

  it.each([
    { type: "openLauncher", sourceWindowId: "foreign-window" },
    {
      type: "openTabMenu",
      sourceWindowId: windowId,
      tabId: "foreign-tab"
    },
    {
      type: "tabDragStart",
      sourceWindowId: "foreign-window",
      tabId: popupId
    },
    {
      type: "tabDragDrop",
      sourceWindowId: "foreign-window",
      tabId: popupId,
      targetWindowId: windowId
    },
    {
      type: "tabDragDrop",
      sourceWindowId: windowId,
      tabId: popupId,
      targetWindowId: "foreign-window"
    },
    { type: "reorder", sourceWindowId: windowId, tabId: popupId },
    { type: "unknown", sourceWindowId: windowId }
  ])("rejects foreign or mutating $type action evidence", (action) => {
    expect(classify(action)).toBe("reject");
  });

  it("retains focus, close, layout, and native-state behavior", () => {
    expect(classify({
      type: "activate", sourceWindowId: windowId, tabId: popupId
    })).toBe("focus");
    expect(classify({
      type: "stop", sourceWindowId: windowId, tabId: popupId
    })).toBe("close");
    expect(classify({ type: "closeWindow" })).toBe("close");
    expect(classify({
      type: "windowPlacementChanged", sourceWindowId: windowId
    })).toBe("layout");
    expect(classify({
      type: "windowFocusChanged", sourceWindowId: windowId
    })).toBe("ignore");
  });
});
