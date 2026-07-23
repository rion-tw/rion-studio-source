import { describe, expect, it, vi } from "vitest";

import {
  ElectronEffectExecutor,
  ElectronHandleRegistry,
  type ElectronViewEffectHandle,
  type ElectronWindowEffectHandle
} from "../src/main/core/ElectronEffectExecutor";
import type { CoreEffectRequest, CoreEffectResult } from "../src/shared/generated";

const request = (
  action: CoreEffectRequest["action"],
  handleId = "view-1"
): CoreEffectRequest => ({
  effectId: crypto.randomUUID(),
  operationId: "operation-1",
  target: { kind: "view", handleId },
  deadlineMs: 1_000,
  action
});

describe("ElectronEffectExecutor", () => {
  it("creates and uses registered Electron handles without retaining operation state", async () => {
    const loadURL = vi.fn(async () => undefined);
    const focus = vi.fn();
    const executeJavaScript = vi.fn(async () => ({ ready: true }));
    const view: ElectronViewEffectHandle = {
      setBounds: vi.fn(),
      webContents: {
        executeJavaScript,
        focus,
        loadURL,
        setAudioMuted: vi.fn()
      }
    };
    const dispatchResults = vi.fn(async () => ({
      accepted: [],
      duplicate: [],
      late: [],
      unknown: [],
      operationMismatch: []
    }));
    const executor = new ElectronEffectExecutor(new ElectronHandleRegistry(), {
      clearSessionStorage: vi.fn(async () => undefined),
      createView: () => view,
      createWindow: vi.fn(),
      dispatchResults,
      sendDebuggerCommand: vi.fn(async () => null),
      setCookie: vi.fn(async () => undefined)
    });

    expect((await executor.execute(request({ type: "createView", optionsJson: "{}" }))).ok).toBe(true);
    expect((await executor.execute(request({ type: "loadUrl", url: "https://example.test" }))).ok).toBe(true);
    expect((await executor.execute(request({ type: "focus" }))).ok).toBe(true);
    const evaluated = await executor.execute(request({ type: "evaluate", source: "window.state" }));

    expect(loadURL).toHaveBeenCalledWith("https://example.test");
    expect(focus).toHaveBeenCalledOnce();
    expect(evaluated).toMatchObject({
      ok: true,
      valueJson: JSON.stringify({ ready: true })
    });
  });

  it("attaches views and dispatches one result batch through the generic protocol", async () => {
    const addChildView = vi.fn();
    const window: ElectronWindowEffectHandle = {
      contentView: {
        addChildView,
        removeChildView: vi.fn()
      },
      focus: vi.fn(),
      setBounds: vi.fn()
    };
    const view: ElectronViewEffectHandle = {
      setBounds: vi.fn(),
      webContents: {
        executeJavaScript: vi.fn(async () => null),
        focus: vi.fn(),
        loadURL: vi.fn(async () => undefined),
        setAudioMuted: vi.fn()
      }
    };
    const handles = new ElectronHandleRegistry();
    handles.register("window-1", window);
    handles.register("view-1", view);
    const dispatchResults = vi.fn(async (results: CoreEffectResult[]) => ({
      accepted: results.map((result) => result.effectId),
      duplicate: [],
      late: [],
      unknown: [],
      operationMismatch: []
    }));
    const executor = new ElectronEffectExecutor(handles, {
      clearSessionStorage: vi.fn(async () => undefined),
      createView: vi.fn(),
      createWindow: vi.fn(),
      dispatchResults,
      sendDebuggerCommand: vi.fn(async () => null),
      setCookie: vi.fn(async () => undefined)
    });
    const effect = request(
      { type: "attachView", childHandleId: "view-1" },
      "window-1"
    );

    const report = await executor.executeAndDispatch([effect]);

    expect(addChildView).toHaveBeenCalledWith(view);
    expect(dispatchResults).toHaveBeenCalledOnce();
    expect(report.accepted).toEqual([effect.effectId]);
  });

  it("returns stable typed failures for missing or incompatible handles", async () => {
    const executor = new ElectronEffectExecutor(new ElectronHandleRegistry(), {
      clearSessionStorage: vi.fn(async () => undefined),
      createView: vi.fn(),
      createWindow: vi.fn(),
      dispatchResults: vi.fn(async () => ({
        accepted: [],
        duplicate: [],
        late: [],
        unknown: [],
        operationMismatch: []
      })),
      sendDebuggerCommand: vi.fn(async () => null),
      setCookie: vi.fn(async () => undefined)
    });

    await expect(executor.execute(request({ type: "focus" }, "missing"))).resolves.toMatchObject({
      ok: false,
      error: {
        code: "ELECTRON_EFFECT_TARGET_NOT_FOUND"
      }
    });
  });

  it("routes external browser effects without requiring an Electron handle", async () => {
    const executeExternalEffect = vi.fn(async () => ({
      proxyServer: "http://127.0.0.1:4010"
    }));
    const dispatchResults = vi.fn(async (results: CoreEffectResult[]) => ({
      accepted: results.map((result) => result.effectId),
      duplicate: [],
      late: [],
      unknown: [],
      operationMismatch: []
    }));
    const executor = new ElectronEffectExecutor(new ElectronHandleRegistry(), {
      clearSessionStorage: vi.fn(async () => undefined),
      createView: vi.fn(),
      createWindow: vi.fn(),
      dispatchResults,
      executeExternalEffect,
      sendDebuggerCommand: vi.fn(async () => null),
      setCookie: vi.fn(async () => undefined)
    });
    const effect = request({
      type: "externalPrepareSession",
      roleId: "role-1",
      cdnMode: "auto"
    });

    const report = await executor.executeAndDispatch([effect]);

    expect(executeExternalEffect).toHaveBeenCalledWith(effect);
    expect(dispatchResults).toHaveBeenCalledWith([
      expect.objectContaining({
        effectId: effect.effectId,
        ok: true,
        valueJson: JSON.stringify({ proxyServer: "http://127.0.0.1:4010" })
      })
    ]);
    expect(report.accepted).toEqual([effect.effectId]);
  });
});
