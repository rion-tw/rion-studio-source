import { describe, expect, it } from "vitest";
import { primaryAppWindowHandle } from "../e2e/desktop/support/window-target";

describe("desktop E2E window targeting", () => {
  it("selects main when WebDriver initially attached to a closing prewarm window", () => {
    expect(primaryAppWindowHandle([
      "rion-runtime-prewarm-3df32770",
      "main"
    ])).toBe("main");
    expect(primaryAppWindowHandle(["main"])).toBe("main");
  });

  it("fails closed when the authoritative main window is absent", () => {
    expect(() => primaryAppWindowHandle([
      "rion-runtime-prewarm-3df32770",
      "rion-runtime-window-a"
    ])).toThrow(/main window is unavailable/u);
  });
});
