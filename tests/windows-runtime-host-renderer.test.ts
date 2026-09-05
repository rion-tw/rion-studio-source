// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WindowsRuntimeHostProjection } from
  "../src/shared/windowsRuntimeHost";

const windowId = "10000000-0000-4000-8000-000000000001";
const targetWindowId = "10000000-0000-4000-8000-000000000002";
const firstTabId = "20000000-0000-4000-8000-000000000001";
const secondTabId = "20000000-0000-4000-8000-000000000002";

function pointer(
  type: string,
  input: Readonly<{ button?: number; clientX: number; clientY?: number }>
): PointerEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    button: input.button ?? 0,
    clientX: input.clientX,
    clientY: input.clientY ?? 10
  });
  Object.defineProperties(event, {
    isPrimary: { value: true },
    pointerId: { value: 7 }
  });
  return event as PointerEvent;
}

describe("Windows runtime-host renderer", () => {
  beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = `
      <header data-runtime-toolbar>
        <div data-runtime-tabs></div>
        <div data-runtime-window-controls></div>
      </header>
      <div data-runtime-reveal-edge></div>
      <div data-runtime-workspace-dividers></div>
    `;
  });

  it("renders only visible tabs and submits real drag/menu actions", async () => {
    const submit = vi.fn();
    let project!: (projection: WindowsRuntimeHostProjection) => void;
    Object.assign(window, {
      rionStudioWindowsRuntimeHost: {
        onProjection: (listener: typeof project) => {
          project = listener;
          return () => undefined;
        },
        submit
      }
    });
    const captured = new Set<number>();
    HTMLElement.prototype.setPointerCapture = vi.fn((pointerId: number) => {
      captured.add(pointerId);
    });
    HTMLElement.prototype.hasPointerCapture = vi.fn((pointerId: number) =>
      captured.has(pointerId)
    );
    HTMLElement.prototype.releasePointerCapture = vi.fn((pointerId: number) => {
      captured.delete(pointerId);
    });

    await import("../src/renderer/src/runtime-windows-host");
    project({
      activeTabId: firstTabId,
      alwaysShowToolbarInFullScreen: false,
      contentBounds: { height: 600, width: 900, x: 0, y: 40 },
      fullscreen: false,
      lifecycleEpoch: 4,
      moveTargets: [{
        name: "Target Window",
        windowGeneration: 3,
        windowId: targetWindowId
      }],
      projectionRevision: 5,
      tabs: [
        {
          active: true,
          hidden: false,
          name: "First",
          phase: "ready",
          tabId: firstTabId
        },
        {
          active: false,
          hidden: false,
          name: "Second",
          phase: "ready",
          tabId: secondTabId
        },
        {
          active: false,
          hidden: true,
          name: "Hidden",
          phase: "dormant",
          tabId: "20000000-0000-4000-8000-000000000003"
        }
      ],
      toolbarVisible: true,
      topologyRevision: 8,
      windowGeneration: 2,
      windowId,
      workspaceDividers: [{
        attemptGeneration: "attempt-1",
        axis: "vertical",
        bounds: { height: 600, width: 12, x: 444, y: 40 },
        dividerIndex: 0,
        tabId: firstTabId,
        visible: true
      }]
    });

    const dividerLayer = document.querySelector<HTMLElement>(
      "[data-runtime-workspace-dividers]"
    )!;
    const divider = document.querySelector<HTMLButtonElement>(
      "button.runtime-workspace-divider:not([hidden])"
    )!;
    divider.dispatchEvent(pointer("pointerdown", { clientX: 450 }));
    divider.dispatchEvent(pointer("pointermove", { clientX: 522 }));
    expect(dividerLayer.dataset.dragging).toBe("true");
    expect(divider.dataset.dragging).toBe("true");
    dividerLayer.dispatchEvent(pointer("pointerup", { clientX: 522 }));
    expect(dividerLayer.dataset.dragging).toBe("false");
    expect(divider.dataset.dragging).toBe("false");
    expect(submit).toHaveBeenLastCalledWith(expect.objectContaining({
      phase: "end",
      pointerSequence: 3,
      type: "workspaceDividerPointer"
    }));

    const items = [...document.querySelectorAll<HTMLElement>(".runtime-tab")];
    expect(items.map((item) => item.dataset.tabId)).toEqual([
      firstTabId,
      secondTabId
    ]);
    items[0]!.getBoundingClientRect = () => ({
      bottom: 30,
      height: 30,
      left: 0,
      right: 100,
      toJSON: () => undefined,
      top: 0,
      width: 100,
      x: 0,
      y: 0
    });
    items[1]!.getBoundingClientRect = () => ({
      bottom: 30,
      height: 30,
      left: 100,
      right: 200,
      toJSON: () => undefined,
      top: 0,
      width: 100,
      x: 100,
      y: 0
    });
    const second = document.querySelector<HTMLElement>(
      `[data-runtime-tab-activate][data-tab-id='${secondTabId}']`
    )!;
    second.dispatchEvent(pointer("pointerdown", { clientX: 150 }));
    second.dispatchEvent(pointer("pointermove", { clientX: 10 }));
    second.dispatchEvent(pointer("pointerup", { clientX: 10 }));
    expect(submit).toHaveBeenLastCalledWith(expect.objectContaining({
      beforeTabId: firstTabId,
      orderedVisibleTabIds: [secondTabId, firstTabId],
      tabId: secondTabId,
      type: "reorderTab"
    }));

    items[0]!.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      clientX: 20,
      clientY: 20
    }));
    const reload = document.querySelector<HTMLButtonElement>(
      "[data-runtime-tab-menu-action='reloadTab']"
    )!;
    reload.click();
    expect(submit).toHaveBeenLastCalledWith({
      lifecycleEpoch: 4,
      projectionRevision: 5,
      tabId: firstTabId,
      topologyRevision: 8,
      type: "reloadTab",
      windowGeneration: 2,
      windowId
    });
    items[0]!.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      clientX: 20,
      clientY: 20
    }));
    const move = document.querySelector<HTMLButtonElement>(
      `[data-runtime-tab-menu-action='moveTab']` +
      `[data-target-window-id='${targetWindowId}']`
    )!;
    move.click();
    expect(submit).toHaveBeenLastCalledWith(expect.objectContaining({
      tabId: firstTabId,
      targetWindowGeneration: 3,
      targetWindowId,
      type: "moveTab"
    }));
    expect(document.documentElement.dataset.runtimeLifecycleEpoch).toBe("4");
    expect(document.documentElement.dataset.runtimeResizeEventCount).toBe("0");
  });
});
