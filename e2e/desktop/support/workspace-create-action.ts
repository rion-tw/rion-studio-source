import { $, browser } from "@wdio/globals";

export async function clickWorkspaceCreateAction(): Promise<void> {
  let currentAction: Awaited<ReturnType<typeof $>> | undefined;
  let lastObservation: unknown;
  try {
    await browser.waitUntil(async () => {
      for (const label of ["New workspace", "Create workspace"] as const) {
        const action = await $(`button=${label}`);
        const exists = await action.isExisting();
        lastObservation = { label, elementId: action.elementId, exists };
        if (!exists) continue;
        const clickable = await action.isClickable();
        lastObservation = { label, elementId: action.elementId, exists, clickable };
        if (!clickable) return false;
        currentAction = action;
        return true;
      }
      return false;
    }, {
      timeout: 10_000,
      interval: browser.options.waitforInterval,
      timeoutMsg: "The Workspaces route has no current clickable create action"
    });
  } catch (error) {
    let currentDocument;
    const diagnosticErrors: unknown[] = [];
    try {
      // Read the current document, never the possibly retired WebElement.
      currentDocument = await browser.execute(() => ({
        route: location.hash, focused: document.hasFocus(), visibility: document.visibilityState,
        viewport: { width: innerWidth, height: innerHeight, scale: devicePixelRatio },
        controls: Array.from(document.querySelectorAll("button"))
          .filter(button => ["New workspace", "Create workspace"].includes(button.textContent?.trim() ?? ""))
          .slice(0, 4).map(button => {
            const bounds = button.getBoundingClientRect();
            const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
            return {
              label: button.textContent?.trim(), connected: button.isConnected, disabled: button.disabled,
              bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
              hitMatches: hit === button || Boolean(hit && button.contains(hit)),
              hit: hit ? { tag: hit.tagName, id: hit.id, role: hit.getAttribute("role") } : null
            };
          })
      }));
    } catch (observationError) {
      diagnosticErrors.push(observationError);
    }
    if (diagnosticErrors.length) {
      throw new AggregateError([error, ...diagnosticErrors], "Workspace create readiness and document observation failed.", { cause: error });
    }
    throw new Error(`Workspace create readiness failed: ${JSON.stringify({ lastObservation, currentDocument })}`, { cause: error });
  }
  if (!currentAction) throw new Error("The Workspaces route has no current create action");
  await currentAction.click();
}
