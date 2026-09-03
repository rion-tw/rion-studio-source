import { describe, expect, it } from "vitest";
import {
  electronLauncherWindowHandle,
  primaryAppWindowHandle
} from "../e2e/desktop/support/window-target";

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

  it("selects the Electron launcher instead of a hidden runtime host", () => {
    expect(electronLauncherWindowHandle([
      {
        handle: "runtime-host",
        url: "file:///D:/Rion/out/renderer/runtime-windows-host.html"
      },
      { handle: "launcher", url: "file:///D:/Rion/out/renderer/index.html" }
    ])).toBe("launcher");
    expect(() => electronLauncherWindowHandle([
      { handle: "runtime-host", url: "file:///Rion/runtime-windows-host.html" },
      { handle: "invalid", url: "not a URL" }
    ])).toThrowError(/launcher window is unavailable/u);
  });
});
