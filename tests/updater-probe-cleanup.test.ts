import { describe, expect, it, vi } from "vitest";
import { withUpdaterProbeCleanup } from "../scripts/updaterProbeCleanup.mjs";

describe("updater probe primary and cleanup outcomes", () => {
  it("returns the observed result only after required cleanup", async () => {
    const order: string[] = [];
    const result = { outcome: "observed" };
    await expect(withUpdaterProbeCleanup(async () => {
      order.push("probe"); return result;
    }, async () => { order.push("cleanup"); })).resolves.toBe(result);
    expect(order).toEqual(["probe", "cleanup"]);
  });

  it("preserves the original primary failure after successful cleanup", async () => {
    const primary = new Error("journal removal failed");
    const cleanup = vi.fn(async () => undefined);
    await expect(withUpdaterProbeCleanup(async () => { throw primary; }, cleanup))
      .rejects.toBe(primary);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("rejects successful observations when cleanup fails", async () => {
    const cleanup = new Error("target survived");
    await expect(withUpdaterProbeCleanup(async () => "observed", async () => { throw cleanup; }))
      .rejects.toBe(cleanup);
  });

  it.each([new Error("journal removal failed"), undefined])(
    "retains both exact failures in primary-first order: %s", async primary => {
      const cleanup = new Error("target survived");
      const result = withUpdaterProbeCleanup(async () => { throw primary; }, async () => { throw cleanup; });
      await expect(result).rejects.toBeInstanceOf(AggregateError);
      await expect(result).rejects.toMatchObject({ errors: [primary, cleanup], cause: primary });
    }
  );
});
