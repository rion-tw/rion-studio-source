// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { createRuntimeTabDrag } from "../src/renderer/src/runtimeTabDrag";
import type { WindowsRuntimeHostProjection } from "../src/shared/windowsRuntimeHost";

it("keeps pointer ownership through DOM replacement and uses the latest projection for native admission", () => {
  const toolbar = document.createElement("div");
  const tabs = document.createElement("div"); toolbar.append(tabs);
  document.body.append(toolbar);
  let capture = false;
  toolbar.setPointerCapture = () => { capture = true; };
  toolbar.hasPointerCapture = () => capture;
  toolbar.releasePointerCapture = () => { capture = false; };
  let current = { windowId: "source", windowGeneration: 3, projectionRevision: 1,
    tabs: [{ tabId: "a" }] } as unknown as WindowsRuntimeHostProjection;
  const submit = vi.fn();
  const drag = createRuntimeTabDrag({ toolbar, tabs, current: () => current, submit, suppressClick: vi.fn(), closeMenu: vi.fn() });
  const tab = document.createElement("button"); tab.className = "runtime-tab"; tabs.append(tab); drag.bind(tab, "a");
  const pointer = (type: string, x: number) => {
    const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x });
    Object.defineProperties(event, { pointerId: { value: 7 }, isPrimary: { value: true } });
    return event;
  };
  tab.dispatchEvent(pointer("pointerdown", 0));
  current = { ...current, projectionRevision: 2 };
  tabs.replaceChildren(document.createElement("button"));
  toolbar.dispatchEvent(pointer("pointermove", 20));
  expect(submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: "tabDragStart", projectionRevision: 2, tabId: "a" }));
  toolbar.dispatchEvent(pointer("pointerup", 20));
  toolbar.dispatchEvent(pointer("pointermove", 40));
  expect(submit).toHaveBeenCalledOnce(); expect(capture).toBe(false);
});
