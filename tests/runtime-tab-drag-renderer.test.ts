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
  return { toolbar, tabs, tab, drag, submit, buttonClick, captured: () => capture,
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

function stripFixture() {
  const f = fixture();
  const rect = (x: number, y: number, width: number, height: number) => () =>
    ({ x, y, left: x, top: y, width, height, right: x + width, bottom: y + height, toJSON: () => ({}) }) as DOMRect;
  f.tabs.getBoundingClientRect = rect(0, 0, 600, 30);
  const item = document.createElement("div");
  item.className = "runtime-tab"; item.dataset.tabId = "a";
  item.getBoundingClientRect = rect(0, 0, 180, 30);
  item.append(f.tab); f.tabs.replaceChildren(item);
  const move = (x: number, y = 10, buttons = 1) => {
    const event = pointer("pointermove", x);
    Object.defineProperties(event, { clientY: { value: y }, buttons: { value: buttons } });
    f.toolbar.dispatchEvent(event);
  };
  return { ...f, item, move, ghost: () => document.querySelector<HTMLElement>(".runtime-tab-drag-ghost") };
}

it("paints a pointer-following preview while the drag stays over the strip, without submitting more", () => {
  const f = stripFixture();
  f.tab.dispatchEvent(pointer("pointerdown"));
  f.move(20);
  expect(f.submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: "tabDragStart", tabId: "a" }));
  const ghost = f.ghost()!;
  expect(ghost.getAttribute("aria-hidden")).toBe("true");
  expect(ghost.dataset.tabId).toBeUndefined();
  expect(f.tabs.contains(ghost)).toBe(false);
  expect(f.item.hasAttribute("data-drag-source")).toBe(true);
  expect(f.captured()).toBe(true);
  f.move(300);
  expect(ghost.style.transform).toBe("translate3d(300px, 0px, 0)");
  f.move(590);
  expect(ghost.style.transform).toBe("translate3d(420px, 0px, 0)");
  f.toolbar.dispatchEvent(pointer("pointerup", 590));
  expect(f.ghost()).toBeNull();
  expect(f.item.hasAttribute("data-drag-source")).toBe(false);
  expect(f.captured()).toBe(false);
  expect(f.submit).toHaveBeenCalledOnce();
});

it.each(["leave", "released", "blur"] as const)("hands the gesture back to native ownership on %s", reason => {
  const f = stripFixture();
  f.tab.dispatchEvent(pointer("pointerdown"));
  f.move(20);
  if (reason === "leave") f.move(20, 80);
  else if (reason === "released") f.move(40, 10, 0);
  else window.dispatchEvent(new Event("blur"));
  expect(f.ghost()).toBeNull();
  expect(f.captured()).toBe(false);
  expect(f.submit).toHaveBeenCalledOnce();
});

it("re-anchors after a Core reorder rebuild and ends when the tab leaves this window", () => {
  const f = stripFixture();
  const drag = createRuntimeTabDrag({ toolbar: document.createElement("div"), tabs: f.tabs,
    current: () => null, submit: vi.fn(), closeMenu: vi.fn() });
  expect(() => drag.sync({ windowGeneration: 3, tabs: [] } as unknown as WindowsRuntimeHostProjection)).not.toThrow();
  f.tab.dispatchEvent(pointer("pointerdown"));
  f.move(20);
  const rebuilt = f.item.cloneNode(true) as HTMLElement;
  rebuilt.removeAttribute("data-drag-source");
  rebuilt.getBoundingClientRect = f.item.getBoundingClientRect;
  f.tabs.replaceChildren(rebuilt);
  f.drag.sync({ windowGeneration: 3, tabs: [{ tabId: "a", hidden: false }] } as unknown as WindowsRuntimeHostProjection);
  expect(rebuilt.hasAttribute("data-drag-source")).toBe(true);
  expect(f.ghost()).not.toBeNull();
  f.drag.sync({ windowGeneration: 3, tabs: [] } as unknown as WindowsRuntimeHostProjection);
  expect(f.ghost()).toBeNull();
  expect(f.captured()).toBe(false);
});
