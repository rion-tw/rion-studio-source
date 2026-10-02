// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntimeTabToolbar } from "../src/renderer/src/runtimeTabToolbar";
import { runtimeTabStripLabels } from "../src/renderer/src/i18n";

describe("Windows tab overflow controls", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(["window", "observer"])("keeps the selected tab visible after a %s resize and permits manual scrolling", (source) => {
    let resize = () => {};
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { resize = callback; }
      observe() {}
    });
    document.body.innerHTML = '<header><div id="tabs"><div data-tab-id="selected"></div></div></header>';
    const tabs = document.getElementById("tabs")!;
    let width = 600;
    Object.defineProperties(tabs, { clientWidth: { get: () => width }, scrollWidth: { get: () => 600 } });
    tabs.getBoundingClientRect = () => new DOMRect(0, 0, width, 30);
    (tabs.firstElementChild as HTMLElement).getBoundingClientRect = () => new DOMRect(400 - tabs.scrollLeft, 0, 200, 30);
    const toolbar = createRuntimeTabToolbar(tabs, vi.fn(), vi.fn());
    toolbar.render(runtimeTabStripLabels("en"), "selected");
    expect(tabs.scrollLeft).toBe(0);
    // Repeated topology/layout projections retain the selection for resize.
    toolbar.render(runtimeTabStripLabels("en"), "selected");
    width = 300;
    if (source === "window") window.dispatchEvent(new Event("resize")); else resize();
    expect(tabs.scrollLeft).toBe(300);
    document.querySelector<HTMLButtonElement>("[data-runtime-toolbar-action='scrollLeft']")!.click();
    tabs.dispatchEvent(new Event("scroll"));
    toolbar.render(runtimeTabStripLabels("en"), "selected");
    expect(tabs.scrollLeft).toBe(75);
  });

  it("keeps hidden tabs reachable and updates scrolling and launcher labels", () => {
    document.body.innerHTML = '<header><div id="tabs"></div></header>';
    const tabs = document.getElementById("tabs")!;
    let width = 200;
    Object.defineProperties(tabs, { clientWidth: { get: () => width }, scrollWidth: { get: () => 600 } });
    const open = vi.fn(); const geometry = vi.fn();
    const toolbar = createRuntimeTabToolbar(tabs, open, geometry);
    toolbar.render(runtimeTabStripLabels("zh-TW"), null);
    const control = (name: string) => document.querySelector<HTMLButtonElement>(`[data-runtime-toolbar-action='${name}']`)!;
    expect(control("scrollLeft").disabled).toBe(true);
    expect(control("scrollRight").hidden).toBe(false);
    control("scrollRight").click();
    expect(tabs.scrollLeft).toBe(150);
    expect(control("scrollLeft").disabled).toBe(false);
    expect(geometry).toHaveBeenCalledOnce();
    tabs.scrollLeft = 400; tabs.dispatchEvent(new Event("scroll"));
    expect(control("scrollRight").disabled).toBe(true);
    control("openLauncher").click();
    expect(open).toHaveBeenCalledOnce();
    expect(control("openLauncher").getAttribute("aria-label")).toBe("開啟角色或工作區");
    width = 700; window.dispatchEvent(new Event("resize"));
    expect(control("scrollLeft").hidden).toBe(true);
    expect(control("scrollRight").hidden).toBe(true);
    expect(control("openLauncher").hidden).toBe(false);
  });

  it("removes scroll controls when the tabs fit in the space reclaimed from the controls", () => {
    document.body.innerHTML = '<header><div id="tabs"></div></header>';
    const tabs = document.getElementById("tabs")!;
    let available = 200;
    const controls = () => [...document.querySelectorAll<HTMLButtonElement>("[data-runtime-toolbar-action^='scroll']")];
    Object.defineProperties(tabs, {
      clientWidth: { get: () => available - controls().filter(control => !control.hidden).length * 30 },
      scrollWidth: { get: () => 300 }
    });
    const toolbar = createRuntimeTabToolbar(tabs, vi.fn(), vi.fn());
    for (const control of controls()) Object.defineProperty(control, "offsetWidth", { get: () => control.hidden ? 0 : 30 });
    toolbar.render(runtimeTabStripLabels("en"), null);
    expect(controls().every(control => !control.hidden)).toBe(true);
    tabs.scrollLeft = 100;
    available = 320;
    window.dispatchEvent(new Event("resize"));
    expect(controls().every(control => control.hidden && control.disabled)).toBe(true);
    expect(tabs.scrollLeft).toBe(0);
  });
});
