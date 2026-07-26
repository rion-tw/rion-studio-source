import { describe, expect, it, vi } from "vitest";

import { ElectronEffectExecutor } from "../src/main/core/ElectronEffectExecutor";
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
  it("routes product effects without retaining Electron object handles", async () => {
    const executeCompatibilityEffect = vi.fn(async () => ({ ready: true }));
    const dispatchResults = vi.fn(async () => ({
      accepted: [],
      duplicate: [],
      late: [],
      unknown: [],
      operationMismatch: []
    }));
    const executor = new ElectronEffectExecutor({
      dispatchResults,
      executeCompatibilityEffect
    });
    const effect = request({ type: "compatibilityConfigureSession", gameId: "game-1" });
    const result = await executor.execute(effect);

    expect(executeCompatibilityEffect).toHaveBeenCalledWith(effect);
    expect(result).toMatchObject({
      ok: true,
      valueJson: JSON.stringify({ ready: true })
    });
  });

  it("dispatches one result batch through the generic acknowledgement protocol", async () => {
    const dispatchResults = vi.fn(async (results: CoreEffectResult[]) => ({
      accepted: results.map((result) => result.effectId),
      duplicate: [],
      late: [],
      unknown: [],
      operationMismatch: []
    }));
    const executeOverlayEffect = vi.fn(async () => undefined);
    const executor = new ElectronEffectExecutor({
      dispatchResults,
      executeOverlayEffect
    });
    const effect = request({ type: "overlayOpenMacroPage", roleId: "role-1" });

    const report = await executor.executeAndDispatch([effect]);

    expect(executeOverlayEffect).toHaveBeenCalledWith(effect);
    expect(dispatchResults).toHaveBeenCalledOnce();
    expect(report.accepted).toEqual([effect.effectId]);
  });

  it("returns stable typed failures when a transitional adapter is unavailable", async () => {
    const onResult = vi.fn();
    const executor = new ElectronEffectExecutor({
      dispatchResults: vi.fn(async () => ({
        accepted: [],
        duplicate: [],
        late: [],
        unknown: [],
        operationMismatch: []
      })),
      onResult
    });
    const effect = request({ type: "compatibilityConfigureSession", gameId: "game-1" });

    await expect(executor.execute(effect)).resolves.toMatchObject({
      ok: false,
      error: {
        code: "ELECTRON_EFFECT_UNSUPPORTED"
      }
    });
    expect(onResult).toHaveBeenCalledWith(
      effect,
      expect.objectContaining({
        error: expect.objectContaining({ code: "ELECTRON_EFFECT_UNSUPPORTED" })
      })
    );
  });

  it("drains in-flight result dispatches before closing and rejects later batches", async () => {
    let resolveDispatch!: (value: {
      accepted: string[];
      duplicate: string[];
      late: string[];
      unknown: string[];
      operationMismatch: string[];
    }) => void;
    const dispatchResults = vi.fn(() => new Promise<{
      accepted: string[];
      duplicate: string[];
      late: string[];
      unknown: string[];
      operationMismatch: string[];
    }>((resolve) => {
      resolveDispatch = resolve;
    }));
    const executor = new ElectronEffectExecutor({
      dispatchResults,
      executeOverlayEffect: vi.fn(async () => undefined)
    });
    const effect = request({ type: "overlayOpenMacroPage", roleId: "role-1" });
    const execution = executor.executeAndDispatch([effect]);
    await vi.waitFor(() => expect(dispatchResults).toHaveBeenCalledOnce());

    let drained = false;
    const closing = executor.closeAndDrain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    resolveDispatch({
      accepted: [effect.effectId],
      duplicate: [],
      late: [],
      unknown: [],
      operationMismatch: []
    });
    await execution;
    await closing;
    expect(drained).toBe(true);
    await expect(executor.executeAndDispatch([effect])).rejects.toMatchObject({
      code: "ELECTRON_EFFECT_EXECUTOR_CLOSED"
    });
  });

  it("routes overlay presentation effects without retaining overlay state", async () => {
    const executeOverlayEffect = vi.fn(async () => undefined);
    const executor = new ElectronEffectExecutor({
      dispatchResults: vi.fn(async () => ({
        accepted: [],
        duplicate: [],
        late: [],
        unknown: [],
        operationMismatch: []
      })),
      executeOverlayEffect
    });
    const openEffect = request({
      type: "overlayOpenMacroPage",
      roleId: "role-1"
    });
    const copyEffect = request({
      type: "overlayCopyCoordinate",
      coordinate: {
        xPercent: 25,
        xPx: 320,
        viewportHeightPx: 720,
        viewportWidthPx: 1_280,
        yPercent: 75,
        yPx: 540
      }
    });

    await expect(executor.execute(openEffect)).resolves.toMatchObject({ ok: true });
    await expect(executor.execute(copyEffect)).resolves.toMatchObject({ ok: true });

    expect(executeOverlayEffect).toHaveBeenNthCalledWith(1, openEffect);
    expect(executeOverlayEffect).toHaveBeenNthCalledWith(2, copyEffect);
  });
});
