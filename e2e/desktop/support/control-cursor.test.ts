import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ execute: vi.fn(), executeAsync: vi.fn() }));
vi.mock("@wdio/globals", () => ({
  browser: { tauri: { execute: mocks.execute }, executeAsync: mocks.executeAsync }
}));
import { submitWindowControl, waitEvent, type DesktopE2eWindowSnapshot } from "./control";

afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); });

describe.each(["macos", "windows"])("%s native control event ordering", () => {
  it.each([22, 26])("accepts placement sequence %i on either side of the submission receipt", async placementSequence => {
    vi.stubEnv("RION_STUDIO_E2E_SESSION_TOKEN", "test-token");
    const snapshot = { windowId: "window-a", windowGeneration: 3 } as DesktopE2eWindowSnapshot;
    mocks.execute.mockResolvedValueOnce({ latestSequence: 21 }).mockResolvedValueOnce({ submitted: true });
    const events = [
      { kind: "placement-accepted", sequence: placementSequence, generation: 3, windowId: "window-a" },
      { kind: "native-control-submitted", sequence: 25, generation: 3, windowId: "window-a" }
    ];
    mocks.executeAsync.mockImplementation(async (_callback, _token, request) => {
      const value = events.find(event => event.sequence > request.afterSequence &&
        event.kind === request.kind && event.windowId === request.windowId &&
        event.generation >= request.minimumGeneration);
      return value ? { ok: true, value } : { ok: false, error: "No matching event" };
    });
    const submitted = await submitWindowControl(snapshot, { action: "moveResize", x: 35, y: 45, width: 820, height: 580 });
    expect(submitted.sequence).toBe(25);
    expect(submitted.requestedAfterSequence).toBe(21);
    await expect(waitEvent({
      afterSequence: submitted.requestedAfterSequence, kind: "placement-accepted",
      minimumGeneration: 3, windowId: snapshot.windowId
    })).resolves.toMatchObject({ sequence: placementSequence });
    expect(mocks.execute).toHaveBeenCalledTimes(2);
  });
});
