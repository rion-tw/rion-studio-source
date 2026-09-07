import { expect, it, vi } from "vitest";
import { clickWindowsProbeCaption } from "../scripts/electronWindowsProbeInitialClick.mjs";

it.each([
  { platform: "darwin", processId: 42, nativeWindowHandle: "1234" },
  { platform: "win32", processId: 0, nativeWindowHandle: "1234" },
  { platform: "win32", processId: 42, nativeWindowHandle: "0" },
  { platform: "win32", processId: 42, nativeWindowHandle: "1234; echo invalid" }
])("rejects invalid probe activation evidence before native work: %j", async input => {
  const run = vi.fn(async () => "{}");
  await expect(clickWindowsProbeCaption(input, { platform: input.platform, run }))
    .rejects.toThrow("exact Windows process and HWND");
  expect(run).not.toHaveBeenCalled();
});

it("passes exact Windows identity as structured data and preserves a native caption rejection", async () => {
  const input = { processId: 42, nativeWindowHandle: "1234" };
  const error = new Error("exact caption is occluded");
  const run = vi.fn(async () => { throw error; });
  await expect(clickWindowsProbeCaption(input, { platform: "win32", run })).rejects.toBe(error);
  expect(run).toHaveBeenCalledExactlyOnceWith(expect.any(String), input,
    { timeoutMilliseconds: 30_000 });
});
