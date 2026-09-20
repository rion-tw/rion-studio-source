import type { WindowsRuntimeHostCommand, WindowsRuntimeHostProjection } from "../../shared/windowsRuntimeHost";

/** The stable toolbar owns pre-threshold capture. Once admitted, the native
 * desktop stream owns the gesture independently of DOM/projection replacement. */
export function createRuntimeTabDrag(input: Readonly<{
  toolbar: HTMLElement;
  tabs: HTMLElement;
  current: () => WindowsRuntimeHostProjection | null;
  submit: (command: WindowsRuntimeHostCommand) => void;
  suppressClick: (tabId: string) => void;
  closeMenu: () => void;
}>) {
  let active: { tabId: string; pointerId: number; x: number; y: number;
    ratio: { x: number; y: number }; windowGeneration: number } | null = null;
  const release = () => {
    const previous = active;
    active = null;
    if (previous && input.toolbar.hasPointerCapture(previous.pointerId)) input.toolbar.releasePointerCapture(previous.pointerId);
  };
  input.toolbar.addEventListener("pointermove", event => {
    if (!active || active.pointerId !== event.pointerId) return;
    if (Math.abs(event.clientX - active.x) + Math.abs(event.clientY - active.y) < 8) return;
    const gesture = active;
    const current = input.current();
    release();
    if (!current || current.windowGeneration !== gesture.windowGeneration || !current.tabs.some(t => t.tabId === gesture.tabId)) return;
    input.suppressClick(gesture.tabId);
    input.submit({ type: "tabDragStart", windowGeneration: current.windowGeneration, projectionRevision: current.projectionRevision,
      windowId: current.windowId, tabId: gesture.tabId, sessionId: crypto.randomUUID(), ratio: gesture.ratio });
    event.preventDefault();
  });
  input.toolbar.addEventListener("pointerup", release);
  input.toolbar.addEventListener("pointercancel", release);
  input.toolbar.addEventListener("lostpointercapture", release);
  const geometry = () => {
    const current = input.current();
    if (!current) return;
    const bounds = (element: Element) => {
      const r = element.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    input.submit({ type: "tabDragGeometry", windowId: current.windowId,
      projectionRevision: current.projectionRevision, row: bounds(input.tabs),
      tabs: [...input.tabs.querySelectorAll<HTMLElement>(".runtime-tab[data-tab-id]")]
        .map(element => ({ tabId: element.dataset.tabId!, bounds: bounds(element) })) });
  };
  const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(geometry);
  resize?.observe(input.tabs);
  return {
    geometry,
    bind(element: HTMLElement, tabId: string) {
      element.addEventListener("pointerdown", event => {
        const current = input.current();
        if (!event.isPrimary || event.button !== 0 || active || !current) return;
        input.closeMenu();
        const rect = element.closest(".runtime-tab")!.getBoundingClientRect();
        const fraction = (v: number) => Math.max(0, Math.min(1, v));
        active = { tabId, pointerId: event.pointerId, x: event.clientX, y: event.clientY,
          windowGeneration: current.windowGeneration,
          ratio: { x: fraction((event.clientX - rect.x) / Math.max(1, rect.width)),
            y: fraction((event.clientY - rect.y) / Math.max(1, rect.height)) } };
        input.toolbar.setPointerCapture(event.pointerId);
      });
    }
  };
}
