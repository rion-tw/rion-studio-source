import { describe, expect, it, vi } from "vitest";
import { installWorkspaceStartProtocol, observeWorkspaceStartPage, updateWorkspaceStartAppearance } from "../src/electron/main/workspaceStartPage";
import type { ChromiumRoleSessionPort } from "../src/electron/main/chromiumRoleSessionRegistry";
import type { ChromiumRoleSurfaceWebContentsPort } from "../src/electron/main/chromiumRoleSurfacePorts";

describe("website entrance protocol and presentation", () => {
  it.each(["macos", "windows"])("serves only the exact packaged GET resource on %s", async (_platform) => {
    let handler!: (request: { url: string; method: string }) => Response;
    const handle = vi.fn((_scheme, listener) => { handler = listener; });
    const session = { protocol: { handle } } as unknown as ChromiumRoleSessionPort;
    installWorkspaceStartProtocol(session);
    installWorkspaceStartProtocol(session);
    expect(handle).toHaveBeenCalledTimes(1);
    const response = handler({ url: "rion-start://home/", method: "GET" });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("data-rion-workspace-start");
    for (const request of [
      { url: "rion-start://home/", method: "POST" },
      { url: "rion-start://home/?other=1", method: "GET" },
      { url: "rion-start://elsewhere/", method: "GET" },
      { url: "https://rion-start.home/", method: "GET" }
    ]) expect(handler(request).status).toBe(404);
  });

  it("updates from settings/load events, skips external pages and detaches destroyed surfaces", () => {
    let url = "rion-start://home/";
    const listeners = new Map<string, () => void>();
    const execute = vi.fn<(world: number, scripts: Array<{ code: string }>) => Promise<void>>(async () => undefined);
    const target = {
      getURL: () => url, isDestroyed: () => false,
      executeJavaScriptInIsolatedWorld: execute,
      on: (event: string, callback: () => void) => listeners.set(event, callback),
      removeListener: (event: string) => listeners.delete(event)
    } as unknown as ChromiumRoleSurfaceWebContentsPort;
    observeWorkspaceStartPage(target);
    updateWorkspaceStartAppearance({ language: "zh-TW", theme: "dark" });
    expect(execute).toHaveBeenLastCalledWith(997, [{ code: expect.stringContaining('"zh-TW"') }]);
    expect(execute.mock.calls[0]?.[1]).toEqual([{ code: expect.stringContaining('"dark"') }]);
    listeners.get("did-finish-load")!();
    expect(execute).toHaveBeenCalledTimes(2);
    url = "https://example.test/";
    updateWorkspaceStartAppearance({ language: "ja" });
    listeners.get("did-finish-load")!();
    expect(execute).toHaveBeenCalledTimes(2);
    listeners.get("destroyed")!();
    expect(listeners.size).toBe(0);
    url = "rion-start://home/";
    updateWorkspaceStartAppearance({ language: "en", theme: "light" });
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
