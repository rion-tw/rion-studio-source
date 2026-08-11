// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";

import { AppSidebar } from "../src/renderer/src/components/AppSidebar";
import { WindowDragHandle } from "../src/renderer/src/components/WindowDragHandle";
import { SettingsSidebar } from "../src/renderer/src/features/settings/SettingsSidebar";
import en from "../src/renderer/src/i18n/en.json";
import type { Translator } from "../src/renderer/src/i18n";
import type { RionStudioApi } from "../src/shared/api";

const t: Translator = (key) => en[key] ?? key;

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "rionStudio");
  delete document.documentElement.dataset.platform;
  delete document.documentElement.dataset.windowFullscreen;
});

function renderSidebar(initialEntry: string): void {
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <AppSidebar
        gameCount={1}
        gameWindowCount={2}
        hasUpdateBadge={false}
        macroCount={3}
        roleCount={4}
        t={t}
        workspaceCount={5}
      />
    </MemoryRouter>
  );
}

function installWindowBridge() {
  const startCurrentWindowDrag = vi.fn(() => Promise.resolve());
  const toggleCurrentWindowMaximize = vi.fn(() => Promise.resolve());
  Object.defineProperty(window, "rionStudio", {
    configurable: true,
    value: {
      startCurrentWindowDrag,
      toggleCurrentWindowMaximize
    } as unknown as RionStudioApi
  });
  return { startCurrentWindowDrag, toggleCurrentWindowMaximize };
}

describe("application sidebar window dragging", () => {
  it.each(["mac", "windows"] as const)(
    "keeps the brand region draggable and Home navigation interactive on %s",
    async (platform) => {
      const bridge = installWindowBridge();
      document.documentElement.dataset.platform = platform;
      renderSidebar("/games");

      const brandTitle = screen.getByText("Rion Studio");
      const brandRegion = brandTitle.closest<HTMLElement>("[data-window-drag-handle]");
      expect(brandRegion).not.toBeNull();
      expect(brandRegion?.className).toContain("app-sidebar-brand-region");
      expect(brandRegion?.parentElement?.className).toContain("app-main-sidebar");
      expect(brandTitle.closest("button")).toBeNull();
      if (!brandRegion) throw new Error("Expected a sidebar window drag handle.");
      const expectedDragClass = platform === "windows" ? "app-drag" : "app-no-drag";
      expect(brandRegion.className).toContain(expectedDragClass);
      expect(brandRegion.hasAttribute("data-tauri-drag-region")).toBe(false);
      expect(brandRegion.parentElement?.className).toContain(expectedDragClass);
      expect(brandRegion.parentElement?.hasAttribute("data-window-drag-handle")).toBe(true);

      fireEvent.mouseDown(brandTitle, { button: 0, detail: 1 });
      expect(bridge.startCurrentWindowDrag).toHaveBeenCalledTimes(platform === "mac" ? 1 : 0);
      expect(bridge.toggleCurrentWindowMaximize).not.toHaveBeenCalled();
      fireEvent.mouseDown(brandTitle, { button: 0, detail: 2 });
      expect(bridge.startCurrentWindowDrag).toHaveBeenCalledTimes(platform === "mac" ? 1 : 0);
      expect(bridge.toggleCurrentWindowMaximize).toHaveBeenCalledTimes(platform === "mac" ? 1 : 0);

      const home = screen.getByRole("button", { name: "Home" });
      expect(home.className).toContain("app-no-drag");
      expect(home.className).not.toContain("nav-item-active");

      fireEvent.mouseDown(home, { button: 0, detail: 1 });
      expect(bridge.startCurrentWindowDrag).toHaveBeenCalledTimes(platform === "mac" ? 1 : 0);

      fireEvent.click(home);

      await waitFor(() => expect(home.className).toContain("nav-item-active"));
    }
  );

  it("routes the macOS content-top surface through native drag and maximize commands", () => {
    const bridge = installWindowBridge();
    document.documentElement.dataset.platform = "mac";
    render(<WindowDragHandle className="app-content-window-drag-region" />);

    const contentRegion = document.querySelector<HTMLElement>(".app-content-window-drag-region");
    expect(contentRegion).not.toBeNull();
    expect(contentRegion?.className).toContain("app-no-drag");
    expect(contentRegion?.hasAttribute("data-selection-ignore")).toBe(true);
    expect(contentRegion?.hasAttribute("data-tauri-drag-region")).toBe(false);

    fireEvent.pointerDown(contentRegion!, { button: 0, isPrimary: true, pointerId: 1 });
    fireEvent.mouseDown(contentRegion!, { button: 0, detail: 1 });
    expect(bridge.startCurrentWindowDrag).toHaveBeenCalledOnce();
    expect(bridge.toggleCurrentWindowMaximize).not.toHaveBeenCalled();
    fireEvent.mouseDown(contentRegion!, { button: 0, detail: 2 });
    expect(bridge.startCurrentWindowDrag).toHaveBeenCalledOnce();
    expect(bridge.toggleCurrentWindowMaximize).toHaveBeenCalledOnce();
    fireEvent.mouseDown(contentRegion!, { button: 2, detail: 1 });
    fireEvent.mouseDown(contentRegion!, { button: 0, detail: 3 });
    expect(bridge.startCurrentWindowDrag).toHaveBeenCalledOnce();
    expect(bridge.toggleCurrentWindowMaximize).toHaveBeenCalledOnce();
  });

  it("hands the Windows content-top surface to the native non-client region", () => {
    const bridge = installWindowBridge();
    document.documentElement.dataset.platform = "windows";
    render(<WindowDragHandle className="app-content-window-drag-region" />);

    const contentRegion = document.querySelector<HTMLElement>(".app-content-window-drag-region")!;
    expect(contentRegion.className).toContain("app-drag");
    expect(contentRegion.className).not.toContain("app-no-drag");
    expect(contentRegion.hasAttribute("data-tauri-drag-region")).toBe(false);

    fireEvent.pointerDown(contentRegion, { button: 0, isPrimary: true, pointerId: 1 });
    fireEvent.mouseDown(contentRegion, { button: 0, detail: 1 });
    fireEvent.mouseDown(contentRegion, { button: 0, detail: 2 });

    expect(bridge.startCurrentWindowDrag).not.toHaveBeenCalled();
    expect(bridge.toggleCurrentWindowMaximize).not.toHaveBeenCalled();
  });

  it.each(["mac", "windows"] as const)(
    "disables manual window gestures while fullscreen on %s",
    (platform) => {
      const bridge = installWindowBridge();
      document.documentElement.dataset.platform = platform;
      document.documentElement.dataset.windowFullscreen = "true";
      render(<WindowDragHandle className="app-content-window-drag-region" />);

      const contentRegion = document.querySelector<HTMLElement>(".app-content-window-drag-region")!;
      fireEvent.mouseDown(contentRegion, { button: 0, detail: 1 });
      fireEvent.mouseDown(contentRegion, { button: 0, detail: 2 });

      expect(bridge.startCurrentWindowDrag).not.toHaveBeenCalled();
      expect(bridge.toggleCurrentWindowMaximize).not.toHaveBeenCalled();
    }
  );

  it.each(["mac", "windows"] as const)(
    "uses the platform window gesture surface for the settings sidebar on %s",
    (platform) => {
      const bridge = installWindowBridge();
      document.documentElement.dataset.platform = platform;
      render(
        <MemoryRouter initialEntries={["/settings?section=interface"]}>
          <SettingsSidebar t={t} />
        </MemoryRouter>
      );
      const sidebar = document.querySelector<HTMLElement>(".settings-mode-sidebar")!;
      expect(sidebar.tagName).toBe("ASIDE");
      expect(sidebar.className).toContain(platform === "windows" ? "app-drag" : "app-no-drag");

      fireEvent.mouseDown(sidebar, { button: 0, detail: 1 });
      expect(bridge.startCurrentWindowDrag).toHaveBeenCalledTimes(platform === "mac" ? 1 : 0);
      const back = screen.getByRole("button", { name: "Back to app" });
      expect(back.className).toContain("app-no-drag");
      fireEvent.mouseDown(back, { button: 0, detail: 1 });
      expect(bridge.startCurrentWindowDrag).toHaveBeenCalledTimes(platform === "mac" ? 1 : 0);
    }
  );
});
