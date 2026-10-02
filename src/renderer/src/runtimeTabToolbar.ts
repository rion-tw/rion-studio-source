import type { runtimeTabStripLabels } from "./i18n";

/** Overflow is presentation-only: scroll/resize events update affordances and
 * native drag geometry; the Core projection remains the sole tab-order owner. */
export function createRuntimeTabToolbar(tabs: HTMLElement, open: () => void, geometry: () => void) {
  const button = (name: string, path: string, click: () => void) => {
    const control = document.createElement("button");
    control.type = "button";
    control.className = "runtime-toolbar-button";
    control.dataset.runtimeToolbarAction = name;
    control.innerHTML = `<svg aria-hidden="true" viewBox="0 0 16 16"><path d="${path}" /></svg>`;
    control.addEventListener("click", click);
    return control;
  };
  const scroll = (direction: number) => {
    tabs.scrollLeft += direction * Math.max(120, tabs.clientWidth * 0.75);
    update();
    geometry();
  };
  const left = button("scrollLeft", "m10 3-5 5 5 5", () => scroll(-1));
  const right = button("scrollRight", "m6 3 5 5-5 5", () => scroll(1));
  const add = button("openLauncher", "M8 2v12M2 8h12", open);
  tabs.before(left);
  tabs.after(right, add);
  function update() {
    const available = tabs.clientWidth + left.offsetWidth + right.offsetWidth;
    const overflow = tabs.scrollWidth > available + 1;
    left.hidden = right.hidden = !overflow;
    if (!overflow) tabs.scrollLeft = 0;
    left.disabled = !overflow || tabs.scrollLeft <= 1;
    right.disabled = !overflow || tabs.scrollLeft + tabs.clientWidth >= tabs.scrollWidth - 1;
  }
  tabs.addEventListener("scroll", () => { update(); geometry(); });
  tabs.addEventListener("wheel", event => {
    if (event.ctrlKey || tabs.scrollWidth <= tabs.clientWidth) return;
    tabs.scrollLeft += Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    event.preventDefault();
  }, { passive: false });
  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
  observer?.observe(tabs);
  window.addEventListener("resize", update);
  return { render(labels: ReturnType<typeof runtimeTabStripLabels>, activeTabId: string | null) {
    for (const [control, label] of [[left, labels.scrollLeft], [right, labels.scrollRight], [add, labels.openLauncher]] as const) {
      control.setAttribute("aria-label", label);
      control.title = label;
    }
    update();
    const active = [...tabs.children].find(child => (child as HTMLElement).dataset.tabId === activeTabId) as HTMLElement | undefined;
    if (active) {
      const row = tabs.getBoundingClientRect();
      const rect = active.getBoundingClientRect();
      if (rect.left < row.left) tabs.scrollLeft -= row.left - rect.left;
      else if (rect.right > row.right) tabs.scrollLeft += rect.right - row.right;
    }
    update();
  } };
}
