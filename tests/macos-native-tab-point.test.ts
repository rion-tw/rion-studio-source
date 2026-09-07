import { describe, expect, it } from "vitest";
import { resolveMacosNativeTabPoint } from
  "../e2e/desktop/support/macos-native-tab-geometry";

function toolbar() {
  return {
    hostKind: "appkit", tabIds: ["a", "b", "c"],
    native: { appKit: {
      tabScreenBounds: { x: -1800, y: -950, width: 120, height: 30 },
      tabAnchors: { a: { x: 240, y: 15 }, b: { x: 440, y: 15 }, c: { x: 520, y: 15 } }
    } }
  };
}
function runtime() {
  return { currentRuntime: {
    hostKind: "appkit-chromium", windowId: "window-a", nativeTabIds: ["a", "b", "c"]
  } };
}

describe("macOS native tab point from retained AppKit geometry", () => {
  it.each([
    { tabId: "a", x: -1740 }, { tabId: "b", x: -1580 }, { tabId: "c", x: -1440 }
  ])("centres unequal-width tab $tabId at negative screen coordinates", ({ tabId, x }) => {
    expect(resolveMacosNativeTabPoint({ tabId, tabName: tabId, windowId: "window-a" }, toolbar(), runtime().currentRuntime))
      .toEqual({ x, y: -935 });
  });

  it.each(["different-owner", "different-order", "duplicate-tab", "missing-anchor", "invalid-bounds"])(
    "rejects %s before a physical click", mismatch => {
      const chrome = toolbar();
      const native = runtime();
      if (mismatch === "different-owner") native.currentRuntime.windowId = "other-window";
      if (mismatch === "different-order") native.currentRuntime.nativeTabIds = ["b", "a", "c"];
      if (mismatch === "duplicate-tab") chrome.tabIds = ["a", "b", "b"];
      if (mismatch === "missing-anchor") Reflect.deleteProperty(chrome.native.appKit.tabAnchors, "b");
      if (mismatch === "invalid-bounds") chrome.native.appKit.tabScreenBounds.width = 0;
      expect(() => resolveMacosNativeTabPoint(
        { tabId: "b", tabName: "B", windowId: "window-a" }, chrome, native.currentRuntime
      )).toThrow(/exact AppKit|native tab geometry/);
    }
  );
});
