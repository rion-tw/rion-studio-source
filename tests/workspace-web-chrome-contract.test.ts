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
      canGoForward: true
    };
    expect(parseWorkspaceWebChromeState(state)).toEqual(state);
    expect(parseWorkspaceWebChromeState({ ...state, generation: -1 })).toBeNull();
    expect(parseWorkspaceWebChromeState({ ...state, url: "fixture.test/start" }))
      .toBeNull();
    expect(parseWorkspaceWebChromeState({ ...state, unexpected: "field" }))
      .toBeNull();
  });
});
