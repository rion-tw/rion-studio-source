import type { WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import { createChromiumSystemFontProvider } from "../src/electron/main/chromiumSystemFonts";

function harness(platform: "darwin" | "win32") {
  const url = "file:///app/index.html";
  const family = platform === "darwin" ? "PingFang TC" : "Microsoft JhengHei";
  let currentUrl = url;
  let destroyed = false;
  let check: (...args: unknown[]) => boolean;
  let request: (...args: unknown[]) => void;
  const events = new Map<string, (...args: unknown[]) => void>();
  const execute = vi.fn<() => Promise<unknown>>().mockResolvedValue(["Arial", family]);
  const contents = {
    getURL: () => currentUrl,
    isDestroyed: () => destroyed,
    mainFrame: { executeJavaScript: execute },
    on: (event: string, listener: (...args: unknown[]) => void) => events.set(event, listener),
    session: {
      setPermissionCheckHandler: (handler: typeof check) => { check = handler; },
      setPermissionRequestHandler: (handler: typeof request) => { request = handler; }
    }
  };
  const provider = createChromiumSystemFontProvider(contents as unknown as WebContents, url);
  return { provider, contents, execute, family, events,
    check: (owner: unknown, permission: string, details: unknown) => check(owner, permission, "file://", details),
    request: (owner: unknown, permission: string, callback: (value: boolean) => void, details: unknown) =>
      request(owner, permission, callback, details),
    navigate: (next: string) => { currentUrl = next; events.get("did-start-navigation")!({}, next, false, true); },
    destroy: () => { destroyed = true; }
  };
}

describe.each(["darwin", "win32"] as const)("%s Chromium local fonts", platform => {
  it("admits only the exact local-fonts owner and main document", () => {
    const h = harness(platform);
    const details = { isMainFrame: true, requestingUrl: "file:///app/index.html" };
    expect(h.check(h.contents, "local-fonts", details)).toBe(true);
    for (const [owner, permission, request] of [
      [{}, "local-fonts", details],
      [h.contents, "camera", details],
      [h.contents, "local-fonts", { ...details, isMainFrame: false }],
      [h.contents, "local-fonts", { ...details, requestingUrl: "https://remote.test/" }],
      [h.contents, "local-fonts", {}]
    ] as const) {
      expect(h.check(owner, permission, request)).toBe(false);
      const callback = vi.fn();
      h.request(owner, permission, callback, request);
      expect(callback).toHaveBeenCalledWith(false);
    }
    h.destroy();
    expect(h.check(h.contents, "local-fonts", details)).toBe(false);
  });

  it("returns platform fonts without activation and leaves normalization to Rust", async () => {
    const h = harness(platform);
    h.execute.mockResolvedValueOnce([" Arial ", "Arial", h.family]);
    expect(await h.provider.list()).toEqual([" Arial ", "Arial", h.family]);
    expect(h.execute).toHaveBeenCalledWith(expect.stringContaining("queryLocalFonts"), false);
  });

  it("returns empty enumeration on native denial or malformed output for Rust fallback", async () => {
    const h = harness(platform);
    h.execute.mockRejectedValueOnce(new Error("NotAllowedError"));
    expect(await h.provider.list()).toEqual([]);
    h.execute.mockResolvedValueOnce([12]);
    expect(await h.provider.list()).toEqual([]);
    h.execute.mockResolvedValueOnce(Array(4097).fill("Arial"));
    expect(await h.provider.list()).toEqual([]);
  });

  it("rejects a query completed after exact-document replacement", async () => {
    const h = harness(platform);
    let complete!: (value: unknown) => void;
    h.execute.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const pending = h.provider.list();
    h.navigate("file:///app/index.html");
    complete(["Arial"]);
    await expect(pending).rejects.toThrow("retired document");
  });

  it("rejects foreign navigation before querying Chromium", async () => {
    const h = harness(platform);
    h.navigate("https://remote.test/");
    await expect(h.provider.list()).rejects.toThrow("retired document");
    expect(h.execute).not.toHaveBeenCalled();
  });
});
