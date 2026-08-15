import { describe, expect, it } from "vitest";

import {
  requiresRendererTabChromeProjection
} from "../e2e/desktop/support/platform";

describe("desktop E2E platform readiness", () => {
  it("waits for the renderer-owned tab chrome projection only on Windows", () => {
    expect(requiresRendererTabChromeProjection("win32")).toBe(true);
    expect(requiresRendererTabChromeProjection("darwin")).toBe(false);
    expect(requiresRendererTabChromeProjection("linux")).toBe(false);
  });
});
