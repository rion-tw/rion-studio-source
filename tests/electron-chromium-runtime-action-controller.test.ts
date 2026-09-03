import { describe, expect, it, vi } from "vitest";

import {
  ChromiumRuntimeActionController,
  type AnyAuthenticatedChromiumRuntimeAction,
  type AnyChromiumRuntimeActionReceipt,
  type ChromiumRuntimeActionBackend,
} from "../src/electron/main/chromiumRuntimeActionController";
import type { RendererIdentity } from
  "../src/electron/main/rendererIdentity";

const identity: RendererIdentity = Object.freeze({
  kind: "main-renderer",
  windowId: 1,
  webContentsId: 2,
  generation: 3
});

function receiptFor(
  intent: AnyAuthenticatedChromiumRuntimeAction,
  value: unknown,
  status: AnyChromiumRuntimeActionReceipt["status"] = "applied"
): AnyChromiumRuntimeActionReceipt {
  return {
    intentId: intent.intentId,
    adapterSequence: intent.adapterSequence,
    rendererInstanceId: intent.rendererInstanceId,
    rendererGeneration: intent.rendererGeneration,
    actionType: intent.action.type,
    status,
    value
  } as AnyChromiumRuntimeActionReceipt;
}

function harness(execute?: ChromiumRuntimeActionBackend["execute"]) {
  let nextId = 0;
  const backendExecute = vi.fn(execute ?? (async (intent) =>
    receiptFor(intent, undefined))) as unknown as ChromiumRuntimeActionBackend["execute"];
  return {
    backendExecute,
    controller: new ChromiumRuntimeActionController({
      backend: { execute: backendExecute },
      createIntentId: () => `intent-${++nextId}`
    })
  };
}

describe("Chromium runtime action controller", () => {
  it("serializes authenticated actions without a timer and preserves adapter order", async () => {
    let releaseFirst!: () => void;
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const intents: AnyAuthenticatedChromiumRuntimeAction[] = [];
    const { controller, backendExecute } = harness(async (intent) => {
      intents.push(intent);
      if (intent.action.type === "showGameWindow") await firstPending;
      return receiptFor(intent, undefined);
    });

    const first = controller.showGameWindow(identity, "window-1");
    const second = controller.restoreSavedGameWindows(identity, { scope: "all" });

    await vi.waitFor(() => expect(backendExecute).toHaveBeenCalledTimes(1));
    expect(intents[0]).toMatchObject({
      intentId: "intent-1",
      adapterSequence: 1,
      rendererInstanceId: "main:1:2:3",
      rendererGeneration: 3,
      action: { type: "showGameWindow", windowId: "window-1" }
    });

    releaseFirst();
    await Promise.all([first, second]);
    expect(intents.map((intent) => ({
      sequence: intent.adapterSequence,
      type: intent.action.type
    }))).toEqual([
      { sequence: 1, type: "showGameWindow" },
      { sequence: 2, type: "restoreSavedGameWindows" }
    ]);
  });

  it("rejects a superseded renderer generation before it can enter the backend", async () => {
    const { controller, backendExecute } = harness();
    const replacement = Object.freeze({ ...identity, generation: 4 });
    const stale = Object.freeze({ ...identity, generation: 3 });

    await controller.showGameWindow(replacement, "window-1");
    expect(() => controller.showGameWindow(stale, "window-1")).toThrowError(
      expect.objectContaining({
        code: "ELECTRON_CHROMIUM_RUNTIME_ACTION_SENDER_STALE"
      })
    );
    expect(backendExecute).toHaveBeenCalledTimes(1);
  });

  it("accepts an exact duplicate replay receipt and rejects a mismatched receipt", async () => {
    const duplicate = harness(async (intent) =>
      receiptFor(intent, true, "duplicate"));
    await expect(duplicate.controller.presentQuickAccessRequest(
      identity,
      "request-1"
    )).resolves.toBe(true);

    const mismatch = harness(async (intent) => ({
      ...receiptFor(intent, undefined),
      adapterSequence: intent.adapterSequence + 1
    }));
    await expect(mismatch.controller.stopGameWindowTab(
      identity,
      "tab-1"
    )).rejects.toMatchObject({
      code: "ELECTRON_CHROMIUM_RUNTIME_ACTION_RECEIPT_INVALID"
    });
  });

  it("keeps topology fences out of renderer requests for cross-window and last-tab moves", async () => {
    const intents: AnyAuthenticatedChromiumRuntimeAction[] = [];
    const { controller } = harness(async (intent) => {
      intents.push(intent);
      const value = intent.action.type === "moveGameWindowTabToNewWindow"
        ? { targetWindowId: "window-new", receipt: { marker: "last-tab" } }
        : { marker: "cross-window" };
      return receiptFor(intent, value);
    });

    await controller.moveGameWindowTab(identity, "tab-1", "window-2");
    await controller.moveGameWindowTabToNewWindow(identity, "tab-last");

    expect(intents.map((intent) => intent.action)).toEqual([
      {
        type: "moveGameWindowTab",
        tabId: "tab-1",
        windowId: "window-2"
      },
      {
        type: "moveGameWindowTabToNewWindow",
        tabId: "tab-last"
      }
    ]);
    for (const intent of intents) {
      expect(intent.action).not.toHaveProperty("windowGeneration");
      expect(intent.action).not.toHaveProperty("topologyRevision");
      expect(intent.action).not.toHaveProperty("nativeGeneration");
    }
  });

  it("orders restore, discard, and Quick Access resolution on the same intent lane", async () => {
    const actions: unknown[] = [];
    const { controller } = harness(async (intent) => {
      actions.push(intent.action);
      const value = intent.action.type === "consumePendingQuickAccessRequest"
        ? { requestId: "request-1" }
        : intent.action.type === "presentQuickAccessRequest"
          ? true
          : undefined;
      return receiptFor(intent, value);
    });

    await controller.restoreSavedGameWindows(identity, {
      scope: "window",
      windowId: "window-1"
    });
    await controller.discardSavedGameWindows(identity, { scope: "all" });
    await expect(controller.consumePendingQuickAccessRequest(identity)).resolves.toEqual({
      requestId: "request-1"
    });
    await expect(controller.presentQuickAccessRequest(identity, "request-1"))
      .resolves.toBe(true);
    await controller.resolveQuickAccessRequest(identity, "request-1", "cancel");

    expect(actions).toEqual([
      {
        type: "restoreSavedGameWindows",
        input: { scope: "window", windowId: "window-1" }
      },
      { type: "discardSavedGameWindows", input: { scope: "all" } },
      { type: "consumePendingQuickAccessRequest" },
      { type: "presentQuickAccessRequest", requestId: "request-1" },
      {
        type: "resolveQuickAccessRequest",
        requestId: "request-1",
        resolution: "cancel"
      }
    ]);
  });

  it("rejects malformed identities and self-reorder before backend admission", async () => {
    const { controller, backendExecute } = harness();

    expect(() => controller.reorderGameWindowTab(
      identity,
      "tab-1",
      "tab-1"
    )).toThrowError(expect.objectContaining({
      code: "ELECTRON_CHROMIUM_RUNTIME_ACTION_REORDER_INVALID"
    }));
    expect(() => controller.showGameWindow(identity, " window-1"))
      .toThrowError(expect.objectContaining({
        code: "ELECTRON_CHROMIUM_RUNTIME_ACTION_ID_INVALID"
      }));
    expect(backendExecute).not.toHaveBeenCalled();
  });
});
