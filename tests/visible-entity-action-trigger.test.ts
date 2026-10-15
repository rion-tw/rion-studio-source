import { describe, expect, it, vi } from "vitest";
import { waitForVisibleEntityActionTrigger } from "../e2e/desktop/support/visible-entity-action-trigger";

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const labels = ["Role actions", "Click for actions or drag to reorder"] as const;

function control(exists = true) {
  return {
    isExisting: vi.fn(async () => exists), isDisplayed: vi.fn(async () => false),
    waitForDisplayed: vi.fn(async (_options: { timeout: number; reverse: false }): Promise<void> => undefined),
    waitForClickable: vi.fn(async (_options: { timeout: number; reverse: false }): Promise<void> => undefined),
    click: vi.fn(async () => undefined)
  };
}

describe("visible entity action trigger readiness", () => {
  it("keeps an existing initially hidden trigger pending until positive visibility then clickability receipts", async () => {
    const trigger = control();
    const visible = deferred();
    const clickable = deferred();
    trigger.waitForDisplayed.mockImplementationOnce(() => visible.promise);
    trigger.waitForClickable.mockImplementationOnce(() => clickable.promise);
    const entity = { $: vi.fn(async () => trigger) };
    let returned = false;
    const selected = waitForVisibleEntityActionTrigger(entity, labels, "missing exact Role trigger");
    const clicked = selected.then(async current => { returned = true; await current.click(); return current; });
    await turn();
    expect(trigger.isDisplayed).not.toHaveBeenCalled();
    expect(trigger.waitForDisplayed).toHaveBeenCalledExactlyOnceWith({ timeout: 10_000, reverse: false });
    expect(trigger.waitForClickable).not.toHaveBeenCalled();
    expect(returned).toBe(false);
    expect(trigger.click).not.toHaveBeenCalled();
    visible.resolve();
    await turn();
    expect(trigger.waitForClickable).toHaveBeenCalledExactlyOnceWith({ timeout: 10_000, reverse: false });
    expect(returned).toBe(false);
    expect(trigger.click).not.toHaveBeenCalled();
    clickable.resolve();
    await expect(clicked).resolves.toBe(trigger);
    expect(trigger.click).toHaveBeenCalledTimes(1);
    expect(entity.$).toHaveBeenCalledExactlyOnceWith("button[aria-label='Role actions']");
  });

  it("retains label order and queries only the supplied exact entity", async () => {
    const absent = control(false);
    const present = control();
    const otherEntity = { $: vi.fn(async () => control()) };
    const entity = { $: vi.fn().mockResolvedValueOnce(absent).mockResolvedValueOnce(present) };
    await expect(waitForVisibleEntityActionTrigger(entity, labels, "missing")).resolves.toBe(present);
    expect(entity.$.mock.calls).toEqual(labels.map(label => [`button[aria-label='${label}']`]));
    expect(absent.waitForDisplayed).not.toHaveBeenCalled();
    expect(absent.waitForClickable).not.toHaveBeenCalled();
    expect(otherEntity.$).not.toHaveBeenCalled();
    expect(present.click).not.toHaveBeenCalled();
  });

  it("rejects absent exact labels without any visibility wait or click", async () => {
    const absent = control(false);
    const entity = { $: vi.fn(async () => absent) };
    await expect(waitForVisibleEntityActionTrigger(entity, labels, "Role exact-id has no action trigger"))
      .rejects.toThrow("Role exact-id has no action trigger");
    expect(entity.$).toHaveBeenCalledTimes(2);
    expect(absent.waitForDisplayed).not.toHaveBeenCalled();
    expect(absent.waitForClickable).not.toHaveBeenCalled();
    expect(absent.click).not.toHaveBeenCalled();
  });

  it.each(["permanently hidden", "occluded", "disabled"])("preserves the original %s readiness failure without choosing another control", async state => {
    const failure = new Error(state);
    const trigger = control();
    if (state === "permanently hidden") trigger.waitForDisplayed.mockRejectedValueOnce(failure);
    else trigger.waitForClickable.mockRejectedValueOnce(failure);
    const entity = { $: vi.fn(async () => trigger) };
    await expect(waitForVisibleEntityActionTrigger(entity, labels, "missing")).rejects.toBe(failure);
    expect(entity.$).toHaveBeenCalledTimes(1);
    expect(trigger.click).not.toHaveBeenCalled();
    if (state === "permanently hidden") expect(trigger.waitForClickable).not.toHaveBeenCalled();
  });

  it.each(["lookup", "presence"])("preserves a failed exact %s without retrying or searching another entity", async stage => {
    const failure = new Error(`exact ${stage} failed`);
    const trigger = control();
    const entity = { $: vi.fn(async () => trigger) };
    if (stage === "lookup") entity.$.mockRejectedValueOnce(failure);
    else trigger.isExisting.mockRejectedValueOnce(failure);
    await expect(waitForVisibleEntityActionTrigger(entity, labels, "missing")).rejects.toBe(failure);
    expect(entity.$).toHaveBeenCalledTimes(1);
    expect(trigger.waitForDisplayed).not.toHaveBeenCalled();
    expect(trigger.click).not.toHaveBeenCalled();
  });

  it("does not infer another action when no labels are authorized", async () => {
    const entity = { $: vi.fn(async () => control()) };
    await expect(waitForVisibleEntityActionTrigger(entity, [], "no authorized label")).rejects.toThrow("no authorized label");
    expect(entity.$).not.toHaveBeenCalled();
  });
});
