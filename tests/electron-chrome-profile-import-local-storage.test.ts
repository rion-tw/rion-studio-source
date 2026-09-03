import { describe, expect, it, vi } from "vitest";

import {
  CHROME_PROFILE_IMPORT_ISOLATED_WORLD_ID,
  ChromeProfileImportLocalStorageCodec,
  type ChromeProfileImportHelperWebContentsPort
} from "../src/electron/main/chromeProfileImportLocalStorage";
import type { ChromiumRoleSessionPort } from
  "../src/electron/main/chromiumRoleSessionRegistry";

function fixture(unhandleFails = false, loadFails = false) {
  let handler: ((request: { method: string; url: string }) => Response) | null = null;
  const protocol = {
    handle: vi.fn((_scheme: string, next: typeof handler) => { handler = next; }),
    unhandle: vi.fn(() => {
      if (unhandleFails) throw new Error("injected unhandle failure");
      handler = null;
    })
  };
  const session = { protocol } as unknown as ChromiumRoleSessionPort;
  let currentUrl = "";
  let destroyed = false;
  let destroyedListener: (() => void) | null = null;
  const execute = vi.fn(async () => [["session", "secret"]]);
  const contents: ChromeProfileImportHelperWebContentsPort = {
    session,
    close: vi.fn(() => {
      destroyed = true;
      destroyedListener?.();
    }),
    executeJavaScriptInIsolatedWorld: execute,
    getURL: () => currentUrl,
    isDestroyed: () => destroyed,
    loadURL: vi.fn(async (url: string) => {
      if (loadFails) throw new Error("injected navigation failure");
      const response = handler?.({ method: "GET", url });
      if (!response || response.status !== 200) throw new Error("controlled document rejected");
      currentUrl = url;
    }),
    once: vi.fn((_event, listener) => { destroyedListener = listener; }),
    setWindowOpenHandler: vi.fn()
  };
  let viewAccesses = 0;
  const view = Object.freeze({
    get webContents() {
      viewAccesses += 1;
      return contents;
    }
  });
  return {
    codec: new ChromeProfileImportLocalStorageCodec({
      create: vi.fn(() => view)
    }),
    contents,
    execute,
    protocol,
    session,
    viewAccesses: () => viewAccesses
  };
}

describe("ChromeProfileImportLocalStorageCodec", () => {
  it("accepts only the exact isolated-world inventory and event-bound destruction", async () => {
    const subject = fixture();
    await expect(subject.codec.readback(
      subject.session,
      "https://game.example"
    )).resolves.toEqual([{ key: "session", value: "secret" }]);
    expect(subject.execute).toHaveBeenCalledWith(
      CHROME_PROFILE_IMPORT_ISOLATED_WORLD_ID,
      [expect.objectContaining({ url: "rion://chrome-import-codec" })],
      false
    );
    expect(subject.contents.close).toHaveBeenCalledWith({ waitForBeforeUnload: false });
    expect(subject.protocol.unhandle).toHaveBeenCalledWith("https");
    expect(subject.viewAccesses()).toBe(2);
  });

  it("fails closed when controlled-document retirement cannot be proven", async () => {
    const subject = fixture(true);
    await expect(subject.codec.readback(
      subject.session,
      "https://game.example"
    )).rejects.toMatchObject({
      code: "CHROMIUM_PROFILE_IMPORT_LOCAL_STORAGE_CLEANUP_FAILED"
    });
  });

  it("returns a stable stage code when controlled-document navigation fails", async () => {
    const subject = fixture(false, true);
    await expect(subject.codec.readback(
      subject.session,
      "https://game.example"
    )).rejects.toMatchObject({
      code: "CHROMIUM_PROFILE_IMPORT_LOCAL_STORAGE_NAVIGATION_FAILED"
    });
  });

  it("does not treat isolated-world execution alone as an exact replacement receipt", async () => {
    const subject = fixture();
    await expect(subject.codec.replaceAndReadback(
      subject.session,
      "https://game.example",
      [{ key: "expected", value: "value" }]
    )).rejects.toMatchObject({
      code: "CHROMIUM_PROFILE_IMPORT_LOCAL_STORAGE_READBACK_FAILED"
    });
  });
});
