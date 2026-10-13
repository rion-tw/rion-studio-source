import type { App, BaseWindow, Input, WebContents } from "electron";

/** Own reserved tab chords before a document or Electron's menu fallback sees them. */
export function installWindowsRuntimeTabInput(input: {
  app: Pick<App, "on">;
  contents: () => WebContents[];
  windowFor: (contents: WebContents) => BaseWindow | null;
  isRuntimeWindow: (window: BaseWindow) => boolean;
  activateAdjacent: (direction: "next" | "previous", window: BaseWindow) => void;
}): void {
  const attached = new WeakSet<WebContents>();
  const observedWindows = new WeakSet<BaseWindow>();
  // A selection can move the matching keyup to another WebContents in this host.
  // This tracks only consumption of the physical Tab edge, never Core topology.
  const heldTabs = new WeakSet<BaseWindow>();
  const attach = (contents: WebContents) => {
    if (contents.isDestroyed() || attached.has(contents)) return;
    attached.add(contents);
    contents.on("before-input-event", (event, key: Input) => {
      if (key.code !== "Tab" || !["keyDown", "keyUp"].includes(key.type) ||
          contents.isDestroyed() || !contents.isFocused()) return;
      const window = input.windowFor(contents);
      if (!window || window.isDestroyed() || !window.isFocused() || !input.isRuntimeWindow(window)) return;
      if (!observedWindows.has(window)) {
        observedWindows.add(window);
        window.on("blur", () => heldTabs.delete(window));
        window.on("closed", () => heldTabs.delete(window));
      }
      const chord = key.control && !key.alt && !key.meta;
      if (key.type === "keyUp") {
        const held = heldTabs.delete(window);
        if (chord || held) event.preventDefault();
        return;
      }
      if (key.isAutoRepeat && heldTabs.has(window)) {
        event.preventDefault();
        return;
      }
      if (!chord) {
        heldTabs.delete(window);
        return;
      }
      event.preventDefault();
      heldTabs.add(window);
      if (!key.isAutoRepeat) input.activateAdjacent(key.shift ? "previous" : "next", window);
    });
  };
  input.app.on("web-contents-created", (_event, contents) => attach(contents));
  for (const contents of input.contents()) attach(contents);
}
