import { describe, expect, it, vi } from "vitest";

import {
  installDocumentStorageSeedAtDocumentStart,
  type DocumentStorageSeedWindow
} from "../src/preload/documentStorageSeed";

describe("embedded document storage seed", () => {
  it("writes localStorage and sessionStorage in the current main frame and acknowledges counts", () => {
    const currentWindow = createMainFrame("https://game.example.test");
    const localSetItem = vi.fn();
    const sessionSetItem = vi.fn();
    const acknowledge = vi.fn();
    const requestSeed = vi.fn(() => ({
      localStorage: { language: "zh-TW" },
      sessionStorage: { activeCharacter: "character-1", gameSession: "opaque-token" }
    }));

    installDocumentStorageSeedAtDocumentStart(
      currentWindow,
      () => ({ setItem: localSetItem }),
      () => ({ setItem: sessionSetItem }),
      requestSeed,
      acknowledge
    );

    expect(requestSeed).toHaveBeenCalledWith("https://game.example.test");
    expect(localSetItem).toHaveBeenCalledWith("language", "zh-TW");
    expect(sessionSetItem).toHaveBeenCalledTimes(2);
    expect(acknowledge).toHaveBeenCalledWith({
      localStorageApplied: true,
      localStorageKeyCount: 1,
      origin: "https://game.example.test",
      sessionStorageApplied: true,
      sessionStorageKeyCount: 2
    });
  });

  it("reports partial storage failure without exposing keys or values", () => {
    const acknowledge = vi.fn();
    installDocumentStorageSeedAtDocumentStart(
      createMainFrame("https://game.example.test"),
      () => ({ setItem: vi.fn(() => { throw new Error("quota exceeded"); }) }),
      () => ({ setItem: vi.fn() }),
      () => ({ localStorage: { language: "zh-TW" }, sessionStorage: { session: "opaque" } }),
      acknowledge
    );

    expect(acknowledge).toHaveBeenCalledWith(expect.objectContaining({
      localStorageApplied: false,
      localStorageKeyCount: 0,
      sessionStorageApplied: true,
      sessionStorageKeyCount: 1
    }));
  });

  it("reports a document-start Storage getter failure and still applies the other area", () => {
    const acknowledge = vi.fn();
    installDocumentStorageSeedAtDocumentStart(
      createMainFrame("https://game.example.test"),
      () => { throw new Error("Storage is not ready"); },
      () => ({ setItem: vi.fn() }),
      () => ({ localStorage: { language: "zh-TW" }, sessionStorage: { session: "opaque" } }),
      acknowledge
    );

    expect(acknowledge).toHaveBeenCalledWith(expect.objectContaining({
      localStorageApplied: false,
      localStorageKeyCount: 0,
      sessionStorageApplied: true,
      sessionStorageKeyCount: 1
    }));
  });

  it("ignores iframes, invalid replies, and failed internal IPC", () => {
    const iframe: DocumentStorageSeedWindow = {
      location: { origin: "https://game.example.test" } as Pick<Location, "origin">
    };
    const setItem = vi.fn();
    const requestSeed = vi.fn(() => ({ sessionStorage: { session: "opaque" } }));
    const acknowledge = vi.fn();

    installDocumentStorageSeedAtDocumentStart(
      iframe,
      () => ({ setItem }),
      () => ({ setItem }),
      requestSeed,
      acknowledge,
      false
    );
    installDocumentStorageSeedAtDocumentStart(
      createMainFrame("https://game.example.test"),
      () => ({ setItem }),
      () => ({ setItem }),
      () => ({ bad: 1 }),
      acknowledge
    );
    installDocumentStorageSeedAtDocumentStart(
      createMainFrame("https://game.example.test"),
      () => ({ setItem }),
      () => ({ setItem }),
      () => { throw new Error("IPC unavailable"); },
      acknowledge
    );

    expect(requestSeed).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    expect(acknowledge).not.toHaveBeenCalled();
  });
});

function createMainFrame(origin: string): DocumentStorageSeedWindow {
  return { location: { origin } as Pick<Location, "origin"> };
}
