// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";

import { AppSidebar } from "../src/renderer/src/components/AppSidebar";
import en from "../src/renderer/src/i18n/en.json";
import type { Translator } from "../src/renderer/src/i18n";
import type { RionStudioApi } from "../src/shared/api";

const t: Translator = (key) => en[key] ?? key;

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "rionStudio");
  delete document.documentElement.dataset.platform;
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
      const startCurrentWindowDrag = vi.fn(() => Promise.resolve());
      const toggleCurrentWindowMaximize = vi.fn(() => Promise.resolve());
      Object.defineProperty(window, "rionStudio", {
        configurable: true,
        value: {
          startCurrentWindowDrag,
          toggleCurrentWindowMaximize
        } as unknown as RionStudioApi
      });
      document.documentElement.dataset.platform = platform;
      renderSidebar("/games");

      const brandTitle = screen.getByText("Rion Studio");
      const brandRegion = brandTitle.closest<HTMLElement>("[data-window-drag-handle]");
      expect(brandRegion).not.toBeNull();
      expect(brandRegion?.className).toContain("app-sidebar-brand-region");
      expect(brandRegion?.parentElement?.className).toContain("app-main-sidebar");
      expect(brandTitle.closest("button")).toBeNull();

      fireEvent.mouseDown(brandTitle, { button: 0, detail: 1 });
      expect(startCurrentWindowDrag).toHaveBeenCalledOnce();
      expect(toggleCurrentWindowMaximize).not.toHaveBeenCalled();

      fireEvent.mouseDown(brandTitle, { button: 0, detail: 2 });
      expect(startCurrentWindowDrag).toHaveBeenCalledOnce();
      expect(toggleCurrentWindowMaximize).toHaveBeenCalledOnce();

      fireEvent.mouseDown(brandTitle, { button: 2, detail: 1 });
      expect(startCurrentWindowDrag).toHaveBeenCalledOnce();

      const home = screen.getByRole("button", { name: "Home" });
      expect(home.className).toContain("app-no-drag");
      expect(home.className).not.toContain("nav-item-active");

      fireEvent.click(home);

      await waitFor(() => expect(home.className).toContain("nav-item-active"));
    }
  );
});
