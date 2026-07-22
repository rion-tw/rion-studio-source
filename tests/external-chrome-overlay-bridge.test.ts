import { describe, expect, it, vi } from "vitest";

import {
  connectExternalChromeAutomation,
  ExternalChromeAutomationTarget
} from "../src/main/browser/ExternalChromeAutomationTarget";
import type {
  CdpEventClientLike,
  CdpNotification
} from "../src/main/browser/ExternalChromeCdpBridge";

describe("External Chrome overlay bridge", () => {
  it("requires the Rust-owned CDP connection and installs only lifecycle/overlay plumbing", async () => {
    const harness = createClient();
    const connectClient = vi.fn().mockResolvedValue(harness.client);
    const target = await connectExternalChromeAutomation("/profile", "https://example.com", {
      cdnCompatibilityEnabled: true,
      connectClient,
      roleId: "role-1"
    });

    expect(connectClient).toHaveBeenCalledWith(
      "/profile",
      "https://example.com",
      "role-1",
      true
    );
    const methods = harness.send.mock.calls.map(([method]) => method);
    expect(methods).toEqual(expect.arrayContaining([
      "Page.enable",
      "Runtime.enable",
      "Runtime.addBinding",
      "Page.addScriptToEvaluateOnNewDocument"
    ]));
    expect(methods).not.toEqual(expect.arrayContaining([
      "Fetch.enable",
      "Input.dispatchKeyEvent",
      "Input.dispatchMouseEvent",
      "Browser.setWindowBounds"
    ]));
    target.close();
    expect(harness.close).toHaveBeenCalledOnce();
  });

  it("forwards navigation and overlay requests without owning browser runtime state", async () => {
    const harness = createClient();
    const target = new ExternalChromeAutomationTarget(harness.client);
    await target.initialize();
    const navigation = vi.fn();
    target.onNavigation(navigation);
    const handler = vi.fn().mockResolvedValue({ ok: true });
    await target.installMacroOverlay("window.overlayInstalled = true", handler);

    harness.notify({
      method: "Page.frameNavigated",
      params: { frame: { id: "main" } }
    });
    harness.notify({
      method: "Runtime.bindingCalled",
      params: {
        executionContextId: 7,
        name: "rionStudioMacroOverlay",
        payload: JSON.stringify({ id: 3, request: { type: "list" } })
      }
    });

    await vi.waitFor(() => expect(handler).toHaveBeenCalledWith({ type: "list" }));
    expect(navigation).toHaveBeenCalledOnce();
    expect(harness.send).toHaveBeenCalledWith(
      "Runtime.evaluate",
      expect.objectContaining({ contextId: 7 })
    );
  });
});

function createClient() {
  const notificationListeners = new Set<(notification: CdpNotification) => void>();
  const disconnectListeners = new Set<() => void>();
  const send = vi.fn(async (method: string) => {
    if (method === "Runtime.evaluate") return { result: { value: undefined } };
    if (method === "Browser.getVersion") return { product: "Chrome/1" };
    return {};
  });
  const close = vi.fn();
  const client: CdpEventClientLike = {
    close,
    onDisconnect: (listener) => {
      disconnectListeners.add(listener);
      return () => disconnectListeners.delete(listener);
    },
    onNotification: (listener) => {
      notificationListeners.add(listener);
      return () => notificationListeners.delete(listener);
    },
    send: send as CdpEventClientLike["send"]
  };
  return {
    client,
    close,
    notify: (notification: CdpNotification) =>
      notificationListeners.forEach((listener) => listener(notification)),
    send
  };
}
