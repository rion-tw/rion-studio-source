// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: vi.fn()
  });
});

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.platform;
  vi.mocked(document.elementFromPoint).mockReset();
});
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
    const workspaceHelps = container.querySelectorAll<HTMLElement>("[data-workspace-help]");

    expect(screen.queryByRole("combobox", { name: "Browser zoom" })).toBeNull();
    expect(screen.queryByText("Role zoom")).toBeNull();
    expect(screen.queryByText("Follow workspace")).toBeNull();
    expect(screen.queryByText("96%")).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Resource mode" })).toBeNull();
    expect(screen.queryByText("Unrestricted")).toBeNull();
    expect(workspaceHelps).toHaveLength(3);
    expect(workspaceHelps[0].getAttribute("data-workspace-help")).toBe("editing");
    expect(workspaceHelps[1].getAttribute("data-workspace-help")).toBe("launch");
    expect(workspaceHelps[2].getAttribute("data-workspace-help")).toBe("runtime");
    expect(workspaceHelps[0].textContent).toContain("Editing roles and layout");
    expect(workspaceHelps[0].textContent).toContain("A role can appear only once");
    expect(workspaceHelps[0].textContent).toContain("roles outside the new layout are not kept");
    expect(workspaceHelps[1].textContent).toContain("Launching the workspace");
    expect(workspaceHelps[1].textContent).toContain("Assign at least one role before launching");
    expect(workspaceHelps[1].textContent).toContain("most recently focused game window");
    expect(workspaceHelps[2].textContent).toContain("While running");
    expect(workspaceHelps[2].textContent).toContain("Each role viewport adapts independently");
    expect(workspaceHelps[2].textContent).toContain("Command +/−/0 on macOS");
    expect(workspaceHelps[2].textContent).toContain("Ctrl +/−/0 on Windows");
    expect(workspaceHelps[2].textContent).toContain("View menu zoom controls the whole game window");
    expect(workspaceHelps[2].textContent).toContain("current scale appears briefly");
    expect(workspaceHelps[2].textContent).toContain("native background throttling");
    expect(workspaceHelps[2].textContent).toContain("does not inject an additional CPU limiter");
    workspaceHelps.forEach((workspaceHelp) => {
      expect(workspaceHelp.querySelector("svg")).toBeNull();
      expect(workspaceHelp.querySelectorAll("section")).toHaveLength(1);
      expect(workspaceHelp.querySelectorAll("li").length).toBeGreaterThan(0);
      expect(workspaceHelp.className).toContain("rounded-lg");
      expect(workspaceHelp.className).toContain("p-4");
      expect(workspaceHelp.className).not.toContain("bg-background/25");
    });
    expect(workspaceHelps[2].parentElement?.lastElementChild).toBe(workspaceHelps[2]);
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
      expect(button.className).toContain("touch-none");
      expect(button.hasAttribute("draggable")).toBe(false);
    });

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0][0].slots[0]).toMatchObject({ browserZoomPercent: 96 });

    fireEvent.click(roleButtons[2]);

    expect(roleButtons[2].textContent).toContain("S1");
  });

  it.each(["darwin", "win32"] as const)("assigns and swaps slots with pointer dragging on %s", async (platform) => {
    document.documentElement.dataset.platform = platform === "darwin" ? "mac" : "windows";
    const selectedWorkspace = workspace();
    const onSave = vi.fn().mockResolvedValue(undefined);
    const router = createMemoryRouter(
      [
        {
          path: "/workspaces/:id/edit",
          element: (
            <WorkspaceEditorRoute
              games={[game()]}
              isSaving={false}
              roles={[role(1), role(2), role(3)]}
              statusByRole={new Map()}
              t={t}
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
    const roleButton = container.querySelector<HTMLElement>("[data-workspace-role-id='role-3']");
    const firstSlot = container.querySelector<HTMLElement>("[data-workspace-slot-index='0']");
    if (!roleButton || !firstSlot) throw new Error("Expected workspace drag sources and targets.");

    pointerDrag(roleButton, firstSlot, 11);
    expect(firstSlot.getAttribute("data-workspace-assigned-role-id")).toBe("role-3");

    const firstSlotHandle = firstSlot.querySelector<HTMLElement>("[data-workspace-slot-drag-handle]");
    const secondSlot = container.querySelector<HTMLElement>("[data-workspace-slot-index='1']");
    if (!firstSlotHandle || !secondSlot) throw new Error("Expected assigned slot drag handle.");
    pointerDrag(firstSlotHandle, secondSlot, 12);

    expect(firstSlot.getAttribute("data-workspace-assigned-role-id")).toBe("role-2");
    expect(secondSlot.getAttribute("data-workspace-assigned-role-id")).toBe("role-3");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0][0].slots.map((slot: LaunchWorkspace["slots"][number]) => slot.roleId))
      .toEqual(["role-2", "role-3"]);
  });

  it("coalesces workspace resize moves, flushes the latest point, and cancels pending work", async () => {
    let nextFrameId = 1;
    const frames = new Map<number, FrameRequestCallback>();
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      const frameId = nextFrameId++;
      frames.set(frameId, callback);
      return frameId;
    });
    const cancelFrame = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((frameId) => {
      frames.delete(frameId);
    });
    const addEventListener = vi.spyOn(window, "addEventListener");
    const onSave = vi.fn().mockResolvedValue(undefined);
    const router = createMemoryRouter(
      [
        {
          path: "/workspaces/:id/edit",
          element: (
            <WorkspaceEditorRoute
              games={[game()]}
              isSaving={false}
              roles={[role(1), role(2)]}
              statusByRole={new Map()}
              t={t}
              workspaces={[workspace()]}
              onSave={onSave}
            />
          )
        }
      ],
      { initialEntries: ["/workspaces/workspace-1/edit"] }
    );

    const { container, unmount } = render(
      <ConfirmationProvider>
        <RouterProvider router={router} />
      </ConfirmationProvider>
    );
    const preview = container.querySelector<HTMLElement>("[data-workspace-layout-preview]");
    const resizeHandle = screen.getByRole("button", { name: "Resize column divider 1" });
    if (!preview) throw new Error("Expected workspace preview.");
    setBounds(preview, 0, 0, 1000, 500);

    expect(resizeHandle.className).toContain("touch-none");
    fireEvent.pointerDown(resizeHandle, { button: 0, clientX: 500, clientY: 250, pointerId: 7 });
    fireEvent.pointerMove(window, { clientX: 600, clientY: 250, pointerId: 7 });
    fireEvent.pointerMove(window, { clientX: 700, clientY: 250, pointerId: 7 });

    expect(requestFrame).toHaveBeenCalledOnce();
    expect(addEventListener.mock.calls.some(([eventName, _listener, options]) =>
      eventName === "pointermove" &&
      typeof options === "object" &&
      options !== null &&
      options.passive === true
    )).toBe(true);
    const firstFrame = frames.get(1);
    frames.delete(1);
    act(() => firstFrame?.(0));

    const firstSlot = container.querySelector<HTMLElement>("[data-workspace-slot-index='0']");
    expect(firstSlot?.parentElement?.style.width).toBe("70%");

    fireEvent.pointerMove(window, { clientX: 800, clientY: 250, pointerId: 7 });
    expect(requestFrame).toHaveBeenCalledTimes(2);
    fireEvent.pointerUp(window, { clientX: 800, clientY: 250, pointerId: 7 });
    expect(cancelFrame).toHaveBeenCalledWith(2);
    expect(frames.size).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    const savedWidths = onSave.mock.calls[0][0].slots
      .map((slot: LaunchWorkspace["slots"][number]) => slot.rect.width);
    expect(savedWidths[0]).toBeCloseTo(0.8);
    expect(savedWidths[1]).toBeCloseTo(0.2);

    fireEvent.pointerDown(resizeHandle, { button: 0, clientX: 800, clientY: 250, pointerId: 8 });
    fireEvent.pointerMove(window, { clientX: 650, clientY: 250, pointerId: 8 });
    expect(frames.has(3)).toBe(true);
    unmount();
    expect(cancelFrame).toHaveBeenCalledWith(3);
    expect(frames.size).toBe(0);
  });

  it("shows the complete workspace help when creating a workspace", () => {
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

    const workspaceHelps = container.querySelectorAll("[data-workspace-help]");
    expect(workspaceHelps).toHaveLength(3);
    expect(workspaceHelps[0].textContent).toContain("Editing roles and layout");
    expect(workspaceHelps[1].textContent).toContain("Launching the workspace");
    expect(workspaceHelps[2].textContent).toContain("While running");
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
    localStorageSyncKeys: [],
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
    notes: "",
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z"
  };
}

function workspace(): LaunchWorkspace {
  return {
    id: "workspace-1",
    name: "Party",
    template: "two_columns",
    slots: [
      { id: "slot-1", roleId: "role-1", rect: { x: 0, y: 0, width: 0.5, height: 1 } },
      { id: "slot-2", roleId: "role-2", rect: { x: 0.5, y: 0, width: 0.5, height: 1 } }
    ],
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z"
  };
}

function setBounds(element: HTMLElement, left: number, top: number, width: number, height: number): void {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      bottom: top + height,
      height,
      left,
      right: left + width,
      top,
      width,
      x: left,
      y: top,
      toJSON: () => ({})
    })
  });
}

function pointerDrag(source: HTMLElement, target: HTMLElement, pointerId: number): void {
  vi.mocked(document.elementFromPoint).mockReturnValue(target);
  fireEvent.pointerDown(source, {
    button: 0,
    clientX: 20,
    clientY: 120,
    isPrimary: true,
    pointerId
  });
  fireEvent.pointerMove(window, {
    clientX: 120,
    clientY: 120,
    isPrimary: true,
    pointerId
  });
  fireEvent.pointerUp(window, {
    clientX: 120,
    clientY: 120,
    isPrimary: true,
    pointerId
  });
}
