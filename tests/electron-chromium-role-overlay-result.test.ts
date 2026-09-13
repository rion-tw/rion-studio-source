import { describe, expect, it, vi } from "vitest";
import { captureChromiumRoleOverlayResult } from "../src/electron/ipc/chromiumRoleOverlayResult";
import { RionBridgeError } from "../src/electron/ipc/errors";

describe("overlay terminal envelopes", () => {
  it.each(["MACRO_ROLE_INPUT_FENCED", "MACRO_ROLE_INPUT_RECOVERING", "ELECTRON_MANAGED_SHORTCUT_SUPERSEDED"])(
    "preserves %s as an explicit refusal", async code => {
      const report = vi.fn();
      expect(await captureChromiumRoleOverlayResult(async () => {
        throw new RionBridgeError({ code, message: "exact admission reason" });
      }, report)).toEqual({ outcome: "rejected", error: { code, message: "exact admission reason" } });
      expect(report).not.toHaveBeenCalled();
    }
  );
  it("keeps uncertain cleanup and unknown failures actionable", async () => {
    const report = vi.fn();
    const error = { code: "SYSTEM_TRUSTED_INPUT_INDETERMINATE", message: "release unproven" };
    expect(await captureChromiumRoleOverlayResult(async () => { throw new RionBridgeError(error); }, report))
      .toEqual({ outcome: "failed", error });
    expect(report).toHaveBeenCalledWith(error);
  });
  it("keeps the original success receipt", async () => {
    expect(await captureChromiumRoleOverlayResult(async () => ({ cycle: "one" }), vi.fn()))
      .toEqual({ outcome: "success", value: { cycle: "one" } });
  });
});
