// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ConfirmationProvider } from "../src/renderer/src/components/ConfirmationDialog";
import MacroEditorRoute from "../src/renderer/src/features/macros/MacroModal";
import type { Translator } from "../src/renderer/src/i18n";
import en from "../src/renderer/src/i18n/en.json";
import type { Game, Macro, Role } from "../src/shared/types";

const scrollIntoView = vi.fn();

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class ResizeObserverMock {
    readonly callback: ResizeObserverCallback;

    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
    }

    disconnect(): void {}
    observe(target: Element): void {
      this.callback([{
        contentRect: { width: 640 },
        target
      } as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    unobserve(): void {}
  });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scrollIntoView
  });
});

afterEach(() => {
  cleanup();
  scrollIntoView.mockReset();
});

afterAll(() => vi.unstubAllGlobals());

describe("macro mind map UI", () => {
  it("renders after the step editor while help follows execution roles and locates the selected root step", async () => {
    const { container } = renderEditor([macro()]);
    const mindMap = container.querySelector<HTMLElement>("[data-macro-mind-map='inline']");
    const help = container.querySelector<HTMLElement>("[data-macro-help-list]");

    expect(mindMap).toBeTruthy();
    expect(mindMap?.previousElementSibling?.textContent).toContain("Steps");
    expect(mindMap?.nextElementSibling).toBeNull();
    expect(help?.parentElement?.tagName).toBe("ASIDE");
    expect(help?.previousElementSibling?.textContent).toContain("Execution roles");
    expect(mindMap?.textContent).not.toContain("Steps: 1 · Macro calls: 0");

    const mapStep = await waitFor(() => {
      const element = container.querySelector<HTMLElement>(
        "[data-macro-mind-map-current-step='step-1']"
      );
      expect(element).toBeTruthy();
      return element as HTMLElement;
    });
    expect(mapStep.style.height).toBe("");
    expect(mapStep.className).not.toContain("h-full");
    expect(mapStep.querySelector(".line-clamp-2")).toBeNull();
    expect(mapStep.closest<HTMLElement>(".react-flow__node")?.style.height).toBe("");
    fireEvent.click(mapStep);

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
    expect(screen.getByTestId("macro-step-step-1").className).toContain("ring-inset");
  });

  it("expands each called macro from the read-only canvas", async () => {
    const child = macro({
      id: "child",
      name: "Child",
      steps: [{ id: "child-step", type: "delay", ms: 250 }]
    });
    const root = macro({
      steps: [{ id: "call", type: "macro", macroId: child.id, callMode: "trigger" }]
    });
    const { container } = renderEditor([root, child]);

    const inlineMap = container.querySelector<HTMLElement>("[data-macro-mind-map='inline']");
    if (!inlineMap) throw new Error("Inline mind map was not rendered.");
    const canvas = inlineMap.querySelector<HTMLElement>("[data-macro-mind-map-canvas]");
    const collapsedHeight = Number.parseFloat(canvas?.style.height ?? "0");
    expect(inlineMap.querySelectorAll("[data-macro-mind-map-node-kind='macroRoot']")).toHaveLength(1);

    const expandButton = inlineMap.querySelector<HTMLButtonElement>("button[aria-label='Expand Child']");
    if (!expandButton) throw new Error("Child expand button was not rendered.");
    fireEvent.click(expandButton);

    await waitFor(() => {
      expect(inlineMap.querySelectorAll("[data-macro-mind-map-node-kind='macroRoot']")).toHaveLength(2);
      expect(Number.parseFloat(canvas?.style.height ?? "0")).toBeGreaterThan(collapsedHeight);
    });
    expect(inlineMap.querySelector("button[aria-label='Collapse Child']")).toBeTruthy();
    expect(inlineMap.textContent).toContain("Trigger and continue");
    expect(inlineMap.textContent).toContain("Enabled");
  });

  it("removes the title and keeps only the blurred compact controls sticky", () => {
    const { container } = renderEditor([macro()]);
    const inlineMap = container.querySelector<HTMLElement>("[data-macro-mind-map='inline']");
    if (!inlineMap) throw new Error("Inline mind map was not rendered.");
    const controls = inlineMap.querySelector<HTMLElement>("[data-macro-mind-map-controls]");
    const floatingControls = inlineMap.querySelector<HTMLElement>(".macro-mind-map-floating-controls");
    const canvasSurface = inlineMap.querySelector<HTMLElement>("[data-macro-mind-map-surface]");
    const step = inlineMap.querySelector<HTMLElement>("[data-macro-mind-map-step-type='key']");

    expect(inlineMap.querySelector(".macro-mind-map-header")).toBeNull();
    expect(controls?.className).toContain("sticky");
    expect(controls?.className).toContain("top-0");
    expect(floatingControls).toBeTruthy();
    expect(controls?.nextElementSibling).toBe(canvasSurface);
    expect(inlineMap.textContent).not.toContain("Live preview");
    expect(inlineMap.textContent).toContain("Key");
    expect(inlineMap.querySelector(".macro-mind-map-node-rail")).toBeNull();
    expect(step?.querySelectorAll(".macro-mind-map-handle")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Zoom in" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Zoom out" })).toBeTruthy();
    expect(inlineMap.querySelector(".react-flow__controls")).toBeNull();
  });

  it("lets hover override selection focus and clears focus from the pane", async () => {
    const root = macro({
      steps: [
        { id: "first", type: "key", code: "F1" },
        { id: "second", type: "delay", ms: 100 },
        { id: "third", type: "key", code: "F3" }
      ]
    });
    const { container } = renderEditor([root]);
    const nodeForStep = (stepId: string): HTMLElement => {
      const card = container.querySelector<HTMLElement>(
        `[data-macro-mind-map-current-step='${stepId}']`
      );
      const node = card?.closest<HTMLElement>(".react-flow__node");
      if (!node) throw new Error(`Mind map node ${stepId} was not rendered.`);
      return node;
    };
    const secondNode = nodeForStep("second");
    const thirdNode = nodeForStep("third");
    const settingsNode = container.querySelector<HTMLElement>(
      "[data-macro-mind-map-node-kind='macroSettings']"
    )?.closest<HTMLElement>(".react-flow__node");
    if (!settingsNode) throw new Error("Settings node was not rendered.");

    fireEvent.mouseEnter(secondNode);
    await waitFor(() => expect(thirdNode.className).toContain("macro-mind-map-node-dimmed"));
    expect(settingsNode.className).toContain("macro-mind-map-node-dimmed");
    expect(secondNode.className).toContain("macro-mind-map-node-active");

    fireEvent.mouseLeave(secondNode);
    await waitFor(() => expect(thirdNode.className).not.toContain("macro-mind-map-node-dimmed"));

    fireEvent.click(secondNode);
    await waitFor(() => expect(thirdNode.className).toContain("macro-mind-map-node-dimmed"));
    fireEvent.mouseEnter(settingsNode);
    await waitFor(() => expect(secondNode.className).toContain("macro-mind-map-node-dimmed"));
    fireEvent.mouseLeave(settingsNode);
    await waitFor(() => expect(secondNode.className).toContain("macro-mind-map-node-active"));

    const pane = container.querySelector<HTMLElement>(".react-flow__pane");
    if (!pane) throw new Error("Mind map pane was not rendered.");
    fireEvent.click(pane);
    await waitFor(() => expect(thirdNode.className).not.toContain("macro-mind-map-node-dimmed"));
    expect(screen.getByTestId("macro-step-second").className).not.toContain("ring-inset");
  });

  it("grows with long flows without offering fullscreen or forced fit controls", async () => {
    const smallRender = renderEditor([macro()]);
    const smallCanvas = smallRender.container.querySelector<HTMLElement>("[data-macro-mind-map-canvas]");
    await waitFor(() => expect(smallCanvas?.dataset.macroMindMapZoom).toBeTruthy());
    const smallHeight = Number.parseFloat(smallCanvas?.style.height ?? "0");

    expect(screen.queryByRole("button", { name: "Open map fullscreen" })).toBeNull();
    expect(document.querySelector("[data-macro-mind-map-dialog]")).toBeNull();
    expect(smallRender.container.querySelector(".react-flow__controls-fitview")).toBeNull();
    expect(screen.getByRole("button", { name: "Reset map view" })).toBeTruthy();
    smallRender.unmount();

    const steps = Array.from({ length: 21 }, (_, index) => ({
      code: "F2",
      id: `step-${index}`,
      type: "key" as const
    }));
    const longRender = renderEditor([macro({ steps })]);
    const longCanvas = longRender.container.querySelector<HTMLElement>("[data-macro-mind-map-canvas]");
    await waitFor(() => {
      expect(Number.parseFloat(longCanvas?.style.height ?? "0")).toBeGreaterThan(smallHeight + 1_000);
    });
    const autoZoom = Number(longCanvas?.dataset.macroMindMapZoom);

    expect(autoZoom).toBeGreaterThanOrEqual(0.75);
    expect(autoZoom).toBeLessThanOrEqual(1);
  });

  it("resets the inline viewport while leaving the editor available", () => {
    const { container } = renderEditor([macro()]);
    const inlineMap = container.querySelector<HTMLElement>("[data-macro-mind-map='inline']");
    if (!inlineMap) throw new Error("Inline mind map was not rendered.");
    const resetButton = inlineMap.querySelector<HTMLButtonElement>("button[aria-label='Reset map view']");
    if (!resetButton) throw new Error("Reset map view button was not rendered.");
    fireEvent.click(resetButton);

    expect(screen.getByRole("button", { name: "Save changes" })).toBeTruthy();
  });
});

const t: Translator = (key) => en[key];

function renderEditor(macros: Macro[]) {
  const router = createMemoryRouter([
    {
      path: "/macros/:id/edit",
      element: (
        <MacroEditorRoute
          games={[game()]}
          isSaving={false}
          macros={macros}
          roles={[role()]}
          t={t}
          onSave={vi.fn()}
        />
      )
    }
  ], { initialEntries: ["/macros/macro-1/edit"] });
  return render(
    <ConfirmationProvider>
      <RouterProvider router={router} />
    </ConfirmationProvider>
  );
}

function game(): Game {
  return {
    createdAt: "2026-08-11T00:00:00.000Z",
    defaultLaunchUrl: "https://example.test/play",
    id: "game-1",
    name: "Test game",
    source: "custom",
    updatedAt: "2026-08-11T00:00:00.000Z"
  };
}

function role(): Role {
  return {
    createdAt: "2026-08-11T00:00:00.000Z",
    gameId: "game-1",
    id: "role-1",
    launchUrl: "https://example.test/play",
    name: "Main role",
    notes: "",
    updatedAt: "2026-08-11T00:00:00.000Z"
  };
}

function macro(overrides: Partial<Macro> = {}): Macro {
  return {
    createdAt: "2026-08-11T00:00:00.000Z",
    enabled: true,
    id: "macro-1",
    name: "Root macro",
    repeat: { type: "once" },
    roleIds: ["role-1"],
    shortcutSourceScope: { type: "all_execution_roles" },
    steps: [{ id: "step-1", type: "key", code: "F2" }],
    updatedAt: "2026-08-11T00:00:00.000Z",
    ...overrides
  };
}
