// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
import { type JSX } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useAppWindowStateSync } from "../src/renderer/src/hooks/useAppWindowStateSync";
import type { RionStudioApi } from "../src/shared/api";
import type { AppWindowState } from "../src/shared/types";

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "rionStudio");
  delete document.documentElement.dataset.windowFullscreen;
  vi.restoreAllMocks();
});

describe("useAppWindowStateSync", () => {
  it("applies the initial state and unsubscribes on unmount", async () => {
    const bridge = installBridge({ fullscreen: true });
    const view = render(<WindowStateSync />);

    await waitFor(() => {
      expect(document.documentElement.dataset.windowFullscreen).toBe("true");
    });
    expect(bridge.getCurrentWindowState).toHaveBeenCalledOnce();
    expect(bridge.onCurrentWindowStateChanged).toHaveBeenCalledOnce();

    view.unmount();
    expect(bridge.unsubscribe).toHaveBeenCalledOnce();
  });

  it("updates the dataset when native fullscreen changes", async () => {
    const bridge = installBridge({ fullscreen: false });
    render(<WindowStateSync />);

    await waitFor(() => {
      expect(document.documentElement.dataset.windowFullscreen).toBe("false");
    });

    bridge.emit({ fullscreen: true });
    expect(document.documentElement.dataset.windowFullscreen).toBe("true");
    bridge.emit({ fullscreen: false });
    expect(document.documentElement.dataset.windowFullscreen).toBe("false");
  });

  it("keeps a newer event when the initial request resolves later", async () => {
    let resolveInitial = (_state: AppWindowState): void => undefined;
    const initialState = new Promise<AppWindowState>((resolve) => {
      resolveInitial = resolve;
    });
    const bridge = installBridge(initialState);
    render(<WindowStateSync />);

    bridge.emit({ fullscreen: true });
    resolveInitial({ fullscreen: false });
    await initialState;

    expect(document.documentElement.dataset.windowFullscreen).toBe("true");
  });
});

function WindowStateSync(): JSX.Element {
  useAppWindowStateSync();
  return <div />;
}

function installBridge(initialState: AppWindowState | Promise<AppWindowState>) {
  let listener: ((state: AppWindowState) => void) | undefined;
  const unsubscribe = vi.fn();
  const bridge = {
    getCurrentWindowState: vi.fn(() => Promise.resolve(initialState)),
    onCurrentWindowStateChanged: vi.fn((callback: (state: AppWindowState) => void) => {
      listener = callback;
      return unsubscribe;
    })
  };
  Object.defineProperty(window, "rionStudio", {
    configurable: true,
    value: bridge as unknown as RionStudioApi
  });
  return {
    ...bridge,
    emit: (state: AppWindowState) => listener?.(state),
    unsubscribe
  };
}
