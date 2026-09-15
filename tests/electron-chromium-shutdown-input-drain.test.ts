import { describe, expect, it, vi } from "vitest";
import type { CoreAddonClient } from "../src/electron/core/coreAddonClient";
import type { CoreCommand } from "../src/shared/generated";
import { deferred } from "../src/electron/main/macosAppKitRuntimeHostSupport";
import { drainChromiumShutdownInput } from "../src/electron/main/chromiumShutdownInputDrain";

describe("Chromium shutdown input drain", () => {
  it("fences the complete cohort then waits for exact release receipts", async () => {
    const release = deferred<void>();
    const commands: CoreCommand[] = [];
    const invoke = vi.fn(async (command: CoreCommand) => {
      commands.push(command);
      if (command.type !== "macroInputFence" && command.type !== "macroInputDrain") throw new Error("unexpected command");
      if (command.type === "macroInputDrain") await release.promise;
      return { roleId: command.roleId, inputEpoch: 7, current: true };
    });
    const completed = vi.fn();
    const drain = drainChromiumShutdownInput({ invoke: invoke as CoreAddonClient["invoke"] }, ["a", "b", "a"]).then(completed);
    await vi.waitFor(() => expect(commands).toHaveLength(4));
    expect(commands.map(command => command.type)).toEqual([
      "macroInputFence", "macroInputFence", "macroInputDrain", "macroInputDrain"
    ]);
    expect(completed).not.toHaveBeenCalled();
    release.resolve();
    await drain;
    expect(completed).toHaveBeenCalledOnce();
  });
  it.each(["epoch", "role", "not-current", "failure"])("rejects %s release without retrying", async fault => {
    const invoke = vi.fn(async (command: CoreCommand) => {
      if (command.type !== "macroInputFence" && command.type !== "macroInputDrain") throw new Error("unexpected command");
      if (command.type === "macroInputFence") return { roleId: command.roleId, inputEpoch: 7, current: true };
      if (fault === "failure") throw new Error("release failed");
      return { roleId: fault === "role" ? "other" : command.roleId,
        inputEpoch: fault === "epoch" ? 8 : 7, current: fault !== "not-current" };
    });
    await expect(drainChromiumShutdownInput({ invoke: invoke as CoreAddonClient["invoke"] }, ["a"])).rejects.toThrow();
    expect(invoke).toHaveBeenCalledTimes(2);
  });
  it("finishes draining a sibling even when another role cannot be fenced", async () => {
    const invoke = vi.fn(async (command: CoreCommand) => {
      if (command.type !== "macroInputFence" && command.type !== "macroInputDrain") throw new Error("unexpected command");
      if (command.roleId === "bad") throw new Error("fence failed");
      return { roleId: command.roleId, inputEpoch: 1, current: true };
    });
    await expect(drainChromiumShutdownInput({ invoke: invoke as CoreAddonClient["invoke"] }, ["good", "bad"])).rejects.toThrow("fence failed");
    expect(invoke).toHaveBeenCalledWith({ type: "macroInputDrain", roleId: "good", inputEpoch: 1 });
  });
});
