import { describe, expect, it, vi } from "vitest";
import { executeWindowsRuntimeTabShortcut } from "../src/electron/main/windowsRuntimeTabShortcut";

function harness() {
  const window = { windowId: "window", parentNativeHostId: 7, windowGeneration: 3,
    topologyRevision: 9, activeTabId: "b", tabIds: ["a", "c", "hidden", "b"], visible: true, focused: true };
  const logical = { windowId: "window", windowGeneration: 3, revision: 9, activeTabId: "b",
    tabs: [{ id: "a", hidden: false }, { id: "c", hidden: false }, { id: "hidden", hidden: true }, { id: "b", hidden: false }] };
  const invoke = vi.fn(async (command: { type: string }) => command.type === "appSnapshot"
    ? { logicalWindows: [logical] } : { status: "applied" });
  const focusedWindow = { id: 7, isDestroyed: () => false };
  const run = (direction: "next" | "previous" = "next") => executeWindowsRuntimeTabShortcut({
    core: { invoke } as never, native: () => ({ windows: [{ ...window }] }) as never,
    direction, focusedWindow
  });
  return { window, logical, invoke, run, focusedWindow };
}

describe("Windows native adjacent-tab shortcut", () => {
  it.each(["next", "previous"] as const)("selects the %s non-hidden Core tab while no document is ready", async direction => {
    const h = harness();
    await h.run(direction);
    expect(h.invoke.mock.calls).toHaveLength(2);
    expect(h.invoke.mock.calls[1]![0]).toMatchObject({ type: "embeddedTabActivate", tabId: direction === "next" ? "a" : "c",
      windowId: "window", windowGeneration: 3, topologyRevision: 9 });
  });
  it.each(["launcher", "hidden", "unfocused", "destroyed"])("does not route a %s host into runtime activation", async state => {
    const h = harness();
    if (state === "launcher") h.focusedWindow.id = 1;
    if (state === "hidden") h.window.visible = false;
    if (state === "unfocused") h.window.focused = false;
    if (state === "destroyed") h.focusedWindow.isDestroyed = () => true;
    await h.run();
    expect(h.invoke).not.toHaveBeenCalled();
  });
  it.each(["generation", "revision", "selection", "focus"])("rejects an in-flight %s change without choosing another target", async field => {
    const h = harness();
    h.invoke.mockImplementationOnce(async () => {
      if (field === "generation") h.window.windowGeneration++;
      if (field === "revision") h.logical.revision++;
      if (field === "selection") h.logical.activeTabId = "a";
      if (field === "focus") h.window.focused = false;
      return { logicalWindows: [h.logical] };
    });
    await expect(h.run()).rejects.toMatchObject({ code: "ELECTRON_RUNTIME_TAB_SHORTCUT_STALE" });
    expect(h.invoke).toHaveBeenCalledTimes(1);
  });
  it("retains Core terminal failure instead of claiming a successful selection", async () => {
    const h = harness();
    h.invoke.mockImplementationOnce(async () => ({ logicalWindows: [h.logical] }));
    h.invoke.mockImplementationOnce(async () => ({ status: "superseded" }));
    await expect(h.run()).rejects.toMatchObject({ code: "ELECTRON_RUNTIME_TAB_SHORTCUT_NOT_APPLIED" });
  });
});
