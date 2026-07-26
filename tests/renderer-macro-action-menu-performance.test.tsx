// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import MacrosRoute from "../src/renderer/src/features/macros/MacrosRoute";
import { DEFAULT_MACRO_LIST_SORT } from "../src/renderer/src/features/macros/macroListUtils";
import type { Translator } from "../src/renderer/src/i18n";
import en from "../src/renderer/src/i18n/en.json";
import type { Macro, Role } from "../src/shared/types";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("macro action menu performance", () => {
  it("keeps the Studio run button enabled when the optional overlay is unavailable", () => {
    const onStartMacro = vi.fn();
    render(
      <MacrosRoute
        busyMacroIds={new Set()}
        busyRunKeys={new Set()}
        macroStatuses={[]}
        macroStatusByRun={new Map()}
        macros={[macro]}
        query=""
        roleFilterId=""
        roles={[role]}
        scrollPositionRef={{ current: 0 }}
        sort={DEFAULT_MACRO_LIST_SORT}
        statusByRole={new Map([[
          role.id,
          {
            roleId: role.id,
            state: "running",
            runtimeMode: "embedded",
            automationState: "ready",
            overlayState: "unavailable"
          }
        ]])}
        t={t}
        onCopyMacro={vi.fn()}
        onDeleteMacro={vi.fn()}
        onDeleteMacros={vi.fn().mockResolvedValue(false)}
        onEditMacro={vi.fn()}
        onNewMacro={vi.fn()}
        onQueryChange={vi.fn()}
        onRoleFilterChange={vi.fn()}
        onSortChange={vi.fn()}
        onStartMacro={onStartMacro}
        onStopMacro={vi.fn()}
      />
    );

    const run = screen.getByRole("button", { name: "Start" });
    expect(run.hasAttribute("disabled")).toBe(false);
    fireEvent.click(run);
    expect(onStartMacro).toHaveBeenCalledWith(macro.id);
  });

  it("coalesces captured scroll and resize positioning into one passive frame", () => {
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
    const { unmount } = render(
      <MacrosRoute
        busyMacroIds={new Set()}
        busyRunKeys={new Set()}
        macroStatuses={[]}
        macroStatusByRun={new Map()}
        macros={[macro]}
        query=""
        roleFilterId=""
        roles={[role]}
        scrollPositionRef={{ current: 0 }}
        sort={DEFAULT_MACRO_LIST_SORT}
        statusByRole={new Map([[role.id, { roleId: role.id, state: "running" }]])}
        t={t}
        onCopyMacro={vi.fn()}
        onDeleteMacro={vi.fn()}
        onDeleteMacros={vi.fn().mockResolvedValue(false)}
        onEditMacro={vi.fn()}
        onNewMacro={vi.fn()}
        onQueryChange={vi.fn()}
        onRoleFilterChange={vi.fn()}
        onSortChange={vi.fn()}
        onStartMacro={vi.fn()}
        onStopMacro={vi.fn()}
      />
    );
    const trigger = screen.getByRole("button", { name: "Macro actions" });
    const readTriggerBounds = vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue(bounds());

    fireEvent.click(trigger);
    expect(requestFrame).toHaveBeenCalledOnce();
    runFrame(frames, 1);
    readTriggerBounds.mockClear();

    window.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("resize"));

    expect(requestFrame).toHaveBeenCalledTimes(2);
    expect(frames.size).toBe(1);
    runFrame(frames, 2);
    expect(readTriggerBounds).toHaveBeenCalledOnce();
    expect(addEventListener.mock.calls).toContainEqual([
      "scroll",
      expect.any(Function),
      { capture: true, passive: true }
    ]);

    window.dispatchEvent(new Event("scroll"));
    expect(frames.has(3)).toBe(true);
    unmount();
    expect(cancelFrame).toHaveBeenCalledWith(3);
    expect(frames.size).toBe(0);
  });
});

function runFrame(frames: Map<number, FrameRequestCallback>, frameId: number): void {
  const callback = frames.get(frameId);
  frames.delete(frameId);
  act(() => callback?.(frameId * 16));
}

function bounds(): DOMRect {
  return {
    bottom: 48,
    height: 28,
    left: 100,
    right: 128,
    top: 20,
    width: 28,
    x: 100,
    y: 20,
    toJSON: () => ({})
  };
}

const t: Translator = (key) => en[key];

const role: Role = {
  id: "role-1",
  gameId: "game-1",
  name: "Main role",
  launchUrl: "https://example.test/play",
  notes: "",
  createdAt: "2026-07-15T00:00:00.000Z",
  updatedAt: "2026-07-15T00:00:00.000Z"
};

const macro: Macro = {
  id: "macro-1",
  enabled: true,
  name: "Auto heal",
  roleIds: [role.id],
  repeat: { type: "once" },
  steps: [{ id: "step-1", type: "key", code: "F2" }],
  createdAt: "2026-07-15T00:00:00.000Z",
  updatedAt: "2026-07-15T00:00:00.000Z"
};
