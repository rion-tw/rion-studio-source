// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router";

import { AppSidebar } from "../src/renderer/src/components/AppSidebar";
import { WindowDragHandle } from "../src/renderer/src/components/WindowDragHandle";
import en from "../src/renderer/src/i18n/en.json";
import type { Translator } from "../src/renderer/src/i18n";

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

describe("application sidebar window dragging", () => {
  it.each(["mac", "windows"] as const)(
    "keeps the brand region draggable and Home navigation interactive on %s",
    async (platform) => {
      document.documentElement.dataset.platform = platform;
      renderSidebar("/games");

      const brandTitle = screen.getByText("Rion Studio");
      const brandRegion = brandTitle.closest<HTMLElement>("[data-window-drag-handle]");
      expect(brandRegion).not.toBeNull();
      expect(brandRegion?.className).toContain("app-sidebar-brand-region");
      expect(brandRegion?.parentElement?.className).toContain("app-main-sidebar");
      expect(brandTitle.closest("button")).toBeNull();
      if (!brandRegion) throw new Error("Expected a sidebar window drag handle.");
      expect(brandRegion.className).toContain("app-drag");
      expect(brandRegion.hasAttribute("data-tauri-drag-region")).toBe(false);
      expect(brandRegion.parentElement?.className).toContain("app-drag");
      expect(brandRegion.parentElement?.hasAttribute("data-window-drag-handle")).toBe(true);

      const home = screen.getByRole("button", { name: "Home" });
      expect(home.className).toContain("app-no-drag");
      expect(home.className).not.toContain("nav-item-active");

      fireEvent.click(home);

      await waitFor(() => expect(home.className).toContain("nav-item-active"));
    }
  );

  it("marks the content-top surface as a native CSS drag region without custom gestures", () => {
    render(<WindowDragHandle className="app-content-window-drag-region" />);

    const contentRegion = document.querySelector<HTMLElement>(".app-content-window-drag-region");
    expect(contentRegion).not.toBeNull();
    expect(contentRegion?.className).toContain("app-drag");
    expect(contentRegion?.hasAttribute("data-selection-ignore")).toBe(true);
    expect(contentRegion?.hasAttribute("data-tauri-drag-region")).toBe(false);

    fireEvent.pointerDown(contentRegion!, { button: 0, isPrimary: true, pointerId: 1 });
    fireEvent.mouseDown(contentRegion!, { button: 0, detail: 1 });
    fireEvent.mouseDown(contentRegion!, { button: 0, detail: 2 });
  });

  it("keeps the fullscreen state on the root so CSS disables native dragging", () => {
    document.documentElement.dataset.windowFullscreen = "true";
    render(<WindowDragHandle className="app-content-window-drag-region" />);

    expect(document.documentElement.dataset.windowFullscreen).toBe("true");
    expect(document.querySelector<HTMLElement>(".app-content-window-drag-region")
      ?.className).toContain("app-drag");
  });
});
