import { posix, win32 } from "node:path";

import type { Cookie, ClearStorageDataOptions } from "electron";
import { describe, expect, it, vi } from "vitest";

import { ChromiumRoleBrowserDataClearFreshHelper } from
  "../src/electron/main/chromiumRoleBrowserDataClearFreshHelper";
import {
  chromiumRoleBrowserDataPathSha256,
  encodeChromiumRoleBrowserDataClearFreshHelperRequest,
  parseChromiumRoleBrowserDataClearFreshHelperRequest,
  type ChromiumRoleBrowserDataClearFreshHelperRequest
} from
  "../src/electron/main/chromiumRoleBrowserDataClearFreshHelperContract";
import type {
  ChromiumRoleSessionPort,
  ChromiumSessionFactoryPort
} from "../src/electron/main/chromiumRoleSessionRegistry";

const ROLE_ID = "11111111-1111-4111-8111-111111111111";

function request(
  platform: "darwin" | "win32" = "darwin"
): ChromiumRoleBrowserDataClearFreshHelperRequest {
  const paths = platform === "win32" ? win32 : posix;
  const root = platform === "win32" ? "C:\\RionData" : "/RionData";
  const browser = paths.join(root, "roles", ROLE_ID, "browser");
  const rolePaths = {
    browserUserDataDir: browser,
    systemBrowserDataDir: paths.join(browser, "system-webview"),
    webview2UserDataDir: paths.join(browser, "system-webview", "webview2"),
    chromiumUserDataDir: paths.join(browser, "chromium"),
    webkitDataStoreKey: `role:${ROLE_ID}:wkwebview`,
    webkitDataStoreIdentifier: ROLE_ID
  };
  return {
    version: 1,
    family: "roleBrowserDataClear",
    kind: "clearAndVerify",
    evidenceRevision: 1,
    platform,
    effectId: "effect-clear-role-browser-data",
    operationId: "operation-clear-role-browser-data",
    roleId: ROLE_ID,
    rolePaths,
    chromiumPathSha256: chromiumRoleBrowserDataPathSha256(
      rolePaths.chromiumUserDataDir
    )
  };
}

interface PersistentStore {
  cookies: Cookie[];
  localStorage: Map<string, Map<string, string>>;
}

function nativeStore(
  persistent: PersistentStore,
  options: Readonly<{ clear?: () => unknown }> = {}
): Readonly<{
  clearStorageData: ReturnType<typeof vi.fn>;
  factory: ChromiumSessionFactoryPort;
  fromPath: ReturnType<typeof vi.fn>;
  order: string[];
}> {
  const order: string[] = [];
  const clearStorageData = vi.fn((_input?: ClearStorageDataOptions) => {
    order.push("clear-all-stores");
    if (options.clear) return options.clear();
    persistent.cookies = [];
    persistent.localStorage.clear();
    return Promise.resolve();
  });
  const fromPath = vi.fn((path: string) => ({
    storagePath: path,
    on: vi.fn(),
    clearStorageData,
    flushStorageData: vi.fn(() => order.push("session-drain")),
    cookies: {
      flushStore: vi.fn(async () => { order.push("cookie-flush"); }),
      get: vi.fn(async () => {
        order.push("cookie-readback");
        return persistent.cookies.map((cookie) => ({ ...cookie }));
      })
    },
    protocol: { handle: vi.fn(), unhandle: vi.fn() },
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    setDevicePermissionHandler: vi.fn(),
    setDisplayMediaRequestHandler: vi.fn(),
    setBluetoothPairingHandler: vi.fn()
  }) as unknown as ChromiumRoleSessionPort);
  return {
    clearStorageData,
    factory: { fromPath },
    fromPath,
    order
  };
}

describe("fresh-process Chromium role browser-data clear helper", () => {
  it.each(["darwin" as const, "win32" as const])(
    "round-trips a closed %s descriptor bound to the exact role path",
    (platform) => {
      const input = request(platform);
      expect(parseChromiumRoleBrowserDataClearFreshHelperRequest(
        encodeChromiumRoleBrowserDataClearFreshHelperRequest(input)
      )).toEqual(input);

      const extended = { ...input, callerPath: input.rolePaths.chromiumUserDataDir };
      expect(() => parseChromiumRoleBrowserDataClearFreshHelperRequest(
        Buffer.from(JSON.stringify(extended), "utf8")
      )).toThrowError(expect.objectContaining({
        code: "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_FRESH_HELPER_METADATA_INVALID"
      }));
      expect(() => parseChromiumRoleBrowserDataClearFreshHelperRequest(
        Buffer.from(JSON.stringify({
          ...input,
          chromiumPathSha256: "f".repeat(64)
        }), "utf8")
      )).toThrowError(expect.objectContaining({
        code: "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_FRESH_HELPER_METADATA_INVALID"
      }));
    }
  );

  it("clears the whole freshly reopened store and drains its exact Session", async () => {
    const input = request();
    const persistent: PersistentStore = {
      cookies: [{
        name: "sid",
        value: "secret",
        domain: "game.example",
        path: "/",
        secure: true,
        httpOnly: true,
        session: true,
        hostOnly: true,
        sameSite: "lax"
      }],
      localStorage: new Map([
        ["https://game.example", new Map([["token", "secret"]])],
        ["https://redirect.example", new Map([["state", "secret"]])]
      ])
    };
    const native = nativeStore(persistent);
    const secret = Buffer.alloc(0);
    const result = await new ChromiumRoleBrowserDataClearFreshHelper({
      platform: "darwin",
      sessions: native.factory
    }).run(input, secret);

    expect(result.outcome).toBe("applied");
    expect(persistent.cookies).toEqual([]);
    expect(persistent.localStorage.size).toBe(0);
    expect(native.fromPath).toHaveBeenCalledWith(
      input.rolePaths.chromiumUserDataDir,
      { cache: true }
    );
    expect(native.clearStorageData.mock.calls).toEqual([[]]);
    expect(native.order).toEqual([
      "clear-all-stores",
      "cookie-flush",
      "cookie-readback",
      "session-drain",
      "cookie-flush"
    ]);
    expect(JSON.parse(result.metadataBytes.toString("utf8"))).toMatchObject({
      family: "roleBrowserDataClear",
      effectId: input.effectId,
      operationId: input.operationId,
      roleId: ROLE_ID,
      chromiumPathSha256: input.chromiumPathSha256,
      cookieReadbackCount: 0,
      storageClearAcknowledgement: "electron-clear-storage-data-promise",
      processInstanceId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      sessionDrainEvidenceSha256: expect.stringMatching(/^[0-9a-f]{64}$/u)
    });
  });

  it("never turns an unknown all-store clear acknowledgement into success", async () => {
    const input = request();
    const persistent: PersistentStore = {
      cookies: [],
      localStorage: new Map()
    };
    const native = nativeStore(persistent, {
      clear: () => Promise.reject(new Error("native acknowledgement lost"))
    });
    const result = await new ChromiumRoleBrowserDataClearFreshHelper({
      platform: "darwin",
      sessions: native.factory
    }).run(input, Buffer.alloc(0));

    expect(result.outcome).toBe("indeterminate");
    expect(JSON.parse(result.metadataBytes.toString("utf8"))).toMatchObject({
      stableErrorCode:
        "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_FRESH_HELPER_CLEAR_ACK_INDETERMINATE"
    });
    expect(native.order).toEqual([
      "clear-all-stores",
      "session-drain",
      "cookie-flush"
    ]);
  });
});
