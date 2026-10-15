import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { activateMacosLauncherForVisibleControl } from "../e2e/desktop/support/macos-launcher-activation";

const processId = 4325;
const input = { platform: "macos" as const, processId };
const receipt = { processId, ownerProcessId: processId, foregroundProcessId: processId,
  role: "AXWindow", main: true, launcherCount: 1, retainedOwner: true };
const executable = resolve("launcher-phase", "macos-launcher-activation");
function executor(value: unknown = receipt) {
  return vi.fn(async () => ({ stdout: JSON.stringify(value) }));
}
function dependencies(execute = executor()) {
  return { hostPlatform: "darwin" as const, execute, prepare: vi.fn(async () => executable) };
}

describe("retained macOS launcher activation for visible controls", () => {
  it("requires exact native owner, AXMain and foreground before returning a frozen receipt", async () => {
    const execute = executor();
    const native = dependencies(execute);
    const result = await activateMacosLauncherForVisibleControl(input, native);
    expect(result).toEqual(receipt);
    expect(Object.isFrozen(result)).toBe(true);
    expect(native.prepare).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledExactlyOnceWith(executable,
      [String(processId)], { encoding: "utf8", timeout: 10_000 });
  });

  it.each([0, 1, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
    "rejects invalid PID %s before any native action", async invalid => {
      const execute = executor();
      const native = dependencies(execute);
      await expect(activateMacosLauncherForVisibleControl({ ...input, processId: invalid },
        native)).rejects.toThrow("exact positive app PID");
      expect(execute).not.toHaveBeenCalled();
      expect(native.prepare).not.toHaveBeenCalled();
    });

  it.each([
    { platform: "windows" as const, hostPlatform: "darwin" as const },
    { platform: "macos" as const, hostPlatform: "win32" as const }
  ])("refuses platform/host mismatch %j without crossing the native boundary", async scope => {
    const execute = executor();
    const native = dependencies(execute);
    await expect(activateMacosLauncherForVisibleControl({ processId, platform: scope.platform },
      { ...native, hostPlatform: scope.hostPlatform })).rejects.toThrow("explicit macOS platform and host");
    expect(execute).not.toHaveBeenCalled();
    expect(native.prepare).not.toHaveBeenCalled();
  });

  it.each([
    { processId: 999 }, { ownerProcessId: 999 }, { foregroundProcessId: 999 },
    { role: "AXSheet" }, { main: false }, { launcherCount: 2 },
    { retainedOwner: false }, { unexpected: true }
  ])("rejects mismatched native proof %j without repeating activation", async changed => {
    const execute = executor({ ...receipt, ...changed });
    await expect(activateMacosLauncherForVisibleControl(input, dependencies(execute)))
      .rejects.toThrow("activation receipt is invalid");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("preserves unknown native acknowledgement failure without fallback or action retry", async () => {
    const error = new Error("retained launcher AXRaise failed");
    const execute = vi.fn(async () => { throw error; });
    await expect(activateMacosLauncherForVisibleControl(input, dependencies(execute)))
      .rejects.toMatchObject({ cause: error,
        message: expect.stringMatching(/Run macos-launcher-activation failed after \d+ms.*code=unknown, killed=false, signal=none/u) });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each([null, [], "truncated native output"])("rejects malformed native output %j", async value => {
    const execute = executor(value);
    await expect(activateMacosLauncherForVisibleControl(input, dependencies(execute)))
      .rejects.toThrow("activation receipt is invalid");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("performs no native activation until the preparation acknowledgement resolves", async () => {
    let compiled!: (path: string) => void;
    const execute = executor();
    const prepare = vi.fn(() => new Promise<string>(resolveCompiled => { compiled = resolveCompiled; }));
    const pending = activateMacosLauncherForVisibleControl(input, { hostPlatform: "darwin", execute, prepare });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    compiled(executable);
    await expect(pending).resolves.toEqual(receipt);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("preserves a compiler rejection and never invokes AX activation", async () => {
    const cause = new Error("Compile macos-launcher-activation failed with SDK evidence");
    const execute = executor();
    const prepare = vi.fn(async () => { throw cause; });
    await expect(activateMacosLauncherForVisibleControl(input, { hostPlatform: "darwin", execute, prepare }))
      .rejects.toBe(cause);
    expect(execute).not.toHaveBeenCalled();
  });

  it("retains bounded native process metadata without repeating an unknown activation", async () => {
    const cause = Object.assign(new Error("native action stopped"), {
      code: "ETIMEDOUT", killed: true, signal: "SIGTERM",
      stderr: `old-private-output${"x".repeat(4_000)}last-stderr`, stdout: "last-stdout"
    });
    const execute = vi.fn(async () => { throw cause; });
    const outcome = await activateMacosLauncherForVisibleControl(input, dependencies(execute))
      .then(() => undefined, error => error as Error);
    expect(outcome).toMatchObject({ cause });
    expect(outcome!.message).toMatch(/Run macos-launcher-activation failed after \d+ms.*code=ETIMEDOUT, killed=true, signal=SIGTERM/u);
    expect(outcome!.message).toContain("last-stderr");
    expect(outcome!.message).toContain("last-stdout");
    expect(outcome!.message).not.toContain("old-private-output");
    expect(outcome!.message.length).toBeLessThan(2_300);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid JSON without accepting or retrying its native receipt", async () => {
    const execute = vi.fn(async () => ({ stdout: "{truncated" }));
    await expect(activateMacosLauncherForVisibleControl(input, dependencies(execute)))
      .rejects.toMatchObject({ message: "The retained exact Mac launcher activation receipt is invalid",
        cause: expect.any(SyntaxError) });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
