import { describe, expect, it, vi } from "vitest";

import { createChromiumRoleFontApiDispatcher } from
  "../src/electron/main/chromiumRoleFontApiDispatcher";
import type { RendererIdentity } from "../src/electron/main/rendererIdentity";

const IDENTITY = Object.freeze({
  generation: 1,
  id: "renderer-1",
  kind: "main"
}) as unknown as RendererIdentity;

describe("Chromium role browser-font API dispatcher", () => {
  it.each([
    "updateGameBrowserSettings",
    "patchGameBrowserSettings",
    "installBrowserFont",
    "installGoogleFont",
    "removeBrowserFont",
    "applyPortableImport"
  ] as const)("refreshes every live role after successful %s", async (method) => {
    const invoke = vi.fn(async () => ({ committed: true }));
    const refreshRoleFonts = vi.fn(async () => [{ status: "applied" }]);
    const subject = createChromiumRoleFontApiDispatcher(
      { invoke } as never,
      { refreshRoleFonts }
    );

    await expect(subject.invoke(IDENTITY, method, [] as never)).resolves.toEqual({
      committed: true
    });
    expect(refreshRoleFonts).toHaveBeenCalledWith([]);
    expect(invoke.mock.invocationCallOrder[0]).toBeLessThan(
      refreshRoleFonts.mock.invocationCallOrder[0]!
    );
  });

  it("does not report success when a live document rejects the replacement payload", async () => {
    const invoke = vi.fn(async () => ({ installed: true }));
    const refreshRoleFonts = vi.fn(async () => {
      throw new Error("font refresh rejected");
    });
    const subject = createChromiumRoleFontApiDispatcher(
      { invoke } as never,
      { refreshRoleFonts }
    );

    await expect(subject.invoke(
      IDENTITY,
      "installBrowserFont",
      ["inter"]
    )).rejects.toThrow("font refresh rejected");
  });

  it("does not refresh after a failed Core mutation or an unrelated API call", async () => {
    const refreshRoleFonts = vi.fn(async () => undefined);
    const failed = createChromiumRoleFontApiDispatcher({
      invoke: vi.fn(async () => Promise.reject(new Error("Core rejected")))
    } as never, { refreshRoleFonts });
    await expect(failed.invoke(
      IDENTITY,
      "removeBrowserFont",
      ["inter"]
    )).rejects.toThrow("Core rejected");

    const unrelated = createChromiumRoleFontApiDispatcher({
      invoke: vi.fn(async () => [])
    } as never, { refreshRoleFonts });
    await unrelated.invoke(IDENTITY, "listBrowserFontCatalog", []);
    expect(refreshRoleFonts).not.toHaveBeenCalled();
  });
});
