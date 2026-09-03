import { describe, expect, it, vi } from "vitest";

import { runChromeProfileImportHelperProcess } from
  "../src/electron/main/chromeProfileImportHelperProcess";
import { encodeChromeProfileImportHelperRequestForTest } from
  "../src/electron/main/chromeProfileImportHelperProtocol";
import {
  chromiumRoleBrowserDataPathSha256,
  encodeChromiumRoleBrowserDataClearFreshHelperRequest
} from
  "../src/electron/main/chromiumRoleBrowserDataClearFreshHelperContract";
import type { ChromiumRoleSessionPort } from
  "../src/electron/main/chromiumRoleSessionRegistry";

describe("fresh Chrome profile import helper process", () => {
  it("reads one inherited frame and emits one canonical indeterminate terminal frame", async () => {
    const request = encodeChromeProfileImportHelperRequestForTest(
      Buffer.from("{}", "utf8"),
      Buffer.alloc(0)
    );
    let response = Buffer.alloc(0);
    const exit = vi.fn();
    const ready = vi.fn(async () => undefined);
    await runChromeProfileImportHelperProcess({
      platform: "darwin",
      sessions: {
        fromPath: vi.fn(() => {
          throw new Error("No Session may open for invalid metadata.");
        })
      },
      views: {
        create: vi.fn(() => {
          throw new Error("No helper view may open for invalid metadata.");
        })
      },
      readInheritedRequest: () => request,
      ready,
      writeInheritedResponse: async (bytes) => {
        response = Buffer.from(bytes);
      },
      exit
    });

    expect(ready).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
    expect(response.subarray(0, 8).toString("ascii")).toBe("RCHRES01");
    expect(response[8]).toBe(2);
    expect(response.readUInt32BE(16)).toBe(0);
    const metadataLength = response.readUInt32BE(12);
    expect(JSON.parse(response.subarray(20, 20 + metadataLength).toString("utf8")))
      .toEqual({
        version: 1,
        stableErrorCode: "CHROMIUM_PROFILE_IMPORT_HELPER_METADATA_INVALID"
      });
    expect([...request]).toEqual(new Array(request.byteLength).fill(0));
    response.fill(0);
  });

  it("dispatches a role clear to one fresh exact-path Session and drains it", async () => {
    const roleId = "11111111-1111-4111-8111-111111111111";
    const browser = `/RionData/roles/${roleId}/browser`;
    const chromiumPath = `${browser}/chromium`;
    const metadata = encodeChromiumRoleBrowserDataClearFreshHelperRequest({
      version: 1,
      family: "roleBrowserDataClear",
      kind: "clearAndVerify",
      evidenceRevision: 1,
      platform: "darwin",
      effectId: "effect-clear-role-data",
      operationId: "operation-clear-role-data",
      roleId,
      rolePaths: {
        browserUserDataDir: browser,
        systemBrowserDataDir: `${browser}/system-webview`,
        webview2UserDataDir: `${browser}/system-webview/webview2`,
        chromiumUserDataDir: chromiumPath,
        webkitDataStoreKey: `role:${roleId}:wkwebview`,
        webkitDataStoreIdentifier: roleId
      },
      chromiumPathSha256: chromiumRoleBrowserDataPathSha256(chromiumPath)
    });
    const request = encodeChromeProfileImportHelperRequestForTest(
      metadata,
      Buffer.alloc(0)
    );
    metadata.fill(0);
    const order: string[] = [];
    const clearStorageData = vi.fn(async () => { order.push("clear"); });
    const session = {
      storagePath: chromiumPath,
      on: vi.fn(),
      clearStorageData,
      flushStorageData: vi.fn(() => { order.push("drain"); }),
      cookies: {
        flushStore: vi.fn(async () => { order.push("flush"); }),
        get: vi.fn(async () => {
          order.push("readback");
          return [];
        })
      },
      protocol: { handle: vi.fn(), unhandle: vi.fn() },
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
      setDevicePermissionHandler: vi.fn(),
      setDisplayMediaRequestHandler: vi.fn(),
      setBluetoothPairingHandler: vi.fn()
    } as unknown as ChromiumRoleSessionPort;
    const fromPath = vi.fn(() => session);
    let response = Buffer.alloc(0);
    const ready = vi.fn(async () => undefined);
    const exit = vi.fn();

    await runChromeProfileImportHelperProcess({
      platform: "darwin",
      sessions: { fromPath },
      views: {
        create: vi.fn(() => {
          throw new Error("A role clear helper must not create a WebContentsView.");
        })
      },
      readInheritedRequest: () => request,
      ready,
      writeInheritedResponse: async (bytes) => {
        response = Buffer.from(bytes);
      },
      exit
    });

    expect(ready).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
    expect(fromPath).toHaveBeenCalledWith(chromiumPath, { cache: true });
    expect(clearStorageData.mock.calls).toEqual([[]]);
    expect(order).toEqual(["clear", "flush", "readback", "drain", "flush"]);
    expect(response[8]).toBe(0);
    const metadataLength = response.readUInt32BE(12);
    expect(JSON.parse(response.subarray(20, 20 + metadataLength).toString("utf8")))
      .toMatchObject({
        family: "roleBrowserDataClear",
        cookieReadbackCount: 0,
        storageClearAcknowledgement: "electron-clear-storage-data-promise"
      });
    expect([...request]).toEqual(new Array(request.byteLength).fill(0));
    response.fill(0);
  });
});
