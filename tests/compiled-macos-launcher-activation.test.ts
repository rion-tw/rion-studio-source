import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  return { execFile: Object.assign(vi.fn(), { [promisify.custom]: execute }) };
});

beforeEach(() => {
  vi.resetModules();
  execute.mockReset().mockResolvedValue({ stdout: "" });
  vi.stubEnv("RION_STUDIO_E2E_ARTIFACT_DIR", resolve("launcher-compile-phase"));
});
afterEach(() => vi.unstubAllEnvs());

describe("phase-local macOS launcher activation compiler", () => {
  it("shares one compile acknowledgement before returning an executable, without submitting a native action", async () => {
    let complete!: () => void;
    execute.mockImplementationOnce(() => new Promise<void>(resolveCompile => { complete = resolveCompile; }));
    const { prepareMacosLauncherActivation } = await import("../e2e/desktop/support/compiled-macos-launcher-activation");
    const first = prepareMacosLauncherActivation();
    const second = prepareMacosLauncherActivation();
    expect(execute).toHaveBeenCalledExactlyOnceWith("/usr/bin/xcrun", ["swiftc",
      fileURLToPath(new URL("../e2e/desktop/support/macos-launcher-activation.swift", import.meta.url)),
      "-o", resolve("launcher-compile-phase", "macos-launcher-activation")],
    { encoding: "utf8", timeout: 120_000 });
    let prepared = false;
    void first.then(() => { prepared = true; });
    await Promise.resolve();
    expect(prepared).toBe(false);
    complete();
    await expect(Promise.all([first, second])).resolves.toEqual([
      resolve("launcher-compile-phase", "macos-launcher-activation"),
      resolve("launcher-compile-phase", "macos-launcher-activation")
    ]);
    await prepareMacosLauncherActivation();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("retains the failed phase promise and bounded compiler evidence instead of retrying", async () => {
    const cause = Object.assign(new Error("SDK compiler terminated"), {
      code: "ETIMEDOUT", killed: true, signal: "SIGTERM",
      stderr: `old-compiler-output${"x".repeat(4_000)}compiler-tail`, stdout: "stdout-tail"
    });
    execute.mockRejectedValue(cause);
    const { prepareMacosLauncherActivation } = await import("../e2e/desktop/support/compiled-macos-launcher-activation");
    const errors: Error[] = [];
    for (let request = 0; request < 2; request++) {
      const error = await prepareMacosLauncherActivation().then(() => undefined, failure => failure as Error);
      expect(error).toMatchObject({ cause });
      errors.push(error!);
    }
    expect(errors[0]).toBe(errors[1]);
    expect(errors[0]!.message).toMatch(/Compile macos-launcher-activation failed after \d+ms.*code=ETIMEDOUT, killed=true, signal=SIGTERM/u);
    expect(errors[0]!.message).toContain("compiler-tail");
    expect(errors[0]!.message).toContain("stdout-tail");
    expect(errors[0]!.message).not.toContain("old-compiler-output");
    expect(errors[0]!.message.length).toBeLessThan(2_300);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("isolates compiled executables by absolute phase directory", async () => {
    const { prepareMacosLauncherActivation } = await import("../e2e/desktop/support/compiled-macos-launcher-activation");
    const first = await prepareMacosLauncherActivation();
    vi.stubEnv("RION_STUDIO_E2E_ARTIFACT_DIR", resolve("another-launcher-phase"));
    const second = await prepareMacosLauncherActivation();
    expect(first).not.toBe(second);
    expect(second).toBe(resolve("another-launcher-phase", "macos-launcher-activation"));
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it.each(["", "relative-phase"])("rejects an unowned artifact path %j before compilation", async (directory) => {
    vi.stubEnv("RION_STUDIO_E2E_ARTIFACT_DIR", directory);
    const { prepareMacosLauncherActivation } = await import("../e2e/desktop/support/compiled-macos-launcher-activation");
    await expect(prepareMacosLauncherActivation()).rejects.toThrow("absolute phase artifact directory");
    expect(execute).not.toHaveBeenCalled();
  });
});
