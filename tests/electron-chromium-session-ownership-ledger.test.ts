import { describe, expect, it } from "vitest";

import {
  ChromiumSessionOwnershipLedger
} from "../src/electron/main/chromiumSessionOwnershipLedger";
import {
  ChromiumRoleSessionRegistry,
  type ChromiumRoleSessionPort
} from "../src/electron/main/chromiumRoleSessionRegistry";
import {
  ChromiumGlobalWebSessionRegistry
} from "../src/electron/main/chromiumGlobalWebSessionRegistry";

describe("Chromium process session ownership ledger", () => {
  it.each([
    ["darwin" as const, "/RionData/roles/role-1/browser/chromium"],
    ["win32" as const, "C:\\RionData\\roles\\role-1\\browser\\chromium"]
  ])("holds an exact active %s owner until release", (platform, path) => {
    const ledger = new ChromiumSessionOwnershipLedger(platform);
    const session = {};
    const lease = ledger.claim("role:role-1", path, session);

    expect(ledger.claim("role:role-1", path, session)).toBe(lease);
    expect(ledger.activeCount).toBe(1);
    expect(() => ledger.claim("role:role-2", path, {})).toThrowError(
      expect.objectContaining({
        code: "ELECTRON_CHROMIUM_SESSION_PATH_OWNER_CONFLICT"
      })
    );
    expect(() => ledger.claim(
      "role:role-2",
      platform === "win32"
        ? "C:\\RionData\\roles\\role-2\\browser\\chromium"
        : "/RionData/roles/role-2/browser/chromium",
      session
    )).toThrowError(expect.objectContaining({
      code: "ELECTRON_CHROMIUM_SESSION_NATIVE_ALIAS"
    }));
    expect(ledger.release(lease)).toBe(true);
    expect(ledger.release(lease)).toBe(false);
    expect(ledger.activeCount).toBe(0);
  });

  it("keeps path/security-domain and native/path bindings after active release", () => {
    const ledger = new ChromiumSessionOwnershipLedger("darwin");
    const firstSession = {};
    const firstPath = "/RionData/roles/role-1/browser/chromium";
    const lease = ledger.claim("role:role-1", firstPath, firstSession);
    ledger.release(lease);

    expect(() => ledger.claim("global-web", firstPath, {})).toThrowError(
      expect.objectContaining({
        code: "ELECTRON_CHROMIUM_SESSION_PATH_OWNER_CONFLICT"
      })
    );
    expect(() => ledger.claim(
      "role:role-1",
      "/RionData/roles/role-2/browser/chromium",
      firstSession
    )).toThrowError(expect.objectContaining({
      code: "ELECTRON_CHROMIUM_SESSION_NATIVE_ALIAS"
    }));
    const replacement = ledger.claim("role:role-1", firstPath, {});
    expect(replacement.session).not.toBe(firstSession);
  });

  it("treats Windows casing aliases as the same permanent binding", () => {
    const ledger = new ChromiumSessionOwnershipLedger("win32");
    const session = {};
    const lease = ledger.claim(
      "global-web",
      "C:\\RionData\\web-profiles\\global-web\\chromium",
      session
    );
    expect(ledger.claim(
      "global-web",
      "c:\\riondata\\web-profiles\\global-web\\chromium",
      session
    )).toBe(lease);
  });

  it("rejects forged release leases and non-canonical identities", () => {
    const ledger = new ChromiumSessionOwnershipLedger("darwin");
    const session = {};
    const lease = ledger.claim(
      "global-web",
      "/RionData/web-profiles/global-web/chromium",
      session
    );

    expect(() => ledger.release({ ...lease })).toThrowError(
      expect.objectContaining({
        code: "ELECTRON_CHROMIUM_SESSION_OWNERSHIP_LEASE_STALE"
      })
    );
    expect(() => ledger.claim("", lease.path, {})).toThrowError(
      expect.objectContaining({
        code: "ELECTRON_CHROMIUM_SESSION_OWNER_INVALID"
      })
    );
    expect(() => ledger.claim("role:role-2", "relative/chromium", {}))
      .toThrowError(expect.objectContaining({
        code: "ELECTRON_CHROMIUM_SESSION_OWNERSHIP_PATH_INVALID"
      }));
    expect(ledger.activeCount).toBe(1);
  });

  it("fences a native Session alias across the role and global-Web registries", () => {
    const ledger = new ChromiumSessionOwnershipLedger("darwin");
    let nativePath = "/RionData/roles/role-1/browser/chromium";
    const session = {
      on: () => undefined,
      get storagePath() {
        return nativePath;
      },
      cookies: { flushStore: async () => undefined },
      clearStorageData: async () => undefined,
      flushStorageData: () => undefined,
      protocol: {},
      setPermissionCheckHandler: () => undefined,
      setPermissionRequestHandler: () => undefined,
      setDevicePermissionHandler: () => undefined,
      setDisplayMediaRequestHandler: () => undefined,
      setBluetoothPairingHandler: () => undefined
    } as unknown as ChromiumRoleSessionPort;
    const factory = {
      fromPath: (path: string) => {
        nativePath = path;
        return session;
      }
    };
    const roles = new ChromiumRoleSessionRegistry(factory, "darwin", ledger);
    roles.ensure("role-1", {
      browserUserDataDir: "/RionData/roles/role-1/browser",
      systemBrowserDataDir: "/RionData/roles/role-1/browser/system",
      webview2UserDataDir: "/RionData/roles/role-1/browser/webview2",
      chromiumUserDataDir: "/RionData/roles/role-1/browser/chromium",
      webkitDataStoreKey: "role:role-1:wkwebview",
      webkitDataStoreIdentifier: "role-1"
    });
    const globalWeb = new ChromiumGlobalWebSessionRegistry(
      factory,
      "darwin",
      ledger
    );

    expect(() => globalWeb.acquireSurface("web-tab-1-1", 1, {
      profileKey: "global-web",
      chromiumUserDataDir: "/RionData/web-profiles/global-web/chromium"
    })).toThrowError(expect.objectContaining({
      code: "ELECTRON_CHROMIUM_SESSION_NATIVE_ALIAS"
    }));
    expect(ledger.activeCount).toBe(1);
  });
});
