import { afterEach, describe, expect, it, vi } from "vitest";

import { MacroManager } from "../src/main/macros/MacroManager";
import type { Macro } from "../src/shared/types";

const macro: Macro = {
  id: "macro-1",
  name: "Auto heal",
  roleId: "role-1",
  repeat: { type: "once" },
  steps: [{ id: "step-1", type: "key", code: "F2" }],
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z"
};

describe("MacroManager", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("focuses automation target and dispatches key steps through CDP by physical code", async () => {
    const page = createPage();
    const manager = createManager({ page });

    await manager.start("role-1", "macro-1");
    await vi.waitFor(() => expect(page.cdpSession.send).toHaveBeenCalledTimes(2));

    expect(page.page.bringToFront).toHaveBeenCalledTimes(1);
    expect(page.frame.evaluate).toHaveBeenCalledWith(expect.any(Function), { allowFallback: false });
    expect(page.frame.evaluate.mock.invocationCallOrder[0]).toBeLessThan(
      page.cdpSession.send.mock.invocationCallOrder[0]
    );
    expect(page.cdpSession.send).toHaveBeenNthCalledWith(1, "Input.dispatchKeyEvent", {
      code: "F2",
      key: "F2",
      nativeVirtualKeyCode: 113,
      type: "rawKeyDown",
      windowsVirtualKeyCode: 113
    });
    expect(page.cdpSession.send).toHaveBeenNthCalledWith(2, "Input.dispatchKeyEvent", {
      code: "F2",
      key: "F2",
      nativeVirtualKeyCode: 113,
      type: "keyUp",
      windowsVirtualKeyCode: 113
    });
    expect(page.cdpSession.detach).toHaveBeenCalledTimes(1);
  });

  it("cancels a delay when the macro is stopped", async () => {
    vi.useFakeTimers();
    const page = createPage();
    const manager = createManager({
      macroOverride: {
        ...macro,
        steps: [
          { id: "step-1", type: "delay", ms: 1000 },
          { id: "step-2", type: "key", code: "F3" }
        ]
      },
      page
    });

    await manager.start("role-1", "macro-1");
    expect(manager.listStatuses()).toMatchObject([{ roleId: "role-1", macroId: "macro-1", state: "running" }]);

    await manager.stop("role-1", "macro-1");
    await vi.runOnlyPendingTimersAsync();
    await vi.waitFor(() => expect(manager.listStatuses()).toEqual([]));

    expect(page.cdpSession.send).not.toHaveBeenCalled();
  });

  it("loops after the configured interval until stopped", async () => {
    const page = createPage();
    const manager = createManager({
      macroOverride: {
        ...macro,
        repeat: { type: "loop", intervalMs: 5 },
        steps: [{ id: "step-1", type: "key", code: "F1" }]
      },
      page
    });

    await manager.start("role-1", "macro-1");
    await vi.waitFor(() => expect(page.cdpSession.send.mock.calls.length).toBeGreaterThanOrEqual(4));

    await manager.stop("role-1", "macro-1");
    await vi.waitFor(() => expect(manager.listStatuses()).toEqual([]));
  });

  it("rejects starts for unavailable sessions and unassigned macros", async () => {
    const unavailableManager = createManager({ page: undefined });
    await expect(unavailableManager.start("role-1", "macro-1")).rejects.toThrow(
      "Launch this role before running a macro."
    );

    const unassignedManager = createManager({
      macroOverride: {
        ...macro,
        roleId: "role-2"
      },
      page: createPage()
    });
    await expect(unassignedManager.start("role-1", "macro-1")).rejects.toThrow(
      "Macro is not assigned to this role."
    );
  });

  it("rejects duplicate starts for the same role and macro", async () => {
    vi.useFakeTimers();
    const manager = createManager({
      macroOverride: {
        ...macro,
        steps: [{ id: "step-1", type: "delay", ms: 1000 }]
      },
      page: createPage()
    });

    await manager.start("role-1", "macro-1");

    await expect(manager.start("role-1", "macro-1")).rejects.toThrow(
      "Macro is already running for this role."
    );
  });
});

function createManager(options: {
  macroOverride?: Macro;
  page?: ReturnType<typeof createPage> | null;
} = {}): MacroManager {
  const macroOverride = options.macroOverride ?? macro;
  const page = "page" in options ? options.page : createPage();

  return new MacroManager(
    {
      getAutomationSession: vi.fn(() =>
        page
          ? {
              context: page.browserContext,
              page: page.page,
              role: {
                id: "role-1",
                name: "Main",
                launchUrl: "https://example.com/play",
                windowWidth: 1280,
                windowHeight: 720,
                notes: "",
                launchPreset: "performance",
                authState: "authenticated",
                createdAt: "2026-07-10T00:00:00.000Z",
                updatedAt: "2026-07-10T00:00:00.000Z"
              }
            }
          : undefined
      )
    } as never,
    {
      getMacro: vi.fn().mockResolvedValue(macroOverride)
    } as never
  );
}

function createPage(): {
  browserContext: {
    newCDPSession: ReturnType<typeof vi.fn>;
  };
  cdpSession: {
    detach: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
  };
  page: {
    bringToFront: ReturnType<typeof vi.fn>;
    context: ReturnType<typeof vi.fn>;
    evaluate: ReturnType<typeof vi.fn>;
    frames: ReturnType<typeof vi.fn>;
    mouse: {
      click: ReturnType<typeof vi.fn>;
    };
  };
  frame: {
    evaluate: ReturnType<typeof vi.fn>;
  };
} {
  const cdpSession = {
    detach: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue({})
  };
  const browserContext = {
    newCDPSession: vi.fn().mockResolvedValue(cdpSession)
  };
  const frame = {
    evaluate: vi.fn().mockResolvedValue("canvas")
  };
  const page = {
    bringToFront: vi.fn().mockResolvedValue(undefined),
    context: vi.fn().mockReturnValue(browserContext),
    evaluate: vi.fn().mockResolvedValue({ height: 720, width: 1280 }),
    frames: vi.fn(() => [frame]),
    mouse: {
      click: vi.fn().mockResolvedValue(undefined)
    }
  };

  return {
    browserContext,
    cdpSession,
    frame,
    page
  };
}
