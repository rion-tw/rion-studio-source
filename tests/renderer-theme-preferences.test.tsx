// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RionStudioApi } from "../src/shared/api";
import { usePreferences } from "../src/renderer/src/hooks/usePreferences";

let mediaMatches = false;
const mediaListeners = new Set<() => void>();
const setRuntimeTheme = vi.fn(() => Promise.resolve());
const setOverlayLanguage = vi.fn(() => Promise.resolve());

function PreferenceProbe() {
  const preferences = usePreferences();
  return <output>{preferences.resolvedTheme}</output>;
}

beforeEach(() => {
  localStorage.clear();
  mediaMatches = false;
  mediaListeners.clear();
  setRuntimeTheme.mockClear();
  setOverlayLanguage.mockClear();
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    get matches() { return mediaMatches; },
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addEventListener: (_type: string, listener: () => void) => mediaListeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => mediaListeners.delete(listener),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn()
  })));
  window.rionStudio = {
    setOverlayLanguage,
    setRuntimeTheme
  } as unknown as RionStudioApi;
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "rionStudio");
  vi.unstubAllGlobals();
});

describe("renderer resolved theme synchronization", () => {
  it("updates the document and runtime when the system theme changes", async () => {
    render(<PreferenceProbe />);

    await waitFor(() => expect(setRuntimeTheme).toHaveBeenLastCalledWith("light"));
    expect(document.documentElement.dataset.theme).toBe("light");

    mediaMatches = true;
    act(() => mediaListeners.forEach((listener) => listener()));

    await waitFor(() => expect(setRuntimeTheme).toHaveBeenLastCalledWith("dark"));
    expect(screen.getByText("dark")).toBeTruthy();
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });
});
