// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router";

import { AppSidebar } from "../src/renderer/src/components/AppSidebar";
import en from "../src/renderer/src/i18n/en.json";
import type { Translator } from "../src/renderer/src/i18n";

const t: Translator = (key) => en[key] ?? key;

afterEach(() => {
  cleanup();
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
      document.documentElement.dataset.platform = platform;
      renderSidebar("/games");

      const brandTitle = screen.getByText("Rion Studio");
      const brandRegion = brandTitle.closest<HTMLElement>("[data-tauri-drag-region]");
      expect(brandRegion?.getAttribute("data-tauri-drag-region")).toBe("deep");
      expect(brandTitle.closest("button")).toBeNull();

      const home = screen.getByRole("button", { name: "Home" });
      expect(home.className).toContain("app-no-drag");
      expect(home.className).not.toContain("nav-item-active");

      fireEvent.click(home);

      await waitFor(() => expect(home.className).toContain("nav-item-active"));
    }
  );
});
