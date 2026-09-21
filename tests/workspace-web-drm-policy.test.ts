import { afterEach, describe, expect, it, vi } from "vitest";
import { readDrmPolicy } from "../src/electron/e2e/workspaceWebDrmPolicy";
import { readWorkspaceWebSecurityPolicy } from "../src/electron/e2e/workspaceWebSecurityPolicyObserver";

vi.mock("../src/electron/e2e/workspaceWebSecurityPolicyObserver", () => ({
  readWorkspaceWebSecurityPolicy: vi.fn(() => ({ policyVersion: 2 }))
}));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("mixed DRM journal isolation", () => {
  function ports(roleCount: number) {
    const invoke = vi.fn(async () => ({ browserRuntime: { tabs: [{ id: "tab", windowId: "window",
      webSurfaces: [{ surfaceId: "web", slotId: "slot" }] }] } }));
    const snapshot = vi.fn(() => ({ roles: Array.from({ length: roleCount }, () => ({ windowId: "window" })),
      webSurfaces: [{ windowId: "window", tabId: "tab", surfaceId: "web", slotId: "slot", generation: 1 }] }));
    return { core: { invoke } as unknown as NonNullable<Parameters<typeof readDrmPolicy>[1]>,
      runtime: { snapshot } as unknown as NonNullable<Parameters<typeof readDrmPolicy>[2]>, invoke,
      owners: new Map([["web", { slotId: "slot", generation: 1,
        registry: { runtimeEvidence: () => ({ contentProfilePath: "/isolated/web" }) } }]]) };
  }
  it("retains paired permission/download evidence for ordinary inspections", async () => {
    vi.stubEnv("RION_STUDIO_E2E_DRM_DIAGNOSTIC", "1");
    const input = ports(1);
    expect(await readDrmPolicy("window", input.core, input.runtime, input.owners)).toBeNull();
    expect(input.invoke).not.toHaveBeenCalled();
    expect(readWorkspaceWebSecurityPolicy).not.toHaveBeenCalled();
  });
  it("reads the mixed live owner without writing the paired journey journal", async () => {
    vi.stubEnv("RION_STUDIO_E2E_DRM_DIAGNOSTIC", "1");
    const input = ports(2);
    expect(await readDrmPolicy("window", input.core, input.runtime, input.owners)).toEqual({ policyVersion: 2 });
    expect(readWorkspaceWebSecurityPolicy).toHaveBeenCalledWith({ windowId: "window",
      web: { surfaceId: "web", generation: 1, contentProfilePath: "/isolated/web" } }, false);
  });
  it("does not add an inspection path without diagnostic opt-in", async () => {
    vi.stubEnv("RION_STUDIO_E2E_DRM_DIAGNOSTIC", "");
    const input = ports(2);
    expect(await readDrmPolicy("window", input.core, input.runtime, input.owners)).toBeNull();
    expect(input.invoke).not.toHaveBeenCalled();
  });
});
