import { describe, expect, it, vi } from "vitest";

import {
  CHROMIUM_ROLE_OVERLAY_API_KEY,
  CHROMIUM_ROLE_OVERLAY_CHANNEL,
  CHROMIUM_ROLE_OVERLAY_WORLD_ID,
  CHROMIUM_ROLE_OVERLAY_WORLD_NAME
} from "../src/electron/ipc/chromiumRoleOverlayProtocol";
import {
  createChromiumRoleOverlayApi,
  installChromiumRoleOverlay
} from "../src/electron/preload/installChromiumRoleOverlay";
import { assembleChromiumRoleOverlaySource } from
  "../src/electron/preload/chromiumRoleOverlaySource";

describe("Chromium role overlay preload", () => {
  it("assembles the shared overlay into a private Chromium binding", () => {
    const source = assembleChromiumRoleOverlaySource();

    expect(source).toContain("rion-studio-macro-overlay-v62");
    expect(source).toContain(CHROMIUM_ROLE_OVERLAY_API_KEY);
    expect(source).toContain("--font-ui");
    expect(source).toContain("(event) => event.isTrusted === true");
    expect(source).toContain("bridge.refreshReceipt = (payload) => native.refreshReceipt(payload)");
    expect(source).toContain('typeof native.inputContextLost === "function"');
    expect(source).not.toContain("bridge.macroKeyObserved");
    expect(source).not.toContain("bridge.macroBadgeTiming");
    expect(source).not.toContain("bridge.shortcutLifecycle");
    expect(source).not.toContain("__TAURI_INTERNALS__");
    expect(source).not.toContain("__RION_STUDIO_MACRO_OVERLAY_BINDING__");
    expect(source).not.toContain("__RION_STUDIO_MACRO_OVERLAY_CSS__");
    expect(source).not.toContain("__RION_STUDIO_MACRO_OVERLAY_SHORTCUT_GUARD__");
  });

  it("offers only named overlay methods over the fixed private IPC channel", async () => {
    const invoke = vi.fn(async () => ({ accepted: true }));
    const api = createChromiumRoleOverlayApi({ invoke }, "frame-token-1", "win32");

    expect(Object.isFrozen(api)).toBe(true);
    await api.request({ type: "list" });
    await api.ready();
    await api.refreshReceipt({
      refreshId: "00000000-0000-4000-8000-000000000001",
      requestVersion: 2,
      status: "applied"
    });
    await api.macroKeyObserved({ dispatchId: "dispatch-1" });
    await api.managedShortcutKeyPhase({ phase: "keyDown" });
    await api.inputContextLost?.({ reason: "blur" });
    await api.macroBadgeTiming({ phase: "animationStart" });

    expect(invoke.mock.calls).toEqual([
      [CHROMIUM_ROLE_OVERLAY_CHANNEL, {
        frameToken: "frame-token-1",
        method: "request",
        payload: { type: "list" }
      }],
      [CHROMIUM_ROLE_OVERLAY_CHANNEL, {
        frameToken: "frame-token-1",
        method: "ready"
      }],
      [CHROMIUM_ROLE_OVERLAY_CHANNEL, {
        frameToken: "frame-token-1",
        method: "refreshReceipt",
        payload: {
          refreshId: "00000000-0000-4000-8000-000000000001",
          requestVersion: 2,
          status: "applied"
        }
      }],
      [CHROMIUM_ROLE_OVERLAY_CHANNEL, {
        frameToken: "frame-token-1",
        method: "macroKeyObserved",
        payload: { dispatchId: "dispatch-1" }
      }],
      [CHROMIUM_ROLE_OVERLAY_CHANNEL, {
        frameToken: "frame-token-1",
        method: "managedShortcutKeyPhase",
        payload: { phase: "keyDown" }
      }],
      [CHROMIUM_ROLE_OVERLAY_CHANNEL, {
        frameToken: "frame-token-1",
        method: "inputContextLost",
        payload: { reason: "blur" }
      }],
      [CHROMIUM_ROLE_OVERLAY_CHANNEL, {
        frameToken: "frame-token-1",
        method: "macroBadgeTiming",
        payload: { phase: "animationStart" }
      }]
    ]);
  });

  it("omits Windows-only continuity and diagnostic shortcut lifecycle on macOS", () => {
    const api = createChromiumRoleOverlayApi(
      { invoke: vi.fn(async () => undefined) },
      "frame-token-1",
      "darwin"
    );

    expect(api).not.toHaveProperty("inputContextLost");
    expect(api).not.toHaveProperty("shortcutLifecycle");
  });

  it("installs into world 1004 without a main-world bridge or user gesture", async () => {
    const exposeInIsolatedWorld = vi.fn();
    const executeJavaScriptInIsolatedWorld = vi.fn(async () => undefined);
    const setIsolatedWorldInfo = vi.fn();

    await expect(installChromiumRoleOverlay(
      { exposeInIsolatedWorld },
      { invoke: vi.fn(async () => undefined) },
      { executeJavaScriptInIsolatedWorld, frameToken: "frame-token-1", setIsolatedWorldInfo },
      true
    )).resolves.toBe(true);

    expect(setIsolatedWorldInfo).toHaveBeenCalledWith(
      CHROMIUM_ROLE_OVERLAY_WORLD_ID,
      expect.objectContaining({
        name: CHROMIUM_ROLE_OVERLAY_WORLD_NAME,
        securityOrigin: "https://rion-overlay.invalid"
      })
    );
    expect(exposeInIsolatedWorld).toHaveBeenCalledWith(
      CHROMIUM_ROLE_OVERLAY_WORLD_ID,
      CHROMIUM_ROLE_OVERLAY_API_KEY,
      expect.any(Object)
    );
    expect(executeJavaScriptInIsolatedWorld).toHaveBeenCalledWith(
      CHROMIUM_ROLE_OVERLAY_WORLD_ID,
      [{
        code: expect.stringContaining("rion-studio-macro-overlay-v62"),
        url: "rion-studio://chromium-role-overlay.js"
      }],
      false
    );
  });

  it("does not install in child frames", async () => {
    const exposeInIsolatedWorld = vi.fn();
    const executeJavaScriptInIsolatedWorld = vi.fn(async () => undefined);
    const setIsolatedWorldInfo = vi.fn();

    await expect(installChromiumRoleOverlay(
      { exposeInIsolatedWorld },
      { invoke: vi.fn(async () => undefined) },
      { executeJavaScriptInIsolatedWorld, frameToken: "frame-token-1", setIsolatedWorldInfo },
      false
    )).resolves.toBe(false);

    expect(exposeInIsolatedWorld).not.toHaveBeenCalled();
    expect(executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
    expect(setIsolatedWorldInfo).not.toHaveBeenCalled();
  });
});
