import { describe, expect, it, vi } from "vitest";

import { RustMacroManager } from "../src/main/macros/RustMacroManager";
import type { AppCoreClient } from "../src/main/core/nativeCore";

describe("RustMacroManager source-role contract", () => {
  it("identifies an overlay role as the source without narrowing execution roles", async () => {
    const invoke = vi.fn(async () => []);
    const manager = new RustMacroManager({
      invoke,
      subscribe: vi.fn(() => () => undefined)
    } as unknown as AppCoreClient);

    await manager.startForRole("macro-1", "role-2");
    await manager.pressForRole("macro-1", "role-2", "press-1");

    expect(invoke).toHaveBeenNthCalledWith(1, {
      type: "macroStart",
      request: { macroId: "macro-1", sourceRoleId: "role-2" }
    });
    expect(invoke).toHaveBeenNthCalledWith(2, {
      type: "macroPress",
      request: {
        macroId: "macro-1",
        pressId: "press-1",
        sourceRoleId: "role-2"
      }
    });
  });

  it("uses the same source identity for release and whole-invocation overlay stop", async () => {
    const invoke = vi.fn(async () => ({}));
    const manager = new RustMacroManager({
      invoke,
      subscribe: vi.fn(() => () => undefined)
    } as unknown as AppCoreClient);

    await manager.releaseForRole("macro-1", "role-2", "press-1", "immediate");
    await manager.stopForRole("macro-1", "role-2");

    expect(invoke).toHaveBeenNthCalledWith(1, {
      type: "macroRelease",
      request: {
        macroId: "macro-1",
        mode: "immediate",
        pressId: "press-1",
        sourceRoleId: "role-2"
      }
    });
    expect(invoke).toHaveBeenNthCalledWith(2, {
      type: "macroStopForRole",
      macroId: "macro-1",
      sourceRoleId: "role-2"
    });
  });
});
