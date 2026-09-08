import { describe, expect, it } from "vitest";

import { windowGestureMode } from "../src/renderer/src/app/windowGestureMode";

 describe("Electron window gesture mode", () => {
  it.each(["mac", "windows"] as const)("uses native regions on %s", (platform) => {
    expect(windowGestureMode(platform)).toBe("native-non-client");
  });

  it("does not expose unsupported Linux native gestures", () => {
    expect(windowGestureMode("linux")).toBe("unavailable");
  });
});
