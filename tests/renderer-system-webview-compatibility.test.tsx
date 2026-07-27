// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";

import { GameCompatibilityPanel } from "../src/renderer/src/features/games/GameCompatibilityPanel";
import { SettingsSidebar } from "../src/renderer/src/features/settings/SettingsSidebar";
import en from "../src/renderer/src/i18n/en.json";
import type { Translator } from "../src/renderer/src/i18n";

const t: Translator = (key) => en[key] ?? key;

describe("retired graphics settings and System WebView compatibility", () => {
  it("routes legacy graphics settings links to Interface without a Game settings item", () => {
    render(
      <MemoryRouter initialEntries={["/settings?section=game"]}>
        <SettingsSidebar t={t} />
      </MemoryRouter>
    );

    expect(screen.queryByText("Game settings")).toBeNull();
    expect(screen.getByRole("button", { name: "Interface settings" }).className)
      .toContain("nav-item-active");
  });

  it("shows measured runtime and graphics details without linking to global graphics settings", () => {
    render(
      <GameCompatibilityPanel
        report={{
          gameId: "game-1",
          checkedAt: "2026-07-28T02:00:00.000Z",
          configurationFingerprint: "probe-v2",
          isStale: false,
          load: {
            state: "available",
            durationMs: 432,
            finalOrigin: "https://example.test"
          },
          graphics: {
            webgl: "unavailable",
            webgl2: "unavailable",
            webgpu: "available",
            renderer: "ANGLE D3D11",
            vendor: "Example GPU Vendor",
            error: "hardware WebGL unavailable"
          },
          recommendation: { reason: "graphics_unavailable" },
          runtime: {
            engine: "webview2",
            engineVersion: "140.0.0.0",
            shell: "tauri",
            shellVersion: "2.11.4"
          },
          observations: {}
        }}
        t={t}
        onCancel={vi.fn()}
        onRun={vi.fn()}
      />
    );

    expect(screen.getByText("WebView2 140.0.0.0")).toBeTruthy();
    expect(screen.getByText("ANGLE D3D11")).toBeTruthy();
    expect(screen.getByText("Example GPU Vendor")).toBeTruthy();
    expect(screen.getByText("hardware WebGL unavailable")).toBeTruthy();
    expect(screen.getByText(/Update the operating system, WebView2 Runtime on Windows/)).toBeTruthy();
    expect(screen.queryByText("Open graphics settings")).toBeNull();
  });
});
