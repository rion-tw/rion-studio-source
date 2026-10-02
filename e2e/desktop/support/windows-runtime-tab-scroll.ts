import { browser } from "@wdio/globals";

/** Bring an exact tab into view using the visible overflow buttons before acting. */
export async function revealWindowsRuntimeTab(tabId: string): Promise<void> {
  const inspect = () => browser.execute(id => {
    const tab = document.querySelector<HTMLElement>(`.runtime-tab[data-tab-id='${id}']`);
    const row = tab?.parentElement;
    if (!tab || !row) throw new Error("The exact tab is missing from its scrolling strip");
    const bounds = tab.getBoundingClientRect(); const viewport = row.getBoundingClientRect();
    if (bounds.width > viewport.width + 1) throw new Error("The tab is wider than its visible strip");
    const direction = bounds.left < viewport.left - 1 ? "scrollLeft" :
      bounds.right > viewport.right + 1 ? "scrollRight" : null;
    const control = direction ? document.querySelector<HTMLButtonElement>(`[data-runtime-toolbar-action='${direction}']`) : null;
    const rect = control?.getBoundingClientRect();
    const point = rect ? { x: Math.floor(rect.x + rect.width / 2), y: Math.floor(rect.y + rect.height / 2) } : null;
    if (direction) {
      const hit = point && document.elementFromPoint(point.x, point.y);
      if (!control || control.hidden || control.disabled || !hit || !control.contains(hit)) {
        throw new Error("The required visible tab overflow control is unavailable");
      }
    }
    return { direction, point, scrollLeft: row.scrollLeft,
      steps: Math.ceil(row.scrollWidth / Math.max(120, row.clientWidth * 0.75)) + 1 };
  }, tabId);
  let state = await inspect();
  const limit = state.steps;
  for (let step = 0; state.direction && step < limit; step++) {
    await browser.action("pointer", { parameters: { pointerType: "mouse" } })
      .move({ origin: "viewport", ...state.point! }).down({ button: 0 }).up({ button: 0 }).perform(true);
    const previous = state.scrollLeft;
    await browser.waitUntil(async () => {
      state = await inspect();
      return state.direction === null || Math.abs(state.scrollLeft - previous) > 1;
    }, { timeout: 3_000, timeoutMsg: "The visible overflow click did not scroll its tab strip" });
  }
  if (state.direction) throw new Error("Visible overflow clicks did not reveal the exact tab");
}
