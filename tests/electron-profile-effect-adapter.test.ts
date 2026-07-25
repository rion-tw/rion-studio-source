import type { Session } from "electron";
import { describe, expect, it, vi } from "vitest";

import { ElectronProfileEffectAdapter } from "../src/main/browser/ElectronProfileEffectAdapter";
import type { ProfileCoreEffectAction } from "../src/main/core/ElectronEffectExecutor";
import type { RolePathsRecord } from "../src/shared/generated";
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
      sessionSource: "managed"
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

  it("previews a managed Electron to System cookie migration without exposing values", async () => {
    const embedded = createSession(undefined, [
      {
        domain: ".example.test",
        httpOnly: true,
        name: "session",
        path: "/",
        sameSite: "lax",
        secure: true,
        session: true,
        value: "secret"
      }
    ]);
    const systemStore = {
      clearCookies: vi.fn().mockResolvedValue(undefined),
      getCookies: vi.fn().mockResolvedValue([]),
      setCookies: vi.fn().mockResolvedValue(0)
    };
    const adapter = new ElectronProfileEffectAdapter({
      getEmbeddedSession: vi.fn(() => embedded),
      getImportedSession: vi.fn(() => createSession()),
      getSystemSessionStore: vi.fn(() => systemStore)
    });

    await expect(adapter.execute(action({
      type: "roleSessionMigrationInspect",
      roleId: "role-1",
      sourceEngine: "electron",
      targetEngine: "system",
      sessionSource: "managed",
      paths: rolePaths
    }))).resolves.toEqual({
      sourceCookieCount: 1,
      targetCookieCount: 0
    });

    expect(JSON.stringify(await adapter.execute(action({
      type: "roleSessionMigrationInspect",
      roleId: "role-1",
      sourceEngine: "electron",
      targetEngine: "system",
      sessionSource: "managed",
      paths: rolePaths
    })))).not.toContain("secret");
  });

  it("copies normalized cookies and verifies the target session before reporting success", async () => {
    const embedded = createSession(undefined, [
      {
        domain: ".example.test",
        expirationDate: 2_000_000_000,
        httpOnly: true,
        name: "session",
        path: "/play",
        sameSite: "no_restriction",
        secure: true,
        session: false,
        value: "secret"
      }
    ]);
    const systemStore = {
      clearCookies: vi.fn().mockResolvedValue(undefined),
      getCookies: vi.fn().mockResolvedValue([]),
      setCookies: vi.fn().mockResolvedValue(1)
    };
    const verifyEngineSession = vi.fn().mockResolvedValue(true);
    const adapter = new ElectronProfileEffectAdapter({
      getEmbeddedSession: vi.fn(() => embedded),
      getImportedSession: vi.fn(() => createSession()),
      getSystemSessionStore: vi.fn(() => systemStore),
      verifyEngineSession
    });

    await expect(adapter.execute(action({
      type: "roleSessionMigrationApply",
      roleId: "role-1",
      sourceEngine: "electron",
      targetEngine: "system",
      sessionSource: "managed",
      launchUrl: "https://example.test/play",
      paths: rolePaths
    }))).resolves.toEqual({
      authVerified: true,
      cookiesMigrated: 1
    });
    expect(systemStore.setCookies).toHaveBeenCalledWith([
      expect.objectContaining({
        domain: ".example.test",
        name: "session",
        url: "https://example.test/play",
        value: "secret"
      })
    ]);
    expect(verifyEngineSession).toHaveBeenCalledWith(
      "role-1",
      "system",
      "https://example.test/play",
      rolePaths
    );
    expect(systemStore.clearCookies).not.toHaveBeenCalled();
  });

  it("clears the target cookie store when verification fails and on explicit rollback", async () => {
    const embedded = createSession(undefined, [
      {
        domain: "example.test",
        name: "session",
        path: "/",
        sameSite: "unspecified",
        secure: true,
        session: true,
        value: "secret"
      }
    ]);
    const systemStore = {
      clearCookies: vi.fn().mockResolvedValue(undefined),
      getCookies: vi.fn().mockResolvedValue([]),
      setCookies: vi.fn().mockResolvedValue(1)
    };
    const adapter = new ElectronProfileEffectAdapter({
      getEmbeddedSession: vi.fn(() => embedded),
      getImportedSession: vi.fn(() => createSession()),
      getSystemSessionStore: vi.fn(() => systemStore),
      verifyEngineSession: vi.fn().mockResolvedValue(false)
    });

    await expect(adapter.execute(action({
      type: "roleSessionMigrationApply",
      roleId: "role-1",
      sourceEngine: "electron",
      targetEngine: "system",
      sessionSource: "managed",
      launchUrl: "https://example.test/",
      paths: rolePaths
    }))).resolves.toEqual({
      authVerified: false,
      cookiesMigrated: 1
    });
    await expect(adapter.execute(action({
      type: "roleSessionMigrationRollback",
      roleId: "role-1",
      sourceEngine: "electron",
      targetEngine: "system",
      sessionSource: "managed",
      paths: rolePaths
    }))).resolves.toEqual({ targetStoreCleared: true });
    expect(systemStore.clearCookies).toHaveBeenCalledTimes(2);
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
  setCookie: ((cookie: Parameters<Session["cookies"]["set"]>[0]) => Promise<void>) | undefined =
    async () => undefined,
  cookies: Awaited<ReturnType<Session["cookies"]["get"]>> = []
): Session & {
  clearData: ReturnType<typeof vi.fn>;
  clearStorageData: ReturnType<typeof vi.fn>;
  closeAllConnections: ReturnType<typeof vi.fn>;
} {
  return {
    clearData: vi.fn().mockResolvedValue(undefined),
    clearStorageData: vi.fn().mockResolvedValue(undefined),
    closeAllConnections: vi.fn().mockResolvedValue(undefined),
    cookies: {
      get: vi.fn().mockResolvedValue(cookies),
      set: vi.fn(setCookie)
    },
    flushStorageData: vi.fn()
  } as unknown as Session & {
    clearData: ReturnType<typeof vi.fn>;
    clearStorageData: ReturnType<typeof vi.fn>;
    closeAllConnections: ReturnType<typeof vi.fn>;
  };
}

const rolePaths: RolePathsRecord = {
  browserUserDataDir: "/roles/role-1/browser/electron",
  electronBrowserUserDataDir: "/roles/role-1/browser/electron",
  systemBrowserDataDir: "/roles/role-1/browser/system",
  webview2UserDataDir: "/roles/role-1/browser/system/webview2",
  webkitDataStoreKey: "rion.role.role-1",
  webkitDataStoreIdentifier: "018f9f4c-1234-8123-8123-123456789abc"
};
