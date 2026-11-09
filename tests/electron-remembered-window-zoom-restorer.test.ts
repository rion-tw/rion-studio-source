import { describe, expect, it, vi } from "vitest";

import { RememberedWindowZoomRestorer } from "../src/electron/main/chromiumRuntimeLaunchMemory";
import type { CoreEvent } from "../src/shared/generated";

function fixture() {
  let listener: (event: CoreEvent) => void = () => undefined;
  const invoke = vi.fn(async (command: { type: string }) => command.type === "appSnapshot"
    ? { logicalWindows: [{ windowId: "window-1", windowGeneration: 2, revision: 5, windowZoomFactor: 1 }] }
    : {});
  const core = {
    invoke,
    subscribeCoreEvents: (next: (event: CoreEvent) => void) => { listener = next; return () => undefined; }
  };
  const restorer = new RememberedWindowZoomRestorer(core as never);
  const complete = (operationId: string, ok: boolean) =>
    listener({ type: "browserLaunchCompleted", operationId, ok } as unknown as CoreEvent);
  const zoomRequests = () => invoke.mock.calls.filter(([command]) => command.type === "browserRuntimeWindowZoom");
  return { restorer, complete, zoomRequests };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe("remembered window zoom restore", () => {
  it("restores after the exact launch completes, whether completion comes first or later", async () => {
    const subject = fixture();
    subject.restorer.schedule("late", false, "window-1", 1.5);
    subject.complete("late", true);
    subject.complete("early", true);
    subject.restorer.schedule("early", false, "window-1", 1.25);
    await settle();
    expect(subject.zoomRequests().map(([command]) => (command as unknown as { zoomFactor: number }).zoomFactor))
      .toEqual([1.5, 1.25]);
  });

  it("never parks a launch that already failed, so failures cannot exhaust later restores", async () => {
    const subject = fixture();
    for (let index = 0; index < 64; index += 1) {
      subject.complete(`failed-${index}`, false);
      subject.restorer.schedule(`failed-${index}`, false, "window-1", 1.5);
    }
    subject.restorer.schedule("after", false, "window-1", 2);
    subject.complete("after", true);
    await settle();
    expect(subject.zoomRequests().map(([command]) => (command as unknown as { zoomFactor: number }).zoomFactor)).toEqual([2]);
  });
});
