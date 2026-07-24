import { describe, expect, it } from "vitest";

import {
  RuntimeWindowPreferencesStore
} from "../src/main/window/RuntimeWindowPreferencesStore";
import { MemoryStateRepository } from "./helpers/memoryStateRepository";

describe("RuntimeWindowPreferencesStore", () => {
  it("reads defaults from the Rust state client", async () => {
    const store = new RuntimeWindowPreferencesStore("/unused", new MemoryStateRepository());
    await expect(store.getPreferences()).resolves.toEqual({
      alwaysShowToolbarInFullScreen: false,
      restoreGameWindowsOnStartup: true
    });
  });

  it("normalizes and persists the fullscreen toolbar preference", async () => {
    const repository = new MemoryStateRepository();
    const store = new RuntimeWindowPreferencesStore("/unused", repository);
    await expect(store.updatePreferences({
      alwaysShowToolbarInFullScreen: true,
      restoreGameWindowsOnStartup: false
    })).resolves.toEqual({
      alwaysShowToolbarInFullScreen: true,
      restoreGameWindowsOnStartup: false
    });
    await expect(store.getPreferences()).resolves.toEqual({
      alwaysShowToolbarInFullScreen: true,
      restoreGameWindowsOnStartup: false
    });
  });
});
