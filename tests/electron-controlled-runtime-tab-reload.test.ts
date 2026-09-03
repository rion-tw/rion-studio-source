import { describe, expect, it } from "vitest";

import type {
  BrowserTabReloadReceiptRecord,
  CoreCommand,
  CoreCommandResult
} from "../src/shared/generated";
import {
  executeControlledRuntimeTabReload,
  type ControlledRuntimeTabReloadFence
} from "../src/electron/main/controlledRuntimeTabReload";

const fence = Object.freeze({
  lifecycleEpoch: 3,
  tabId: "tab-1",
  topologyRevision: 9,
  windowGeneration: 4,
  windowId: "window-1"
}) satisfies ControlledRuntimeTabReloadFence;

function appliedReceipt(operationId: string): BrowserTabReloadReceiptRecord {
  return {
    receipt: {
      acceptedAt: "2026-08-31T00:00:00.000Z",
      capturedAt: "2026-08-31T00:00:00.001Z",
      completionPolicy: "eventBound",
      completionScope: "inputReady",
      elapsedMs: 1,
      lifecycleEpoch: fence.lifecycleEpoch,
      operationId,
      platform: "windows",
      stage: "inputReady",
      status: "applied",
      subsystem: "navigation",
      tabId: fence.tabId,
      topologyRevision: fence.topologyRevision,
      trigger: "visibleNativeMenu",
      windowGeneration: fence.windowGeneration,
      windowId: fence.windowId
    },
    roles: [{
      afterDocumentInstanceId: "document-2",
      beforeDocumentInstanceId: "document-1",
      coreInputResumed: true,
      inputEpoch: 8,
      nativeInputResumed: true,
      navigationSequence: 2,
      ownerGeneration: 5,
      restartRequired: false,
      roleId: "role-1",
      status: "applied",
      submissionState: "submitted",
      surfaceGeneration: 6
    }]
  };
}

class FakeCore {
  readonly commands: CoreCommand[] = [];
  readonly #receipt: (
    operationId: string
  ) => BrowserTabReloadReceiptRecord;

  constructor(receipt = appliedReceipt) {
    this.#receipt = receipt;
  }

  async invoke<Command extends CoreCommand>(
    command: Command
  ): Promise<CoreCommandResult<Command>> {
    this.commands.push(command);
    if (command.type !== "browserRuntimeTabReload") {
      throw new Error("unexpected command");
    }
    return this.#receipt(command.operationId) as CoreCommandResult<Command>;
  }
}

describe("controlled runtime-tab Reload ingress", () => {
  it("preserves the captured fence and accepts only an immutable EventBound receipt", async () => {
    const core = new FakeCore();
    const receipt = await executeControlledRuntimeTabReload(core, fence);

    expect(core.commands).toEqual([{
      lifecycleEpoch: 3,
      operationId: expect.any(String),
      tabId: "tab-1",
      topologyRevision: 9,
      type: "browserRuntimeTabReload",
      windowGeneration: 4,
      windowId: "window-1"
    }]);
    expect(receipt.receipt).toMatchObject({
      completionPolicy: "eventBound",
      completionScope: "inputReady",
      status: "applied",
      subsystem: "navigation"
    });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.receipt)).toBe(true);
    expect(Object.isFrozen(receipt.roles)).toBe(true);
    expect(Object.isFrozen(receipt.roles[0])).toBe(true);
  });

  it("rejects malformed source fences before invoking Core", async () => {
    const core = new FakeCore();
    await expect(executeControlledRuntimeTabReload(core, {
      ...fence,
      lifecycleEpoch: 0
    })).rejects.toMatchObject({
      code: "ELECTRON_RUNTIME_TAB_RELOAD_FENCE_INVALID"
    });
    await expect(executeControlledRuntimeTabReload(core, {
      ...fence,
      tabId: `tab-${"界".repeat(86)}`
    })).rejects.toMatchObject({
      code: "ELECTRON_RUNTIME_TAB_RELOAD_FENCE_INVALID"
    });
    await expect(executeControlledRuntimeTabReload(core, {
      ...fence,
      windowId: " window-1"
    })).rejects.toMatchObject({
      code: "ELECTRON_RUNTIME_TAB_RELOAD_FENCE_INVALID"
    });
    expect(core.commands).toEqual([]);
  });

  it("rejects a non-Applied or non-input-ready terminal receipt", async () => {
    const core = new FakeCore((operationId) => {
      const receipt = appliedReceipt(operationId);
      return {
        ...receipt,
        receipt: {
          ...receipt.receipt,
          completionScope: "nativeAcknowledgement"
        }
      };
    });
    await expect(
      executeControlledRuntimeTabReload(core, fence)
    ).rejects.toMatchObject({
      code: "ELECTRON_RUNTIME_TAB_RELOAD_NOT_APPLIED"
    });
  });
});
