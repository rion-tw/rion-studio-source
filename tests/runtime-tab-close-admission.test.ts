import { describe, expect, it, vi } from "vitest";
import type { CoreEvent } from "../src/shared/generated";
import { admitRuntimeTabClose } from "../src/electron/main/runtimeTabCloseAdmission";

const expected = { operationId: "close-b", tabId: "b", windowId: "window-b", windowGeneration: 2, topologyRevision: 3 };
describe("Core tab close admission", () => {
  it("returns topology while exact native release is still pending", async () => {
    let listener!: (event: CoreEvent) => void;
    let release!: () => void;
    const cleanup = new Promise<void>(resolve => { release = resolve; });
    const unsubscribe = vi.fn();
    const invoke = vi.fn(() => cleanup);
    const admission = admitRuntimeTabClose({ invoke: vi.fn(), subscribeCoreEvents: next => {
      listener = next; return unsubscribe;
    } }, expected, invoke);
    await Promise.resolve();
    listener({ type: "runtimeTabTopologyCommitted", ...expected, topologyRevision: 4 });
    await expect(admission).resolves.toBe(4);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledOnce();
    release();
    await cleanup;
  });
  it("rejects mismatched and stopped operations without inventing completion", async () => {
    for (const event of [
      { type: "runtimeTabTopologyCommitted", ...expected, windowGeneration: 1, topologyRevision: 4 },
      { type: "shutdown" }
    ] as CoreEvent[]) {
      let listener!: (event: CoreEvent) => void;
      let release!: () => void;
      const cleanup = new Promise<void>(resolve => { release = resolve; });
      const admission = admitRuntimeTabClose({ invoke: vi.fn(), subscribeCoreEvents: next => {
        listener = next; return () => undefined;
      } }, expected, () => cleanup);
      listener(event);
      await expect(admission).rejects.toHaveProperty("code");
      release();
    }
  });
});
