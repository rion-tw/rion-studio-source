import { describe, expect, it, vi } from "vitest";
import { resolveWorkspaceWebDrmOwner } from "../src/electron/e2e/workspaceWebDrmOwner";

describe("DRM diagnostic exact Web owner", () => {
  const tabs = [{ windowId: "window", id: "tab", webSurfaces: [{ surfaceId: "web", slotId: "slot" }] }];
  const surface = { windowId: "window", tabId: "tab", surfaceId: "web", slotId: "slot", generation: 2 };
  function owners() { return new Map([["web", { slotId: "slot", generation: 2,
    registry: { runtimeEvidence: vi.fn(() => ({ contentProfilePath: "/isolated/global-web" })) } }]]); }
  it("reads the live generation without assuming a sibling role count", () => {
    const map = owners();
    expect(resolveWorkspaceWebDrmOwner("window", tabs, [surface], map)).toEqual({ windowId: "window",
      web: { surfaceId: "web", generation: 2, contentProfilePath: "/isolated/global-web" } });
    expect(map.get("web")!.registry.runtimeEvidence).toHaveBeenCalledWith("web", 2);
  });
  it.each([{ generation: 1 }, { tabId: "retired" }, { surfaceId: "other" }, { slotId: "other" }, { windowId: "other" }])(
    "rejects stale or foreign native identity %o", difference => {
      expect(() => resolveWorkspaceWebDrmOwner("window", tabs, [{ ...surface, ...difference }], owners())).toThrow("exact");
    });
  it("rejects ambiguous or retired ownership", () => {
    expect(() => resolveWorkspaceWebDrmOwner("window", tabs, [surface, surface], owners())).toThrow("exact");
    expect(() => resolveWorkspaceWebDrmOwner("window", tabs, [surface], new Map())).toThrow("exact");
    expect(() => resolveWorkspaceWebDrmOwner("window", [...tabs, ...tabs], [surface], owners())).toThrow("exact");
  });
});
