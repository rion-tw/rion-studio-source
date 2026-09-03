import { describe, expect, it, vi } from "vitest";

import {
  installChromiumCertificatePolicy,
  installChromiumSessionSecurityPolicy,
  readChromiumSessionSecurityPolicyJournal
} from "../src/electron/main/chromiumSecurityPolicy";

function fakeSession() {
  const listeners = new Map<string, (...arguments_: unknown[]) => void>();
  const handlers = new Map<string, (...arguments_: unknown[]) => unknown>();
  return {
    listeners,
    handlers,
    port: {
      storagePath: "/profiles/global-web/chromium",
      on: vi.fn((event: string, listener: (...arguments_: unknown[]) => void) => {
        listeners.set(event, listener);
      }),
      setPermissionCheckHandler: vi.fn((handler) => {
        handlers.set("permissionCheck", handler);
      }),
      setPermissionRequestHandler: vi.fn((handler) => {
        handlers.set("permissionRequest", handler);
      }),
      setDevicePermissionHandler: vi.fn((handler) => {
        handlers.set("devicePermission", handler);
      }),
      setDisplayMediaRequestHandler: vi.fn((handler) => {
        handlers.set("displayMedia", handler);
      }),
      setBluetoothPairingHandler: vi.fn((handler) => {
        handlers.set("bluetooth", handler);
      })
    }
  };
}

describe("Chromium process security policy", () => {
  it("installs one deny policy per native Session identity", () => {
    const session = fakeSession();
    installChromiumSessionSecurityPolicy(session.port as never);
    installChromiumSessionSecurityPolicy(session.port as never);

    expect(session.port.on).toHaveBeenCalledOnce();
    expect(session.port.on).toHaveBeenCalledWith(
      "will-download",
      expect.any(Function)
    );
    expect(session.port.setPermissionCheckHandler).toHaveBeenCalledOnce();
    expect(session.handlers.get("permissionCheck")!()).toBe(false);
    const permissionResult = vi.fn();
    session.handlers.get("permissionRequest")!(
      { getURL: () => "http://127.0.0.1:41739/role/security" },
      "geolocation",
      permissionResult,
      { isMainFrame: true, requestingUrl: "http://127.0.0.1:41739/role/security" }
    );
    expect(permissionResult).toHaveBeenCalledWith(false);
    expect(session.handlers.get("devicePermission")!({})).toBe(false);
    const mediaResult = vi.fn();
    session.handlers.get("displayMedia")!({}, mediaResult);
    expect(mediaResult).toHaveBeenCalledWith({});
    const bluetoothResult = vi.fn();
    session.handlers.get("bluetooth")!({}, bluetoothResult);
    expect(bluetoothResult).toHaveBeenCalledWith({ confirmed: false });
    const downloadEvent = {
      defaultPrevented: false,
      preventDefault: vi.fn(function (this: { defaultPrevented: boolean }) {
        this.defaultPrevented = true;
      })
    };
    session.listeners.get("will-download")!(
      downloadEvent as never,
      { getURL: () => "http://127.0.0.1:41739/download/security" } as never,
      { getURL: () => "http://127.0.0.1:41739/role/security" } as never
    );
    expect(downloadEvent.preventDefault).toHaveBeenCalledOnce();
    const journal = readChromiumSessionSecurityPolicyJournal(session.port as never);
    expect(journal).toEqual({
      observations: [
        {
          callback: false,
          kind: "permission-request",
          origin: "http://127.0.0.1:41739",
          permission: "geolocation",
          sequence: 1
        },
        {
          defaultPrevented: true,
          kind: "will-download",
          origin: "http://127.0.0.1:41739",
          sequence: 2,
          url: "http://127.0.0.1:41739/download/security"
        }
      ],
      policyVersion: 1,
      sessionStoragePath: "/profiles/global-web/chromium"
    });
    expect(Object.isFrozen(journal)).toBe(true);
    expect(Object.isFrozen(journal?.observations)).toBe(true);
    expect(Object.isFrozen(journal?.observations[0])).toBe(true);
    expect(readChromiumSessionSecurityPolicyJournal(fakeSession().port as never))
      .toBeNull();
  });

  it("upgrades only the global-Web policy for main-frame HTML fullscreen", () => {
    const session = fakeSession();
    installChromiumSessionSecurityPolicy(session.port as never);
    installChromiumSessionSecurityPolicy(session.port as never, {
      allowMainFrameHtmlFullscreen: true
    });

    expect(session.port.on).toHaveBeenCalledOnce();
    expect(session.port.setPermissionCheckHandler).toHaveBeenCalledTimes(2);
    expect(session.port.setPermissionRequestHandler).toHaveBeenCalledTimes(2);
    const check = session.handlers.get("permissionCheck")!;
    expect(check({}, "fullscreen", "https://fixture.test", {
      isMainFrame: true
    })).toBe(true);
    expect(check({}, "fullscreen", "https://fixture.test", {
      isMainFrame: false
    })).toBe(false);
    expect(check({}, "geolocation", "https://fixture.test", {
      isMainFrame: true
    })).toBe(false);

    const fullscreenResult = vi.fn();
    session.handlers.get("permissionRequest")!(
      { getURL: () => "https://fixture.test/role/web" },
      "fullscreen",
      fullscreenResult,
      { isMainFrame: true, requestingUrl: "https://fixture.test/role/web" }
    );
    expect(fullscreenResult).toHaveBeenCalledWith(true);
    expect(readChromiumSessionSecurityPolicyJournal(session.port as never))
      .toMatchObject({ observations: [] });
  });

  it("rejects invalid server and implicit client certificates exactly once", () => {
    const listeners = new Map<string, (...arguments_: unknown[]) => void>();
    const application = {
      on: vi.fn((event: string, listener: (...arguments_: unknown[]) => void) => {
        listeners.set(event, listener);
      })
    };
    installChromiumCertificatePolicy(application as never);
    installChromiumCertificatePolicy(application as never);
    expect(application.on).toHaveBeenCalledTimes(2);

    const serverEvent = { preventDefault: vi.fn() };
    const serverDecision = vi.fn();
    listeners.get("certificate-error")!(
      serverEvent as never,
      {} as never,
      "https://invalid.example" as never,
      "ERR_CERT_INVALID" as never,
      {} as never,
      serverDecision as never,
      true as never
    );
    expect(serverEvent.preventDefault).toHaveBeenCalledOnce();
    expect(serverDecision).toHaveBeenCalledWith(false);

    const clientEvent = { preventDefault: vi.fn() };
    const clientDecision = vi.fn();
    listeners.get("select-client-certificate")!(
      clientEvent as never,
      {} as never,
      "https://mtls.example" as never,
      [] as never,
      clientDecision as never
    );
    expect(clientEvent.preventDefault).toHaveBeenCalledOnce();
    expect(clientDecision).toHaveBeenCalledWith();
  });
});
