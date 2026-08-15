import { describe, expect, it } from "vitest";

import {
  requiresNativeDeminimizeFocusFence,
  requiresPrearmedNativeTabMenuSelection,
  requiresRendererTabChromeProjection
} from "../e2e/desktop/support/platform";

describe("desktop E2E platform readiness", () => {
  it("waits for the renderer-owned tab chrome projection only on Windows", () => {
    expect(requiresRendererTabChromeProjection("win32")).toBe(true);
    expect(requiresRendererTabChromeProjection("darwin")).toBe(false);
    expect(requiresRendererTabChromeProjection("linux")).toBe(false);
  });

  it("prearms selection for native modal tab menus", () => {
    expect(requiresPrearmedNativeTabMenuSelection("win32")).toBe(true);
    expect(requiresPrearmedNativeTabMenuSelection("darwin")).toBe(true);
    expect(requiresPrearmedNativeTabMenuSelection("linux")).toBe(false);
  });

  it("waits for AppKit focus after an asynchronous deminiaturize", () => {
    expect(requiresNativeDeminimizeFocusFence("darwin")).toBe(true);
    expect(requiresNativeDeminimizeFocusFence("win32")).toBe(false);
    expect(requiresNativeDeminimizeFocusFence("linux")).toBe(false);
  });
});
