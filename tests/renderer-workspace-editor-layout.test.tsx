// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ConfirmationProvider } from "../src/renderer/src/components/ConfirmationDialog";
import WorkspaceEditorRoute from "../src/renderer/src/features/workspaces/WorkspaceModal";
import { mergeWorkspaceRoleZoomOverrides } from "../src/renderer/src/features/workspaces/workspaceLayoutUtils";
import type { Translator } from "../src/renderer/src/i18n";
import en from "../src/renderer/src/i18n/en.json";
import type { Game, LaunchWorkspace, Role } from "../src/shared/types";

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class ResizeObserver {
    disconnect(): void {}
    observe(): void {}
    unobserve(): void {}
  });
});

afterEach(cleanup);
afterAll(() => vi.unstubAllGlobals());

describe("workspace editor role picker layout", () => {
  it("merges background runtime zoom changes into hidden form state", () => {
    const previous = workspace().slots.map((slot) => slot.roleId === "role-1"
      ? { ...slot, browserZoomPercent: 110 }
      : slot);
    const runtimeUpdated = previous.map((slot) => slot.roleId === "role-1"
      ? { ...slot, browserZoomPercent: 120 }
      : slot);

    expect(mergeWorkspaceRoleZoomOverrides(previous, previous, runtimeUpdated)[0])
      .toMatchObject({ browserZoomPercent: 120 });

    const locallyResized = previous.map((slot, index) => index === 0
      ? { ...slot, rect: { ...slot.rect, width: 0.55 } }
      : slot);
    expect(mergeWorkspaceRoleZoomOverrides(locallyResized, previous, runtimeUpdated)[0])
      .toMatchObject({ browserZoomPercent: 120, rect: { width: 0.55 } });
  });

  it("hides role zoom while preserving it through workspace saves", async () => {
    const roles = Array.from({ length: 7 }, (_value, index) => role(index + 1));
    const selectedWorkspace = workspace();
    selectedWorkspace.slots[0].browserZoomPercent = 96;
    const onSave = vi.fn().mockResolvedValue(undefined);
    const router = createMemoryRouter(
      [
        {
          path: "/workspaces/:id/edit",
          element: (
            <WorkspaceEditorRoute
              games={[game()]}
              isSaving={false}
              roles={roles}
              statusByRole={new Map()}
              t={t}
              workspaceDisplays={[]}
              workspaces={[selectedWorkspace]}
              onSave={onSave}
            />
          )
        }
      ],
      { initialEntries: ["/workspaces/workspace-1/edit"] }
    );

    const { container } = render(
      <ConfirmationProvider>
        <RouterProvider router={router} />
      </ConfirmationProvider>
    );

    const rolePanel = container.querySelector<HTMLElement>("[data-workspace-role-panel]");
    const scrollRegion = container.querySelector<HTMLElement>("[data-workspace-role-scroll]");
    const roleList = container.querySelector<HTMLElement>("[data-workspace-role-list]");
    const roleButtons = container.querySelectorAll<HTMLElement>("[data-workspace-role-id]");
    const verticalResizeHandle = container.querySelector<HTMLElement>("button.cursor-col-resize");
    const roleZoomHint = container.querySelector<HTMLElement>("[data-workspace-role-zoom-hint]");

    expect(screen.getByRole("combobox", { name: "Browser zoom" }).textContent).toContain(
      "Adaptive (recommended)"
    );
    expect(screen.queryByText("Role zoom")).toBeNull();
    expect(screen.queryByText("Follow workspace")).toBeNull();
    expect(screen.queryByText("96%")).toBeNull();
    expect(roleZoomHint?.textContent).toContain("Command +/−/0 on macOS");
    expect(roleZoomHint?.textContent).toContain("Ctrl +/−/0 on Windows");
    expect(roleZoomHint?.textContent).toContain("saved to this workspace automatically");
    expect(roleZoomHint?.textContent).toContain("restored the next time the role launches");
    expect(roleZoomHint?.querySelector("svg")).toBeNull();
    expect(roleZoomHint?.querySelectorAll("li")).toHaveLength(1);
    expect(roleZoomHint?.className).toContain("rounded-lg");
    expect(roleZoomHint?.className).toContain("p-4");
    expect(roleZoomHint?.className).not.toContain("bg-background/25");
    expect(roleZoomHint?.querySelector("ol")).toBeNull();
    expect(roleZoomHint?.querySelector("ul")?.className).toContain("max-w-[72ch]");
    expect(roleZoomHint?.querySelector("li")?.textContent?.trim().startsWith("*")).toBe(true);
    expect(roleZoomHint?.parentElement?.lastElementChild).toBe(roleZoomHint);
    expect(screen.queryByRole("combobox", { name: "Initial primary" })).toBeNull();
    expect(screen.queryByText("Primary")).toBeNull();
    expect(rolePanel?.className).toContain("flex-col");
    expect(rolePanel?.className).toContain("min-[1180px]:overflow-hidden");
    expect(rolePanel?.className).toContain("min-[1180px]:[contain:size]");
    expect(scrollRegion?.className).toContain("max-h-[clamp(320px,45vh,440px)]");
    expect(scrollRegion?.className).toContain("overflow-y-auto");
    expect(scrollRegion?.className).toContain("overflow-x-hidden");
    expect(scrollRegion?.className).toContain("min-[1180px]:min-h-0");
    expect(scrollRegion?.className).toContain("min-[1180px]:max-h-none");
    expect(scrollRegion?.className).toContain("min-[1180px]:flex-1");
    expect(roleList?.className).toContain("auto-rows-max");
    expect(roleList?.className).toContain("content-start");
    expect(verticalResizeHandle?.className).toContain("w-[30px]");
    expect(roleButtons).toHaveLength(7);
    roleButtons.forEach((button) => {
      expect(button.className).toContain("h-[52px]");
      expect(button.getAttribute("draggable")).toBe("true");
    });

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0][0].slots[0]).toMatchObject({ browserZoomPercent: 96 });

    fireEvent.click(roleButtons[2]);

    expect(roleButtons[2].textContent).toContain("S1");
  });

  it("shows the role zoom shortcut hint when creating a workspace", () => {
    const router = createMemoryRouter(
      [
        {
          path: "/workspaces/new",
          element: (
            <WorkspaceEditorRoute
              games={[game()]}
              isSaving={false}
              roles={[]}
              statusByRole={new Map()}
              t={t}
              workspaceDisplays={[]}
              workspaces={[]}
              onSave={vi.fn()}
            />
          )
        }
      ],
      { initialEntries: ["/workspaces/new"] }
    );

    const { container } = render(
      <ConfirmationProvider>
        <RouterProvider router={router} />
      </ConfirmationProvider>
    );

    expect(container.querySelector("[data-workspace-role-zoom-hint]")?.textContent)
      .toContain("Command +/−/0 on macOS");
    expect(screen.queryByText("Role zoom")).toBeNull();
    expect(screen.queryByText("Follow workspace")).toBeNull();
  });
});

const t: Translator = (key) => en[key];

function game(): Game {
  return {
    id: "game-1",
    source: "custom",
    name: "Test game",
    defaultLaunchUrl: "https://example.test/play",
    browserLaunchMode: "inherit",
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z"
  };
}

function role(index: number): Role {
  return {
    id: `role-${index}`,
    gameId: "game-1",
    name: `Role ${index}`,
    launchUrl: "https://example.test/play",
    windowWidth: 1280,
    windowHeight: 720,
    notes: "",
    authState: "authenticated",
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z"
  };
}

function workspace(): LaunchWorkspace {
  return {
    id: "workspace-1",
    name: "Party",
    template: "two_columns",
    browserLaunchMode: "inherit",
    browserZoomMode: "adaptive",
    browserZoomPercent: 100,
    resourcePolicy: { mode: "adaptive" },
    slots: [
      { id: "slot-1", roleId: "role-1", rect: { x: 0, y: 0, width: 0.5, height: 1 } },
      { id: "slot-2", roleId: "role-2", rect: { x: 0.5, y: 0, width: 0.5, height: 1 } }
    ],
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z"
  };
}
