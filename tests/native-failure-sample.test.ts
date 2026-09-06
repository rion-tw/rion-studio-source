import { describe, expect, it, vi } from "vitest";
import { capturePreparedNativeFailureSample, prepareNativeFailureSampler, registerNativeFailureSampler } from "../e2e/desktop/support/native-failure-sample";

const identity = " 42 Sun Sep 6 10:00:00 2026 /fixture/Electron";
const input = { platform: "darwin", processId: 123 } as const;
describe("native failure process sampling", () => {
  it("hands the admitted sampler to a separately loaded failure hook", async () => {
    const capture = vi.fn(async () => "captured" as const);
    registerNativeFailureSampler(capture);
    vi.resetModules();
    const hook = await import("../e2e/desktop/support/native-failure-sample");
    expect(await hook.capturePreparedNativeFailureSample("/artifacts/failure")).toBe("captured");
    expect(capture).toHaveBeenCalledExactlyOnceWith("/artifacts/failure");
    registerNativeFailureSampler(async () => "unavailable");
    expect(await capturePreparedNativeFailureSample("/artifacts/later")).toBe("unavailable");
  });
  it("samples only the same admitted PID, parent, start time and executable", async () => {
    const execute = vi.fn(async () => ({ stdout: identity }));
    const capture = await prepareNativeFailureSampler(input, execute);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await capture("/artifacts/failure.sample.txt")).toBe("captured");
    expect(execute.mock.calls).toEqual([
      ["/bin/ps", ["-p", "123", "-o", "ppid=", "-o", "lstart=", "-o", "comm="], { timeout: 5000, maxBuffer: 16384 }],
      ["/bin/ps", ["-p", "123", "-o", "ppid=", "-o", "lstart=", "-o", "comm="], { timeout: 5000, maxBuffer: 16384 }],
      ["/usr/bin/sample", ["123", "2", "10", "-file", "/artifacts/failure.sample.txt"], { timeout: 10000, maxBuffer: 16384 }]
    ]);
  });
  it("rejects a changed process identity without sampling it", async () => {
    const execute = vi.fn().mockResolvedValueOnce({ stdout: identity })
      .mockResolvedValueOnce({ stdout: identity.replace("10:00", "11:00") });
    const capture = await prepareNativeFailureSampler(input, execute);
    expect(await capture("/artifacts/failure")).toBe("identity-changed");
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it.each(["win32", "linux"] as const)("does not sample on %s", async platform => {
    const execute = vi.fn();
    const capture = await prepareNativeFailureSampler({ platform, processId: 123 }, execute);
    expect(await capture("/artifacts/failure")).toBe("unsupported");
    expect(execute).not.toHaveBeenCalled();
  });
  it.each(["", "one\ntwo"])("rejects unavailable or ambiguous identity %j", async stdout => {
    const execute = vi.fn(async () => ({ stdout }));
    const capture = await prepareNativeFailureSampler(input, execute);
    expect(await capture("/artifacts/failure")).toBe("unavailable");
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("preserves the original failure when sample fails", async () => {
    const execute = vi.fn().mockResolvedValueOnce({ stdout: identity })
      .mockResolvedValueOnce({ stdout: identity }).mockRejectedValueOnce(new Error("sample denied"));
    const capture = await prepareNativeFailureSampler(input, execute);
    expect(await capture("/artifacts/failure")).toBe("unavailable");
  });
});
