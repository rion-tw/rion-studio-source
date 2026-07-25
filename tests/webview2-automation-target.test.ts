import { describe, expect, it, vi } from "vitest";

import { WebView2AutomationTarget } from "../src/main/browser/WebView2AutomationTarget";
import type { WindowsWebView2SurfacePort } from "../src/main/browser/WindowsWebView2Surface";

function surface(): WindowsWebView2SurfacePort {
  return {
    callDevToolsProtocolMethod: vi.fn(async (method: string) =>
      method === "Page.getLayoutMetrics"
        ? { cssVisualViewport: { clientHeight: 600, clientWidth: 800 } }
        : {}
    ),
    clearStorage: vi.fn(),
    destroy: vi.fn(),
    evaluate: vi.fn().mockResolvedValue("canvas"),
    focus: vi.fn(),
    loadUrl: vi.fn(),
    onLifecycleEvent: vi.fn(() => () => undefined),
    setAudioMuted: vi.fn(),
    setBounds: vi.fn(),
    setVisible: vi.fn(),
    setZoomFactor: vi.fn()
  } as WindowsWebView2SurfacePort;
}

describe("WebView2AutomationTarget", () => {
  it("dispatches trusted percentage clicks through the control-scoped CDP endpoint", async () => {
    const targetSurface = surface();
    const target = new WebView2AutomationTarget(
      targetSurface,
      { invoke: vi.fn() } as never,
      "role-1"
    );
    const onClick = vi.fn();

    await target.dispatchClick(25, 50, { onClick });

    expect(targetSurface.callDevToolsProtocolMethod).toHaveBeenNthCalledWith(
      2,
      "Input.dispatchMouseEvent",
      {
        type: "mousePressed",
        button: "left",
        clickCount: 1,
        x: 200,
        y: 300
      }
    );
    expect(targetSurface.callDevToolsProtocolMethod).toHaveBeenNthCalledWith(
      3,
      "Input.dispatchMouseEvent",
      expect.objectContaining({ type: "mouseReleased", x: 200, y: 300 })
    );
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("keeps Rust authoritative for key ownership and compensates protocol failure", async () => {
    const targetSurface = surface();
    const invoke = vi.fn(async (command: { type: string }) => {
      if (command.type === "embeddedKeyPrepare") {
        return {
          transitionId: "transition-1",
          hasHeldKeys: false,
          effects: [{
            phase: "rawKeyDown",
            code: "KeyA",
            activeCodes: ["KeyA"],
            activeCodesBefore: [],
            autoRepeat: false,
            suppressShortcut: false
          }, {
            phase: "keyUp",
            code: "KeyA",
            activeCodes: [],
            activeCodesBefore: ["KeyA"],
            autoRepeat: false,
            suppressShortcut: false
          }]
        };
      }
      return undefined;
    });
    const target = new WebView2AutomationTarget(
      targetSurface,
      { invoke } as never,
      "role-1"
    );

    await target.dispatchKey("KeyA");

    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      type: "embeddedKeyPrepare",
      roleId: "role-1",
      phase: "tap",
      code: "KeyA"
    }));
    expect(invoke).toHaveBeenCalledWith({
      type: "embeddedKeyComplete",
      transitionId: "transition-1",
      succeeded: true
    });
    expect(targetSurface.callDevToolsProtocolMethod).toHaveBeenCalledWith(
      "Input.dispatchKeyEvent",
      expect.objectContaining({
        type: "rawKeyDown",
        code: "KeyA",
        windowsVirtualKeyCode: 65
      })
    );
  });
});
