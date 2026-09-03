import { describe, expect, it } from "vitest";

import { normalizeRionBridgeError } from "../src/electron/ipc/errors";
import {
  buildMainRendererContentSecurityPolicy,
  buildMainRendererWebPreferences,
  buildRemoteContentWebPreferences,
  buildUnprivilegedRemoteContentWebPreferences,
  installMainRendererContentSecurityPolicy
} from "../src/electron/main/security";

describe("Electron security baseline", () => {
  it.each([
    ["main renderer", buildMainRendererWebPreferences],
    ["remote content", buildRemoteContentWebPreferences]
  ])("locks down %s WebPreferences", (_name, build) => {
    const preferences = build({ preloadPath: "/absolute/preload.cjs" });

    expect(preferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      navigateOnDragDrop: false,
      safeDialogs: true,
      devTools: false
    });
    expect(Object.isFrozen(preferences)).toBe(true);
  });

  it("requires a preload and permits only an explicit development-tools opt-in", () => {
    expect(() => buildMainRendererWebPreferences({ preloadPath: "" }))
      .toThrow("absolute preload path");
    expect(buildMainRendererWebPreferences({
      preloadPath: "/absolute/preload.cjs",
      devTools: true
    }).devTools).toBe(true);
  });

  it("gives unprivileged workspace Web content no preload at all", () => {
    const preferences = buildUnprivilegedRemoteContentWebPreferences();

    expect(preferences).not.toHaveProperty("preload");
    expect(preferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      disableHtmlFullscreenWindowResize: true,
      devTools: false
    });
    expect(Object.isFrozen(preferences)).toBe(true);
  });

  it("builds a production CSP without remote scripts or development sockets", () => {
    const policy = buildMainRendererContentSecurityPolicy();

    expect(policy).toContain("script-src 'self'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com");
    expect(policy).toContain("font-src 'self' data: https://fonts.gstatic.com");
    expect(policy).not.toContain("unsafe-eval");
    expect(policy).not.toContain("ws:");
  });

  it("allows HMR only for an explicit loopback renderer origin", () => {
    const policy = buildMainRendererContentSecurityPolicy("http://127.0.0.1:5173/app");

    expect(policy).toContain("http://127.0.0.1:5173");
    expect(policy).toContain("ws://127.0.0.1:5173");
    expect(() => buildMainRendererContentSecurityPolicy("https://example.com"))
      .toThrow("loopback host");
    expect(() => buildMainRendererContentSecurityPolicy("file:///tmp/renderer.html"))
      .toThrow("loopback host");
    expect(() => buildMainRendererContentSecurityPolicy("not a URL"))
      .toThrow("valid loopback URL");
  });

  it("installs one preserving response-header hook per renderer session", () => {
    let listener: ((
      details: { responseHeaders?: Record<string, string[]> },
      callback: (response: { responseHeaders?: Record<string, string[]> }) => void
    ) => void) | undefined;
    let registrations = 0;
    const session = {
      webRequest: {
        onHeadersReceived(next: typeof listener) {
          registrations += 1;
          listener = next;
        }
      }
    } as unknown as Electron.Session;

    installMainRendererContentSecurityPolicy(session);
    installMainRendererContentSecurityPolicy(session);
    let response: { responseHeaders?: Record<string, string[]> } | undefined;
    listener?.(
      { responseHeaders: { "X-Rion-Test": ["preserved"] } },
      (next) => { response = next; }
    );

    expect(registrations).toBe(1);
    expect(response?.responseHeaders?.["X-Rion-Test"]).toEqual(["preserved"]);
    expect(response?.responseHeaders?.["Content-Security-Policy"]?.[0])
      .toContain("script-src 'self'");
  });

  it("normalizes native, standard, string, and opaque errors", () => {
    expect(normalizeRionBridgeError({ code: "ROLE_BUSY", message: "Role is busy." }))
      .toEqual({ code: "ROLE_BUSY", message: "Role is busy." });
    expect(normalizeRionBridgeError(new Error("Native adapter failed."), "NATIVE_FAILED"))
      .toEqual({ code: "NATIVE_FAILED", message: "Native adapter failed." });
    expect(normalizeRionBridgeError("Plain failure", "PLAIN_FAILED"))
      .toEqual({ code: "PLAIN_FAILED", message: "Plain failure" });
    expect(normalizeRionBridgeError({ stack: "secret stack" }, "OPAQUE_FAILED"))
      .toEqual({
        code: "OPAQUE_FAILED",
        message: "Rion Studio could not complete the desktop request."
      });
  });
});
