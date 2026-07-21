import { EventEmitter } from "node:events";
import { access, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import {
  buildImportedChromeProfileLoginArgs,
  ImportedChromeProfileLoginCancelledError,
  ImportedChromeProfileLoginRetryableError,
  ImportedChromeProfileLoginVerifier
} from "../src/main/browser/ImportedChromeProfileLoginVerifier";
import {
  getImportedChromeProfileMarkerPath,
  markImportedChromeProfilePending
} from "../src/main/browser/ImportedChromeProfileMarker";
import type { Role } from "../src/shared/types";

const role: Role = {
  id: "role-1",
  gameId: "game-1",
  name: "Imported",
  launchUrl: "https://example.test/play",
  notes: "Imported from a local Chrome profile.",
  authState: "login_required",
  createdAt: "2026-07-21T00:00:00.000Z",
  updatedAt: "2026-07-21T00:00:00.000Z"
};

describe("ImportedChromeProfileLoginVerifier", () => {
  it("opens a visible Chrome profile, synchronizes only cookies, and retains the marker until embedded verification", async () => {
    const root = await mkdtemp(join(tmpdir(), "rion-imported-login-"));
    const browserUserDataDir = join(root, "profiles", role.id, "browser");
    await mkdir(browserUserDataDir, { recursive: true });
    await markImportedChromeProfilePending(browserUserDataDir);
    const child = createChild();
    const resetEmbeddedSession = vi.fn().mockResolvedValue(undefined);
    const cookieSet = vi.fn().mockResolvedValue(undefined);
    const flushStorageData = vi.fn().mockResolvedValue(undefined);
    const cdpSend = vi.fn(async (method: string) => {
      if (method === "Network.getCookies") {
        return {
          cookies: [{
            domain: ".example.test",
            name: "session",
            value: "verified",
            path: "/",
            secure: true,
            httpOnly: true,
            expires: 2_000_000_000
          }]
        };
      }
      if (method === "Browser.close") {
        queueMicrotask(() => child.emit("close"));
      }
      return {};
    });
    const verifier = new ImportedChromeProfileLoginVerifier({
      createCdpClient: () => ({ close: vi.fn(), send: cdpSend as never }),
      findExecutable: () => "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      getSession: () => ({ cookies: { set: cookieSet }, flushStorageData }) as never,
      listDevToolsTargets: async () => [{
        id: "page-1",
        type: "page",
        url: role.launchUrl,
        webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/page-1"
      }],
      resetEmbeddedSession,
      roleStore: { getRolePaths: () => ({ browserUserDataDir }) },
      spawnChrome: vi.fn(() => {
        queueMicrotask(() => child.emit("spawn"));
        return child;
      }),
      waitForDevToolsPort: async () => ({ port: 9222, state: "available" }),
      waitForSettledAuthSession: async () => ({
        authState: "authenticated",
        durationMs: 0,
        stableSampleCount: 2
      })
    });

    expect(await verifier.hasPendingVerification(role.id)).toBe(true);
    await verifier.verify(role);

    expect(buildImportedChromeProfileLoginArgs(role, browserUserDataDir)).toEqual([
      `--user-data-dir=${browserUserDataDir}`,
      "--profile-directory=Default",
      "--new-window",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      role.launchUrl
    ]);
    expect(cdpSend).toHaveBeenCalledWith("Network.getCookies", { urls: [role.launchUrl] });
    expect(cdpSend).toHaveBeenCalledWith("Browser.close");
    expect(resetEmbeddedSession).toHaveBeenCalledWith("persist:rion-role-role-1");
    expect(cookieSet).toHaveBeenCalledWith(expect.objectContaining({
      domain: ".example.test",
      name: "session",
      expirationDate: 2_000_000_000,
      url: "https://example.test/"
    }));
    expect(flushStorageData).toHaveBeenCalledOnce();
    await expect(access(getImportedChromeProfileMarkerPath(browserUserDataDir))).resolves.toBeUndefined();

    await verifier.complete(role.id);
    expect(await verifier.hasPendingVerification(role.id)).toBe(false);
  });

  it("keeps the pending marker when the external Chrome window is closed", async () => {
    const root = await mkdtemp(join(tmpdir(), "rion-imported-login-"));
    const browserUserDataDir = join(root, "profiles", role.id, "browser");
    await mkdir(browserUserDataDir, { recursive: true });
    await markImportedChromeProfilePending(browserUserDataDir);
    const child = createChild();
    const verifier = new ImportedChromeProfileLoginVerifier({
      findExecutable: () => "chrome",
      getSession: () => ({}) as never,
      resetEmbeddedSession: vi.fn(),
      roleStore: { getRolePaths: () => ({ browserUserDataDir }) },
      spawnChrome: () => {
        queueMicrotask(() => child.emit("spawn"));
        return child;
      },
      waitForDevToolsPort: async () => {
        child.emit("close");
        return { state: "closed" };
      }
    });

    await expect(verifier.verify(role)).rejects.toBeInstanceOf(ImportedChromeProfileLoginCancelledError);
    expect(await verifier.hasPendingVerification(role.id)).toBe(true);
  });

  it("closes an unverifiable Chrome window and keeps the profile available for retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "rion-imported-login-"));
    const browserUserDataDir = join(root, "profiles", role.id, "browser");
    await mkdir(browserUserDataDir, { recursive: true });
    await markImportedChromeProfilePending(browserUserDataDir);
    const child = createChild();
    (child.kill as ReturnType<typeof vi.fn>).mockImplementation(() => {
      queueMicrotask(() => child.emit("close"));
      return true;
    });
    const verifier = new ImportedChromeProfileLoginVerifier({
      findExecutable: () => "chrome",
      getSession: () => ({}) as never,
      resetEmbeddedSession: vi.fn(),
      roleStore: { getRolePaths: () => ({ browserUserDataDir }) },
      spawnChrome: () => {
        queueMicrotask(() => child.emit("spawn"));
        return child;
      },
      waitForDevToolsPort: async () => ({ state: "unavailable", message: "DevTools unavailable" })
    });

    await expect(verifier.verify(role)).rejects.toBeInstanceOf(ImportedChromeProfileLoginRetryableError);
    expect(child.kill).toHaveBeenCalledOnce();
    expect(await verifier.hasPendingVerification(role.id)).toBe(true);
  });

  it("treats a missing Chrome executable as retryable without changing the pending profile", async () => {
    const root = await mkdtemp(join(tmpdir(), "rion-imported-login-"));
    const browserUserDataDir = join(root, "profiles", role.id, "browser");
    await mkdir(browserUserDataDir, { recursive: true });
    await markImportedChromeProfilePending(browserUserDataDir);
    const verifier = new ImportedChromeProfileLoginVerifier({
      findExecutable: () => { throw new Error("Google Chrome was not found"); },
      getSession: () => ({}) as never,
      resetEmbeddedSession: vi.fn(),
      roleStore: { getRolePaths: () => ({ browserUserDataDir }) }
    });

    await expect(verifier.verify(role)).rejects.toMatchObject({
      name: "ImportedChromeProfileLoginRetryableError",
      message: "Google Chrome was not found"
    });
    expect(await verifier.hasPendingVerification(role.id)).toBe(true);
  });
});

function createChild(): ChildProcess {
  return Object.assign(new EventEmitter(), {
    exitCode: null,
    kill: vi.fn(),
    signalCode: null
  }) as unknown as ChildProcess;
}
