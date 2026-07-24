import type { Session } from "electron";
import { describe, expect, it, vi } from "vitest";

import { ElectronProfileEffectAdapter } from "../src/main/browser/ElectronProfileEffectAdapter";
import type { ProfileCoreEffectAction } from "../src/main/core/ElectronEffectExecutor";
import { v1Case } from "./helpers/v1Parity";

describe("ElectronProfileEffectAdapter", () => {
  it("applies Rust-decoded cookies and skips only Electron control-character rejections", async () => {
    const imported = createSession(async (cookie) => {
      if (cookie.name === "invalid") {
        throw new Error(
          "The cookie contains ASCII control characters EXCLUDE_DISALLOWED_CHARACTER"
        );
      }
    });
    const adapter = createAdapter(imported);

    await adapter.execute(action({
      type: "chromeProfileApplySession",
      roleId: "role-1",
      browserUserDataDir: "/profile",
      cookiesJson: JSON.stringify([
        { name: "invalid", url: "https://example.test/", value: "bad" },
        { name: "session", url: "https://example.test/", value: "from-rust" }
      ])
    }));

    expect(imported.cookies.set).toHaveBeenCalledTimes(2);
    expect(imported.cookies.set).toHaveBeenLastCalledWith(
      expect.objectContaining({ value: "from-rust" })
    );
    expect(imported.flushStorageData).toHaveBeenCalledOnce();
  });

  it("clears every Electron storage target and reports a stable effect error", async () => {
    const embedded = createSession();
    embedded.clearData.mockRejectedValueOnce(new Error("partition locked"));
    const adapter = new ElectronProfileEffectAdapter({
      getEmbeddedSession: vi.fn(() => embedded),
      getImportedSession: vi.fn(() => createSession())
    });

    await expect(adapter.execute(action({
      type: "roleBrowserDataClearSession",
      roleId: "role-1",
      browserUserDataDir: "/profile",
      sessionSource: "embedded"
    }))).rejects.toMatchObject({ code: "ROLE_BROWSER_DATA_CLEAR_FAILED" });

    v1Case("portable-profile-c5d0f3016c42", () => {
      expect(embedded.closeAllConnections).toHaveBeenCalledOnce();
      expect(embedded.clearData).toHaveBeenCalledWith({
        dataTypes: [
          "cache",
          "cookies",
          "fileSystems",
          "indexedDB",
          "localStorage",
          "serviceWorkers",
          "webSQL"
        ]
      });
      expect(embedded.clearStorageData).toHaveBeenCalledWith({ storages: ["cachestorage"] });
    });
  });

  it("uses path sessions for imported profile apply, compensation, and clear", async () => {
    const imported = createSession();
    const getImportedSession = vi.fn(() => imported);
    const adapter = new ElectronProfileEffectAdapter({
      getEmbeddedSession: vi.fn(() => createSession()),
      getImportedSession
    });

    await adapter.execute(action({
      type: "chromeProfileClearSession",
      roleId: "role-1",
      browserUserDataDir: "/profile"
    }));
    await adapter.execute(action({
      type: "roleBrowserDataClearSession",
      roleId: "role-1",
      browserUserDataDir: "/profile",
      sessionSource: "chrome-profile"
    }));

    expect(getImportedSession).toHaveBeenCalledTimes(2);
    expect(getImportedSession).toHaveBeenCalledWith("/profile");
  });
});

function action<T extends ProfileCoreEffectAction>(value: T): T {
  return value;
}

function createAdapter(imported: Session): ElectronProfileEffectAdapter {
  return new ElectronProfileEffectAdapter({
    getEmbeddedSession: vi.fn(() => createSession()),
    getImportedSession: vi.fn(() => imported)
  });
}

function createSession(
  setCookie: (cookie: Parameters<Session["cookies"]["set"]>[0]) => Promise<void> =
    async () => undefined
): Session & {
  clearData: ReturnType<typeof vi.fn>;
  clearStorageData: ReturnType<typeof vi.fn>;
  closeAllConnections: ReturnType<typeof vi.fn>;
} {
  return {
    clearData: vi.fn().mockResolvedValue(undefined),
    clearStorageData: vi.fn().mockResolvedValue(undefined),
    closeAllConnections: vi.fn().mockResolvedValue(undefined),
    cookies: { set: vi.fn(setCookie) },
    flushStorageData: vi.fn()
  } as unknown as Session & {
    clearData: ReturnType<typeof vi.fn>;
    clearStorageData: ReturnType<typeof vi.fn>;
    closeAllConnections: ReturnType<typeof vi.fn>;
  };
}
