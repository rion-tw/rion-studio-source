import { describe, expect, it, vi } from "vitest";
import { installChromiumSessionSecurityPolicy, readChromiumSessionSecurityPolicyJournal }
  from "../src/electron/main/chromiumSecurityPolicy";

function fixture(platform: "darwin" | "win32", drm = true) {
  let check: (...args: unknown[]) => boolean;
  let request: (...args: unknown[]) => void;
  const session = {
    storagePath: platform === "darwin" ? "/web-profiles/global-web/chromium"
      : "C:\\web-profiles\\global-web\\chromium",
    on: vi.fn(),
    setPermissionCheckHandler: vi.fn((handler) => { check = handler; }),
    setPermissionRequestHandler: vi.fn((handler) => { request = handler; }),
    setDevicePermissionHandler: vi.fn(), setDisplayMediaRequestHandler: vi.fn(),
    setBluetoothPairingHandler: vi.fn()
  };
  installChromiumSessionSecurityPolicy(session as never, { allowWebAppDrm: drm });
  return { session, check: (...args: unknown[]) => check(...args),
    request: (...args: unknown[]) => request(...args) };
}

describe.each(["darwin", "win32"] as const)("Web App DRM on %s", (platform) => {
  it.each([
    ["HTTPS main frame", "https://iq.com/", "https://iq.com/watch?token=secret", true],
    ["HTTPS embedded player", "https://iq.com/", "https://player.example/video", true],
    ["HTTP requester", "https://iq.com/", "http://player.example/video", false],
    ["HTTP embedding page", "http://iq.com/", "https://player.example/video", false],
    ["file", "https://iq.com/", "file:///video", false],
    ["opaque origin", "https://iq.com/", "null", false],
    ["missing requester", "https://iq.com/", undefined, false],
    ["credentials", "https://iq.com/", "https://name:secret@iq.com/", false]
  ])("uses the same decision for check/request: %s", (_name, embedding, requesting, allowed) => {
    const { session, check, request } = fixture(platform);
    const contents = { getURL: () => embedding };
    const details = { requestingUrl: requesting, isMainFrame: requesting === embedding };
    expect(check(contents, "mediaKeySystem", requesting, details)).toBe(allowed);
    const callback = vi.fn();
    request(contents, "mediaKeySystem", callback, details);
    expect(callback).toHaveBeenCalledExactlyOnceWith(allowed);
    const journal = readChromiumSessionSecurityPolicyJournal(session as never)!;
    expect(journal.policyVersion).toBe(2);
    expect(journal.observations).toHaveLength(2);
    expect(journal.observations.map((entry) => entry.kind)).toEqual([
      "drm-permission", "drm-permission"
    ]);
    expect(JSON.stringify(journal)).not.toContain("secret");
    expect(Object.isFrozen(journal.observations[0])).toBe(true);
  });

  it("requires complete native origins for null WebContents", () => {
    const { check, request } = fixture(platform);
    expect(check(null, "mediaKeySystem", "https://player.example", {
      isMainFrame: false, embeddingOrigin: "https://iq.com"
    })).toBe(true);
    expect(check(null, "mediaKeySystem", "https://player.example", {})).toBe(false);
    expect(check(null, "mediaKeySystem", "https://player.example", {
      embeddingOrigin: "null"
    })).toBe(false);
    const callback = vi.fn();
    request(null, "mediaKeySystem", callback, {
      requestingUrl: "https://player.example", isMainFrame: false
    });
    expect(callback).toHaveBeenCalledExactlyOnceWith(false);
    const completeCallback = vi.fn();
    request(null, "mediaKeySystem", completeCallback, {
      requestingUrl: "https://player.example", embeddingOrigin: "https://iq.com",
      isMainFrame: false
    });
    expect(completeCallback).toHaveBeenCalledExactlyOnceWith(true);
    // Explicit native metadata cannot be replaced by a more permissive owner URL.
    expect(check({ getURL: () => "https://iq.com" }, "mediaKeySystem",
      "https://player.example", { embeddingOrigin: "http://iq.com" })).toBe(false);
  });

  it("keeps other sessions and permissions denied and rechecks navigation", () => {
    const web = fixture(platform);
    const role = fixture(platform, false);
    let url = "https://iq.com/";
    const contents = { getURL: () => url };
    const details = { requestingUrl: url, isMainFrame: true };
    expect(role.check(contents, "mediaKeySystem", url, details)).toBe(false);
    for (const permission of ["geolocation", "media", "display-capture", "notifications"]) {
      expect(web.check(contents, permission, url, details)).toBe(false);
    }
    expect(web.check(contents, "mediaKeySystem", url, details)).toBe(true);
    url = "http://iq.com/";
    expect(web.check(contents, "mediaKeySystem", url, { ...details, requestingUrl: url })).toBe(false);
    const navigatedCallback = vi.fn();
    web.request(contents, "mediaKeySystem", navigatedCallback, details);
    expect(navigatedCallback).toHaveBeenCalledExactlyOnceWith(false);
    expect(web.check({ ...contents, isDestroyed: () => true }, "mediaKeySystem",
      "https://iq.com", details)).toBe(false);
  });

  it("merges explicit policy upgrades once and bounds the detached journal", () => {
    const { session, check } = fixture(platform, false);
    installChromiumSessionSecurityPolicy(session as never, { allowWebAppDrm: true });
    installChromiumSessionSecurityPolicy(session as never, { allowWebAppDrm: true });
    installChromiumSessionSecurityPolicy(session as never);
    expect(session.on).toHaveBeenCalledOnce();
    expect(session.setPermissionCheckHandler).toHaveBeenCalledTimes(2);
    const contents = { getURL: () => "https://iq.com/" };
    for (let index = 0; index < 300; index++) {
      expect(check(contents, "mediaKeySystem", "https://iq.com", { isMainFrame: true })).toBe(true);
    }
    const journal = readChromiumSessionSecurityPolicyJournal(session as never)!;
    expect(journal.observations).toHaveLength(256);
    expect(journal.observations[0]?.sequence).toBe(45);
    expect(journal.observations.at(-1)?.sequence).toBe(300);
  });
});
