import { workspaceWebChromeCopy } from "../src/electron/main/workspaceWebStatus";
import { describe, expect, it } from "vitest";

import {
  canonicalWorkspaceWebUrl,
  parseWorkspaceWebChromeAction,
  parseWorkspaceWebChromeState
} from "../src/shared/workspaceWebChrome";

describe("Workspace Web chrome shared contract", () => {
  it("canonicalizes only credential-free HTTP(S) destinations", () => {
    expect(canonicalWorkspaceWebUrl("fixture.test/path"))
      .toBe("https://fixture.test/path");
    expect(canonicalWorkspaceWebUrl("https://fixture.test/path"))
      .toBe("https://fixture.test/path");
    expect(canonicalWorkspaceWebUrl("file:///tmp/nope")).toBeNull();
    expect(canonicalWorkspaceWebUrl("https://user:secret@fixture.test"))
      .toBeNull();
  });

  it("accepts exact canonical actions and rejects extra or malformed fields", () => {
    expect(parseWorkspaceWebChromeAction({
      surfaceId: "surface-a",
      generation: 1,
      type: "navigate",
      url: "https://fixture.test/path"
    })).toEqual({
      surfaceId: "surface-a",
      generation: 1,
      type: "navigate",
      url: "https://fixture.test/path"
    });
    expect(parseWorkspaceWebChromeAction({
      surfaceId: "surface-a",
      generation: 1,
      type: "ready",
      extra: true
    })).toBeNull();
    expect(parseWorkspaceWebChromeAction({
      surfaceId: "surface-a",
      generation: 0,
      type: "ready"
    })).toBeNull();
    expect(parseWorkspaceWebChromeAction({
      surfaceId: "surface-a",
      generation: 1,
      type: "navigate",
      url: "fixture.test/path"
    })).toBeNull();
  });

  it("accepts only exact authoritative state with a canonical URL", () => {
    const state = {
      surfaceId: "surface-a",
      generation: 3,
      url: "https://fixture.test/start",
      canGoBack: false,
      canGoForward: true,
      resolvedTheme: "light",
      language: "en", labels: workspaceWebChromeCopy("en")
    };
    expect(parseWorkspaceWebChromeState(state)).toEqual(state);
    expect(parseWorkspaceWebChromeState({ ...state, resolvedTheme: "dark" }))
      .toEqual({ ...state, resolvedTheme: "dark" });
    for (const resolvedTheme of [undefined, null, "system", "", 1]) {
      expect(parseWorkspaceWebChromeState({ ...state, resolvedTheme })).toBeNull();
    }
    expect(parseWorkspaceWebChromeState({ ...state, generation: -1 })).toBeNull();
    expect(parseWorkspaceWebChromeState({ ...state, url: "fixture.test/start" }))
      .toBeNull();
    expect(parseWorkspaceWebChromeState({ ...state, unexpected: "field" }))
      .toBeNull();
    for (const language of [undefined, null, "fr", {}, 1]) {
      expect(parseWorkspaceWebChromeState({ ...state, language })).toBeNull();
    }
    for (const labels of [undefined, null, {}, { ...state.labels, back: "" },
      { ...state.labels, back: 1 }, { ...state.labels, back: "x".repeat(513) },
      { ...state.labels, injected: "extra" }]) {
      expect(parseWorkspaceWebChromeState({ ...state, labels })).toBeNull();
    }
    for (const language of ["en", "zh-TW", "zh-CN", "ja"] as const) {
      const localized = { ...state, language, labels: workspaceWebChromeCopy(language) };
      expect(parseWorkspaceWebChromeState(localized)).toEqual(localized);
    }
  });
});
