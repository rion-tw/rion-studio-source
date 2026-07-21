import { describe, expect, it, vi } from "vitest";

import {
  installSessionStorageSeedAtDocumentStart,
  type SessionStorageSeedWindow
} from "../src/preload/sessionStorageSeed";

describe("embedded sessionStorage document-start seed", () => {
  it("requests and writes the current main-frame origin exactly once", () => {
    const currentWindow = createMainFrame("https://game.example.test");
    const setItem = vi.fn();
    const requestSeed = vi.fn(() => ({ activeCharacter: "character-1", gameSession: "opaque-token" }));

    installSessionStorageSeedAtDocumentStart(currentWindow, { setItem }, requestSeed);

    expect(requestSeed).toHaveBeenCalledOnce();
    expect(requestSeed).toHaveBeenCalledWith("https://game.example.test");
    expect(setItem).toHaveBeenCalledTimes(2);
    expect(setItem).toHaveBeenCalledWith("activeCharacter", "character-1");
    expect(setItem).toHaveBeenCalledWith("gameSession", "opaque-token");
  });

  it("does not seed an iframe, invalid reply, or failed internal IPC", () => {
    const top = createMainFrame("https://game.example.test");
    const iframe: SessionStorageSeedWindow = {
      location: { origin: "https://game.example.test" } as Pick<Location, "origin">,
      top
    };
    const setItem = vi.fn();
    const requestSeed = vi.fn(() => ({ gameSession: "opaque-token" }));

    installSessionStorageSeedAtDocumentStart(iframe, { setItem }, requestSeed);
    expect(requestSeed).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();

    installSessionStorageSeedAtDocumentStart(createMainFrame("https://game.example.test"), { setItem }, () => ({ bad: 1 }));
    installSessionStorageSeedAtDocumentStart(createMainFrame("https://game.example.test"), { setItem }, () => {
      throw new Error("IPC unavailable");
    });
    expect(setItem).not.toHaveBeenCalled();
  });
});

function createMainFrame(origin: string): SessionStorageSeedWindow {
  const currentWindow: SessionStorageSeedWindow = {
    location: { origin } as Pick<Location, "origin">,
    top: null
  };
  currentWindow.top = currentWindow;
  return currentWindow;
}
