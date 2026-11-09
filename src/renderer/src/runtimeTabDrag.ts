import type { WindowsRuntimeHostCommand, WindowsRuntimeHostProjection } from "../../shared/windowsRuntimeHost";

/** The stable toolbar owns pre-threshold capture. Once admitted, the native
 * desktop stream owns the gesture independently of DOM/projection replacement. */
export function createRuntimeTabDrag(input: Readonly<{
  toolbar: HTMLElement;
  tabs: HTMLElement;
  current: () => WindowsRuntimeHostProjection | null;
  submit: (command: WindowsRuntimeHostCommand) => void;
  closeMenu: () => void;
}>) {
  let active: { tabId: string; pointerId: number; x: number; y: number;
    ratio: { x: number; y: number }; windowGeneration: number } | null = null;
  let suppressedPointer: number | null = null;
  // Captured pointerup/click targets the stable toolbar, even if a projection
  // replaced the original button. Pointerup owns activation; keyboard/AX click
  // remains on the button. Never carry suppression into another pointer press.
  input.toolbar.addEventListener("pointerdown", () => {
    if (!active) suppressedPointer = null;
  }, true);
  input.toolbar.addEventListener("click", event => {
    if (suppressedPointer === null || event.pointerId !== suppressedPointer) return;
    suppressedPointer = null;
    event.preventDefault();
    event.stopPropagation();
  }, true);
  const releaseCapture = (pointerId: number) => {
    if (input.toolbar.hasPointerCapture(pointerId)) input.toolbar.releasePointerCapture(pointerId);
  };
  const release = () => {
    const previous = active;
    active = null;
    if (previous) releaseCapture(previous.pointerId);
  };
  // Presentation only: a pointer-following copy of the dragged tab while the
  // pointer stays over this strip. It never submits; Core and the native
  // desktop stream still own order, hit-testing, tear-out and terminality.
  let visual: { tabId: string; pointerId: number; generation: number; ghost: HTMLElement;
    width: number; grabX: number; offsetY: number; x: number; y: number } | null = null;
  const items = () => [...input.tabs.querySelectorAll<HTMLElement>(".runtime-tab[data-tab-id]")];
  const markSource = () => {
    for (const item of items()) item.toggleAttribute("data-drag-source", item.dataset.tabId === visual?.tabId);
  };
  const endVisual = () => {
    const previous = visual;
    visual = null;
    if (!previous) return;
    previous.ghost.remove();
    markSource();
    releaseCapture(previous.pointerId);
  };
  const place = (x: number, y: number): boolean => {
    if (!visual) return false;
    const row = input.tabs.getBoundingClientRect();
    // Leaving the strip hands the gesture to the native tear-out preview.
    if (x < row.left || x >= row.right || y < row.top || y >= row.bottom) return false;
    visual.x = x;
    visual.y = y;
    const left = Math.max(row.left, Math.min(x - visual.grabX, row.right - visual.width));
    visual.ghost.style.transform = `translate3d(${left}px, ${row.top + visual.offsetY}px, 0)`;
    return true;
  };
  const beginVisual = (gesture: NonNullable<typeof active>, event: PointerEvent) => {
    const source = items().find(item => item.dataset.tabId === gesture.tabId);
    if (!source) { releaseCapture(gesture.pointerId); return; }
    const rect = source.getBoundingClientRect();
    const ghost = source.cloneNode(true) as HTMLElement;
    for (const element of [ghost, ...ghost.querySelectorAll<HTMLElement>("*")]) {
      for (const name of Object.keys(element.dataset)) delete element.dataset[name];
      element.removeAttribute("id");
    }
    ghost.classList.add("runtime-tab-drag-ghost");
    ghost.setAttribute("aria-hidden", "true");
    ghost.inert = true;
    ghost.style.width = `${rect.width}px`;
    document.body.append(ghost);
    visual = { tabId: gesture.tabId, pointerId: gesture.pointerId, generation: gesture.windowGeneration, ghost,
      width: rect.width, grabX: rect.width * gesture.ratio.x, offsetY: rect.y - input.tabs.getBoundingClientRect().y, x: 0, y: 0 };
    markSource();
    if (!place(event.clientX, event.clientY)) endVisual();
  };
  input.toolbar.addEventListener("pointermove", event => {
    if (visual?.pointerId === event.pointerId) {
      if ((event.buttons & 1) === 0 || !place(event.clientX, event.clientY)) endVisual();
      return;
    }
    if (!active || active.pointerId !== event.pointerId) return;
    if (Math.abs(event.clientX - active.x) + Math.abs(event.clientY - active.y) < 8) return;
    const gesture = active;
    const current = input.current();
    active = null;
    if (!current || current.windowGeneration !== gesture.windowGeneration || !current.tabs.some(t => t.tabId === gesture.tabId)) {
      releaseCapture(gesture.pointerId);
      return;
    }
    input.submit({ type: "tabDragStart", windowGeneration: current.windowGeneration, projectionRevision: current.projectionRevision,
      windowId: current.windowId, tabId: gesture.tabId, sessionId: crypto.randomUUID(), ratio: gesture.ratio });
    // The stable toolbar keeps capture only while it paints the in-strip preview.
    beginVisual(gesture, event);
    event.preventDefault();
  });
  input.toolbar.addEventListener("pointerup", event => {
    if (visual?.pointerId === event.pointerId) { endVisual(); return; }
    if (!active || active.pointerId !== event.pointerId || event.button !== 0) return;
    const gesture = active;
    release();
    const current = input.current();
    if (!current || current.windowGeneration !== gesture.windowGeneration || !current.tabs.some(t => t.tabId === gesture.tabId)) return;
    input.submit({ type: "activateTab", projectionRevision: current.projectionRevision,
      windowId: current.windowId, tabId: gesture.tabId });
  });
  const cancel = (event: PointerEvent) => {
    if (visual?.pointerId === event.pointerId) endVisual();
    if (active?.pointerId === event.pointerId) release();
  };
  input.toolbar.addEventListener("pointercancel", cancel);
  input.toolbar.addEventListener("lostpointercapture", cancel);
  window.addEventListener("blur", endVisual);
  const geometry = () => {
    const current = input.current();
    if (!current) return;
    const row = input.tabs.getBoundingClientRect();
    const bounds = (element: HTMLElement) => {
      const r = element.getBoundingClientRect();
      // A reorder slide paints tabs translated; native hit-testing needs their layout slot.
      const animated = element !== input.tabs && typeof element.getAnimations === "function" &&
        element.getAnimations().length > 0;
      const x = animated ? row.x + input.tabs.clientLeft + element.offsetLeft - input.tabs.scrollLeft : r.x;
      return { x, y: r.y, width: r.width, height: r.height };
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
    /** Re-anchors the preview after a projection rebuilt the strip. */
    sync(projection: WindowsRuntimeHostProjection) {
      if (!visual) return;
      if (projection.windowGeneration !== visual.generation ||
          !projection.tabs.some(tab => tab.tabId === visual!.tabId && !tab.hidden)) {
        endVisual();
        return;
      }
      markSource();
      if (!place(visual.x, visual.y)) endVisual();
    },
    bind(element: HTMLElement, tabId: string) {
      element.addEventListener("pointerdown", event => {
        const current = input.current();
        if (!event.isPrimary || event.button !== 0 || active || !current) return;
        endVisual();
        suppressedPointer = event.pointerId;
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
