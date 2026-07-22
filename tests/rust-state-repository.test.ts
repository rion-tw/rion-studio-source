import { describe, expect, it, vi } from "vitest";

import { RustStateRepository } from "../src/main/core/RustStateRepository";

describe("RustStateRepository", () => {
  it("sends single-key writes without reading or serializing the whole snapshot in JavaScript", async () => {
    const invoke = vi.fn(async () => ({ revision: 1 }));
    const repository = new RustStateRepository({ invoke } as never);
    const settings = { launchMode: "embedded" };

    await repository.replaceGameBrowserSettings(settings as never);

    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith({
      type: "gameBrowserSettingsReplace",
      settings
    });
  });
});
