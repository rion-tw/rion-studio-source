import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  return { execFile: Object.assign(vi.fn(), { [promisify.custom]: execute }) };
});

beforeEach(() => {
  vi.resetModules();
  execute.mockReset();
  vi.stubEnv("RION_STUDIO_E2E_ARTIFACT_DIR", resolve("native-helper-fixture"));
});
afterEach(() => vi.unstubAllEnvs());

describe("macOS Workspace native helper lifecycle", () => {
  it("shares one compilation acknowledgement before concurrent native requests", async () => {
    let complete!: (result: { stdout: string }) => void;
    execute.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }))
      .mockResolvedValue({ stdout: "native evidence" });
    const { runWorkspaceSwift } = await import("../e2e/desktop/support/compiled-workspace-swift");
    const first = runWorkspaceSwift("workspace-pixels", "first.json");
    const second = runWorkspaceSwift("workspace-pixels", "second.json");
    expect(execute).toHaveBeenCalledTimes(1);
    complete({ stdout: "" });
    expect(await Promise.all([first, second])).toEqual(["native evidence", "native evidence"]);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(execute.mock.calls[0]?.[2]).toEqual({ timeout: 120_000 });
    for (const call of execute.mock.calls.slice(1)) {
      expect(call[0]).toBe(resolve("native-helper-fixture/workspace-pixels"));
      expect(call[2]).toEqual({ timeout: 30_000 });
    }
  });

  it("retains compiler termination evidence and never runs or recompiles a failed helper", async () => {
    const cause = Object.assign(new Error("compiler stopped"), {
      code: "ETIMEDOUT", signal: "SIGTERM", killed: true, stderr: "SDK compilation interrupted"
    });
    execute.mockRejectedValue(cause);
    const { runWorkspaceSwift } = await import("../e2e/desktop/support/compiled-workspace-swift");
    for (const request of ["first.json", "second.json"]) {
      await expect(runWorkspaceSwift("workspace-pixels", request)).rejects.toMatchObject({
        cause, message: expect.stringMatching(/Compile workspace-pixels failed.*code=ETIMEDOUT, signal=SIGTERM, killed=true.*SDK compilation interrupted/u)
      });
    }
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("reports native ownership failure separately without retrying input", async () => {
    const cause = Object.assign(new Error("helper exited"), { code: 1, stderr: "exact window missing" });
    execute.mockResolvedValueOnce({ stdout: "" }).mockRejectedValueOnce(cause);
    const { runWorkspaceSwift } = await import("../e2e/desktop/support/compiled-workspace-swift");
    await expect(runWorkspaceSwift("workspace-window-resize", "resize.json")).rejects.toMatchObject({
      cause, message: expect.stringMatching(/Run workspace-window-resize failed.*code=1.*exact window missing/u)
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
