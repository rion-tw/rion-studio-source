import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  return { execFile: Object.assign(vi.fn(), { [promisify.custom]: execute }) };
});

const artifactDirectory = resolve("native-focus-phase-fixture");
const shortcut = ["4325", "com.rionstudio.runtime.appkit-window.v1:window-a", "", "shortcut", "toggleFullscreen"] as const;
const focus = ["4325", shortcut[1], "Role A", "focus", ""] as const;

beforeEach(() => {
  vi.resetModules();
  execute.mockReset();
  vi.stubEnv("RION_STUDIO_E2E_ARTIFACT_DIR", artifactDirectory);
});
afterEach(() => vi.unstubAllEnvs());

describe("compiled macOS exact native focus/input lifecycle", () => {
  it("prepares without any native action and reuses that acknowledged executable for later input", async () => {
    execute.mockResolvedValue({ stdout: "" });
    const { prepareMacosNativeFocus, runMacosNativeFocus } =
      await import("../e2e/desktop/support/compiled-macos-native-focus");
    const executable = await prepareMacosNativeFocus();
    expect(executable).toBe(resolve(artifactDirectory, "macos-native-focus"));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await prepareMacosNativeFocus()).toBe(executable);
    expect(execute).toHaveBeenCalledTimes(1);
    await runMacosNativeFocus(shortcut, 15_000);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1]).toEqual([executable, shortcut, { encoding: "utf8", timeout: 15_000 }]);
  });

  it("acknowledges one shared compilation before any concurrent native action", async () => {
    let acknowledgeCompilation!: (result: { stdout: string }) => void;
    execute.mockImplementationOnce(() => new Promise(resolve => { acknowledgeCompilation = resolve; }))
      .mockResolvedValue({ stdout: "focused" });
    const { runMacosNativeFocus } = await import("../e2e/desktop/support/compiled-macos-native-focus");
    const first = runMacosNativeFocus(shortcut, 15_000);
    const second = runMacosNativeFocus(focus, 30_000);
    expect(execute).toHaveBeenCalledExactlyOnceWith("/usr/bin/xcrun", [
      "swiftc", fileURLToPath(new URL("../e2e/desktop/support/macos-native-focus.swift", import.meta.url)),
      "-o", resolve(artifactDirectory, "macos-native-focus")
    ], { encoding: "utf8", timeout: expect.any(Number) });
    const compilationBudget = execute.mock.calls[0]![2].timeout as number;
    expect(compilationBudget).toBeGreaterThan(30_000);
    acknowledgeCompilation({ stdout: "" });
    await Promise.all([first, second]);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(execute.mock.calls.slice(1)).toEqual([
      [resolve(artifactDirectory, "macos-native-focus"), shortcut, { encoding: "utf8", timeout: 15_000 }],
      [resolve(artifactDirectory, "macos-native-focus"), focus, { encoding: "utf8", timeout: 30_000 }]
    ]);
  });

  it("retains a rejected compilation and its termination evidence without input or recompilation", async () => {
    const cause = Object.assign(new Error("compiler stopped"), {
      code: "ETIMEDOUT", signal: "SIGTERM", killed: true,
      stdout: "compiler stage reached", stderr: "SDK compilation interrupted"
    });
    execute.mockRejectedValue(cause);
    const { runMacosNativeFocus } = await import("../e2e/desktop/support/compiled-macos-native-focus");
    const first = await runMacosNativeFocus(shortcut, 15_000).catch(error => error as Error);
    expect(first).toMatchObject({ cause, message: expect.stringMatching(
      /Compile macos-native-focus failed after \d+ms .*code=ETIMEDOUT, killed=true, signal=SIGTERM.*SDK compilation interrupted.*compiler stage reached/u
    ) });
    await expect(runMacosNativeFocus(focus, 30_000)).rejects.toBe(first);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("preserves the action deadline and unknown delivery failure without replaying native input", async () => {
    const cause = Object.assign(new Error("native helper stopped"), {
      code: null, signal: "SIGTERM", killed: true, stdout: "", stderr: "exact native input interrupted"
    });
    execute.mockResolvedValueOnce({ stdout: "" }).mockRejectedValueOnce(cause);
    const { runMacosNativeFocus } = await import("../e2e/desktop/support/compiled-macos-native-focus");
    await expect(runMacosNativeFocus(shortcut, 15_000)).rejects.toMatchObject({
      cause, message: expect.stringMatching(
        /Run macos-native-focus shortcut failed after \d+ms .*killed=true, signal=SIGTERM.*exact native input interrupted/u
      )
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1]).toEqual([resolve(artifactDirectory, "macos-native-focus"), shortcut,
      { encoding: "utf8", timeout: 15_000 }]);
  });

  it("does not share an executable or a failed compiler across isolated phase directories", async () => {
    execute.mockRejectedValueOnce(new Error("first phase compiler failed"))
      .mockResolvedValue({ stdout: "focused" });
    const { runMacosNativeFocus } = await import("../e2e/desktop/support/compiled-macos-native-focus");
    await expect(runMacosNativeFocus(shortcut, 15_000)).rejects.toThrow("Compile macos-native-focus");
    const nextPhase = resolve("native-focus-next-phase-fixture");
    vi.stubEnv("RION_STUDIO_E2E_ARTIFACT_DIR", nextPhase);
    await runMacosNativeFocus(shortcut, 15_000);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(execute.mock.calls[1]![1].at(-1)).toBe(resolve(nextPhase, "macos-native-focus"));
    expect(execute.mock.calls[2]![0]).toBe(resolve(nextPhase, "macos-native-focus"));
  });

  it.each([undefined, "", "relative-phase"])("rejects an unowned phase directory %s before compiling or input", async directory => {
    if (directory === undefined) delete process.env.RION_STUDIO_E2E_ARTIFACT_DIR;
    else vi.stubEnv("RION_STUDIO_E2E_ARTIFACT_DIR", directory);
    const { runMacosNativeFocus } = await import("../e2e/desktop/support/compiled-macos-native-focus");
    await expect(runMacosNativeFocus(shortcut, 15_000)).rejects.toThrow("absolute phase artifact directory");
    expect(execute).not.toHaveBeenCalled();
  });

  it("bounds native output diagnostics while retaining process exit attribution", async () => {
    const { boundedNativeProcessFailure } = await import("../e2e/desktop/support/compiled-macos-native-focus");
    const detail = boundedNativeProcessFailure({ code: 1, killed: false, signal: null,
      stdout: "x".repeat(20_000) + "native-tail", stderr: "SDK stderr" });
    expect(detail).toContain("code=1, killed=false, signal=none");
    expect(detail).toContain("native-tail");
    expect(detail.length).toBeLessThan(2_100);
  });
});
