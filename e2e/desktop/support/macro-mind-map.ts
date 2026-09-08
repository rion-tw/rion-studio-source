import { $, $$, browser, expect } from "@wdio/globals";

import { scrollLayoutControlIntoView } from "./ui";

interface MindMapFrame {
  activeIds: string[];
  nodes: { id: string; visibility: string; x: number; y: number; width: number; height: number }[];
  edges: { id: string; path: string | null }[];
}

/** Real pointer input catches hover -> missing dimensions -> hidden -> leave loops. */
export async function exerciseMacroMindMapHover(): Promise<void> {
  const canvas = await $("[data-macro-mind-map-canvas]");
  await canvas.waitForDisplayed({ timeout: 10_000 });
  await browser.waitUntil(async () => await browser.execute(() => {
    const map = document.querySelector("[data-macro-mind-map='inline']");
    const items = [...(map?.querySelectorAll<HTMLElement>(".react-flow__node") ?? [])];
    return items.length >= 3 && items.every((item) => getComputedStyle(item).visibility === "visible")
      && Boolean(map?.querySelector(".react-flow__edge-path"));
  }), { timeout: 10_000, timeoutMsg: "Mind map did not finish its initial measurement" });
  const nodes = await $$("[data-macro-mind-map] .react-flow__node");
  const nodeCount = await nodes.length;
  expect(nodeCount).toBeGreaterThanOrEqual(3);
  const edgeCount = await $$("[data-macro-mind-map] .react-flow__edge").length;
  expect(edgeCount).toBeGreaterThan(0);
  for (const node of nodes) {
    const id = await node.getAttribute("data-id");
    if (!id) throw new Error("Mind map node has no identity");
    await scrollLayoutControlIntoView(node);
    await node.moveTo();
    await browser.waitUntil(async () => (await node.getAttribute("class") ?? "")
      .split(" ").includes("macro-mind-map-node-active"), {
      timeout: 10_000, timeoutMsg: `Native pointer did not enter mind map node ${id}`
    }).catch(async (error: unknown) => {
      const diagnostic = await browser.execute(() => {
        const page = window as unknown as Record<string, unknown>;
        return { target: page.__rionMindMapPointerTarget,
          events: page.__rionMindMapPointerEvents,
          hovered: [...document.querySelectorAll(":hover")].map(element => ({
            tag: element.tagName, id: element.getAttribute("data-id"), class: element.className
          })) };
      });
      throw new Error(`Native mind map pointer evidence: ${JSON.stringify(diagnostic)}`, { cause: error });
    });
    const frames = await browser.executeAsync((done: (frames: MindMapFrame[]) => void) => {
      const samples: MindMapFrame[] = [];
      const sample = (): void => {
        const map = document.querySelector("[data-macro-mind-map='inline']")!;
        samples.push({
          activeIds: [...map.querySelectorAll<HTMLElement>(".macro-mind-map-node-active")]
            .map((element) => element.dataset.id ?? ""),
          nodes: [...map.querySelectorAll<HTMLElement>(".react-flow__node")].map((element) => {
            const { x, y, width, height } = element.getBoundingClientRect();
            return { id: element.dataset.id ?? "", visibility: getComputedStyle(element).visibility, x, y, width, height };
          }),
          edges: [...map.querySelectorAll<SVGGElement>(".react-flow__edge")].map((element) => ({
            id: element.dataset.id ?? "",
            path: element.querySelector(".react-flow__edge-path")?.getAttribute("d") ?? null
          }))
        });
        if (samples.length === 30) done(samples);
        else requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }) as MindMapFrame[];
    expect(frames).toHaveLength(30);
    for (const frame of frames) {
      expect(frame.activeIds).toEqual([id]);
      expect(frame.nodes).toHaveLength(nodeCount);
      expect(frame.nodes.every((item) => item.visibility === "visible" && item.width > 0 && item.height > 0)).toBe(true);
      expect(frame.edges).toHaveLength(edgeCount);
      expect(frame.edges.every((edge) => Boolean(edge.path))).toBe(true);
      expect(frame).toEqual(frames[0]);
    }
  }
  // Leave the canvas before the existing click-selection assertions.
  await $(".app-main-sidebar").moveTo();
}
