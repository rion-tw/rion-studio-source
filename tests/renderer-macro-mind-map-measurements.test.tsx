// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MacroFormState } from "../src/renderer/src/app/types";
import { MacroMindMapPanel } from "../src/renderer/src/features/macros/MacroMindMap";
import type { Translator } from "../src/renderer/src/i18n";
import en from "../src/renderer/src/i18n/en.json";
import type { Macro } from "../src/shared/types";

const observers = new Set<ResizeObserverMock>();
let stepHeight = 112;

class ResizeObserverMock {
  readonly targets = new Set<Element>();
  constructor(readonly callback: ResizeObserverCallback) { observers.add(this); }
  disconnect(): void { this.targets.clear(); }
  observe(target: Element): void { this.targets.add(target); }
  unobserve(target: Element): void { this.targets.delete(target); }
  report(): void {
    this.callback([...this.targets].map((target) => ({
      target, contentRect: { width: 640, height: 480 }
    } as ResizeObserverEntry)), this as unknown as ResizeObserver);
  }
}

beforeEach(() => {
  stepHeight = 112;
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true, value: () => ({ x: 0, y: 0, width: 80, height: 16 })
  });
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  vi.stubGlobal("DOMMatrixReadOnly", class { readonly m22 = 1; });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("react-flow__node") ? 276 : 640;
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.querySelector("[data-macro-mind-map-node-kind='macroStep']") ? stepHeight : 148;
  });
});

afterEach(() => {
  cleanup();
  observers.clear();
  Reflect.deleteProperty(SVGElement.prototype, "getBBox");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function measure(): Promise<void> {
  await act(async () => { for (const observer of observers) observer.report(); });
}

const t: Translator = (key) => en[key];
const child: Macro = {
  createdAt: "2026-08-11T00:00:00.000Z", updatedAt: "2026-08-11T00:00:00.000Z",
  shortcutSourceScope: { type: "all_execution_roles" },
  enabled: true, id: "child", name: "Child", roleIds: [], repeat: { type: "once" },
  steps: [{ id: "nested", type: "delay", ms: 100 }]
};
const form: MacroFormState = {
  activationMode: "press", enabled: true, id: "root", name: "Root", roleIds: [],
  repeat: { type: "once" }, shortcutSourceScope: { type: "all_execution_roles" },
  steps: [
    { id: "call", type: "macro", macroId: "child", callMode: "trigger" },
    { id: "key", type: "key", code: "F2" }
  ]
};

function panel(draft = form) {
  return <MacroMindMapPanel form={draft} macros={[child]} roles={[]} t={t}
    onClearStepSelection={vi.fn()} onSelectStep={vi.fn()} />;
}

function nodes(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(".react-flow__node")];
}

function trackHiddenNodes(container: HTMLElement) {
  const hidden: string[] = [];
  const collect = (records: MutationRecord[]): void => {
    for (const record of records) {
      const node = record.target as HTMLElement;
      if (node.matches(".react-flow__node") && (
        node.style.visibility === "hidden" || /visibility:\s*hidden/.test(record.oldValue ?? "")
      )) hidden.push(node.dataset.id ?? "");
    }
  };
  const observer = new MutationObserver(collect);
  observer.observe(container, { subtree: true, attributes: true, attributeFilter: ["style"], attributeOldValue: true });
  return { finish: () => { collect(observer.takeRecords()); observer.disconnect(); return hidden; } };
}

describe("macro mind map measured dimensions", () => {
  it("never hides measured nodes during hover, selection, pane clearing or duplicate measurements", async () => {
    const { container } = render(panel());
    await measure();
    const original = nodes(container);
    await waitFor(() => expect(original.every((node) => node.style.visibility === "visible")).toBe(true));
    const transforms = original.map((node) => node.style.transform);
    const tracker = trackHiddenNodes(container);
    for (const node of original) {
      fireEvent.mouseEnter(node);
      await act(async () => {});
      expect(node.className).toContain("macro-mind-map-node-active");
      expect(nodes(container).every((item) => item.style.visibility === "visible")).toBe(true);
      fireEvent.click(node);
      fireEvent.mouseLeave(node);
    }
    fireEvent.click(container.querySelector(".react-flow__pane")!);
    await measure();
    expect(nodes(container)).toEqual(original);
    expect(original.map((node) => node.style.transform)).toEqual(transforms);
    expect(tracker.finish()).toEqual([]);
  });

  it("remeasures changed content and expanded children without hiding existing nodes", async () => {
    const { container, rerender } = render(panel());
    await measure();
    const key = container.querySelector<HTMLElement>("[data-id='root:step:key']")!;
    const oldPosition = key.style.transform;
    const tracker = trackHiddenNodes(container);
    rerender(panel({ ...form, name: "A longer edited macro name" }));
    stepHeight = 240;
    await measure();
    expect(key.style.transform).not.toBe(oldPosition);
    expect(tracker.finish()).toEqual([]);

    fireEvent.click(container.querySelector("button[aria-label='Expand Child']")!);
    await measure();
    expect(container.querySelectorAll("[data-macro-mind-map-node-kind='macroRoot']")).toHaveLength(2);
    expect(nodes(container).every((node) => node.style.visibility === "visible")).toBe(true);
    fireEvent.click(container.querySelector("button[aria-label='Collapse Child']")!);
    await measure();
    expect(container.querySelectorAll("[data-macro-mind-map-node-kind='macroRoot']")).toHaveLength(1);
    expect(nodes(container).every((node) => node.style.visibility === "visible")).toBe(true);
  });
});
