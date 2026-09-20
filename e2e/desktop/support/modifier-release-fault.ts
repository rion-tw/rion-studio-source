import { browser } from "@wdio/globals";

/** One exact Role's next Alt-up is omitted before page delivery. Test-only fault. */
export async function modifierReleaseFault(url: string, action: "arm" | "read" | "clear"): Promise<boolean> {
  return browser.electron.execute((electron, expectedUrl, operation) => {
    const state = globalThis as typeof globalThis & {
      __rionModifierReleaseFault?: { id: number; dropped: boolean; clear: () => void };
    };
    const current = state.__rionModifierReleaseFault;
    if (operation === "read") return current?.dropped === true;
    if (operation === "clear") {
      current?.clear(); delete state.__rionModifierReleaseFault; return true;
    }
    if (current) throw new Error("A modifier release fault is already armed.");
    const matches = electron.webContents.getAllWebContents().filter(contents => contents.getURL() === expectedUrl);
    if (matches.length !== 1) throw new Error("The modifier release fault requires one exact Role document.");
    const contents = matches[0]!;
    const fault = { id: contents.id, dropped: false, clear: () => {
      contents.removeListener("before-input-event", listener);
      contents.removeListener("did-start-navigation", cancel);
      contents.removeListener("destroyed", cancel);
    } };
    const cancel = () => { fault.clear(); delete state.__rionModifierReleaseFault; };
    const listener = (event: Electron.Event, input: Electron.Input) => {
      if (input.type !== "keyUp" || input.code !== "AltLeft") return;
      event.preventDefault(); fault.dropped = true; fault.clear();
    };
    state.__rionModifierReleaseFault = fault;
    contents.on("before-input-event", listener);
    contents.once("did-start-navigation", cancel);
    contents.once("destroyed", cancel);
    return false;
  }, url, action);
}
