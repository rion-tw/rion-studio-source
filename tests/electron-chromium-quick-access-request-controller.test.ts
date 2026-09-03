import { describe, expect, it, vi } from "vitest";
import { ChromiumQuickAccessRequestController } from
  "../src/electron/main/chromiumQuickAccessRequestController";

describe("Chromium Quick Access request controller", () => {
  it("keeps only the latest request and consumes it once", () => {
    const publishRequest = vi.fn();
    const subject = new ChromiumQuickAccessRequestController({
      createRequestId: vi.fn()
        .mockReturnValueOnce("request-1")
        .mockReturnValueOnce("request-2"),
      publishRequest,
      presentMainWindow: vi.fn(async () => undefined)
    });
    subject.beginRuntimeTabRequest("tab-1");
    subject.beginRuntimeTabRequest("tab-2");
    expect(subject.consumePending()).toEqual({ requestId: "request-2" });
    expect(subject.consumePending()).toBeNull();
    expect(publishRequest).toHaveBeenCalledTimes(2);
  });

  it("presents only the exact consumed request and returns origin on cancel", async () => {
    const presentMainWindow = vi.fn(async () => undefined);
    const subject = new ChromiumQuickAccessRequestController({
      createRequestId: () => "request-1",
      publishRequest: vi.fn(),
      presentMainWindow
    });
    subject.beginRuntimeTabRequest("tab-1");
    await expect(subject.present("request-1")).resolves.toBe(false);
    subject.consumePending();
    await expect(subject.present("request-1")).resolves.toBe(true);
    await expect(subject.resolve("stale-request", "cancel")).resolves.toBeNull();
    await expect(subject.resolve("request-1", "cancel")).resolves.toBe("tab-1");
    await expect(subject.present("request-1")).resolves.toBe(false);
  });

  it("does not restore a runtime tab when a native main-window shortcut is cancelled", async () => {
    const subject = new ChromiumQuickAccessRequestController({
      createRequestId: () => "main-request",
      publishRequest: vi.fn(),
      presentMainWindow: vi.fn(async () => undefined)
    });
    subject.beginMainWindowRequest();
    expect(subject.consumePending()).toEqual({ requestId: "main-request" });
    await expect(subject.present("main-request")).resolves.toBe(true);
    await expect(subject.resolve("main-request", "cancel")).resolves.toBeNull();
  });
});
