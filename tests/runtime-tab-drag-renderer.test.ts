// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createRuntimeTabDrag } from "../src/renderer/src/runtimeTabDrag";
import type { WindowsRuntimeHostProjection } from "../src/shared/windowsRuntimeHost";

afterEach(() => document.body.replaceChildren());

function pointer(type: string, x = 0, pointerId = 7) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x });
  Object.defineProperties(event, { pointerId: { value: pointerId }, isPrimary: { value: true } });
  return event;
}

function fixture() {
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
  const drag = createRuntimeTabDrag({ toolbar, tabs, current: () => current, submit, closeMenu: vi.fn() });
  const tab = document.createElement("button"); tab.className = "runtime-tab"; tabs.append(tab); drag.bind(tab, "a");
  const buttonClick = vi.fn();
  tab.addEventListener("click", buttonClick);
  return { toolbar, tabs, tab, submit, buttonClick, captured: () => capture,
    project: (patch: Partial<WindowsRuntimeHostProjection>) => { current = { ...current, ...patch }; } };
}

it("keeps pointer ownership through DOM replacement and uses the latest projection for native admission", () => {
  const f = fixture();
  f.tab.dispatchEvent(pointer("pointerdown"));
  f.project({ projectionRevision: 2 });
  f.tabs.replaceChildren(document.createElement("button"));
  f.toolbar.dispatchEvent(pointer("pointermove", 20));
  expect(f.submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: "tabDragStart", projectionRevision: 2, tabId: "a" }));
  f.toolbar.dispatchEvent(pointer("pointerup", 20));
  f.toolbar.dispatchEvent(pointer("pointermove", 40));
  expect(f.submit).toHaveBeenCalledOnce(); expect(f.captured()).toBe(false);
});

it("activates once on captured pointerup below the drag threshold, using the latest projection", () => {
  const f = fixture();
  f.tab.dispatchEvent(pointer("pointerdown"));
  f.project({ projectionRevision: 2 });
  f.tabs.replaceChildren(document.createElement("button"));
  f.toolbar.dispatchEvent(pointer("pointermove", 3));
  f.toolbar.dispatchEvent(pointer("pointerup", 3));
  expect(f.submit).toHaveBeenCalledExactlyOnceWith({ type: "activateTab", windowId: "source", tabId: "a", projectionRevision: 2 });
  const click = pointer("click", 3);
  f.toolbar.dispatchEvent(click);
  expect(click.defaultPrevented).toBe(true);
  expect(f.captured()).toBe(false);
});

it.each([false, true])("suppresses the matching pointer click but preserves keyboard/AX activation after drag=%s", drag => {
  const f = fixture();
  f.tab.dispatchEvent(pointer("pointerdown"));
  if (drag) f.toolbar.dispatchEvent(pointer("pointermove", 20));
  f.toolbar.dispatchEvent(pointer("pointerup"));
  f.tab.dispatchEvent(pointer("click", 0, -1));
  f.tab.click();
  expect(f.buttonClick).toHaveBeenCalledTimes(2);
  f.tab.dispatchEvent(pointer("click"));
  expect(f.buttonClick).toHaveBeenCalledTimes(2);
  expect(f.submit).toHaveBeenCalledOnce();
});

it("does not suppress a subsequent pointer press on a different toolbar control", () => {
  const f = fixture();
  f.tab.dispatchEvent(pointer("pointerdown"));
  f.toolbar.dispatchEvent(pointer("pointermove", 20));
  f.toolbar.dispatchEvent(pointer("pointerup", 20));
  const close = document.createElement("button"); f.toolbar.append(close);
  const closeClick = vi.fn(); close.addEventListener("click", closeClick);
  close.dispatchEvent(pointer("pointerdown"));
  close.dispatchEvent(pointer("pointerup"));
  close.dispatchEvent(pointer("click"));
  expect(closeClick).toHaveBeenCalledOnce();
});

it.each(["pointercancel", "lostpointercapture"])("cancels without activation on %s", type => {
  const f = fixture();
  f.tab.dispatchEvent(pointer("pointerdown"));
  f.toolbar.dispatchEvent(pointer(type));
  f.toolbar.dispatchEvent(pointer("pointerup"));
  expect(f.submit).not.toHaveBeenCalled();
  expect(f.captured()).toBe(false);
});

it("ignores termination from another pointer", () => {
  const f = fixture();
  f.tab.dispatchEvent(pointer("pointerdown"));
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) f.toolbar.dispatchEvent(pointer(type, 0, 8));
  expect(f.captured()).toBe(true);
  expect(f.submit).not.toHaveBeenCalled();
  f.toolbar.dispatchEvent(pointer("pointerup"));
  expect(f.submit).toHaveBeenCalledOnce();
});

it.each(["pointerup", "pointermove"])("rejects a stale generation or removed tab on %s", type => {
  for (const patch of [{ windowGeneration: 4 }, { tabs: [] }]) {
    const f = fixture();
    f.tab.dispatchEvent(pointer("pointerdown"));
    f.project(patch);
    f.toolbar.dispatchEvent(pointer(type, 20));
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.captured()).toBe(false);
  }
});
