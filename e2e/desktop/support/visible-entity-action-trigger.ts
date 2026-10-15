interface ActionTriggerReadiness {
  isExisting(): Promise<boolean>;
  waitForDisplayed(options: { timeout: number; reverse: false }): Promise<unknown>;
  waitForClickable(options: { timeout: number; reverse: false }): Promise<unknown>;
}

/** Presence selects the exact control; positive UI receipts decide readiness. */
export async function waitForVisibleEntityActionTrigger<Trigger extends ActionTriggerReadiness>(
  entity: { $(selector: string): Trigger | PromiseLike<Trigger> },
  labels: readonly string[],
  missingMessage: string
): Promise<Trigger> {
  for (const label of labels) {
    const candidate = await entity.$(`button[aria-label='${label}']`);
    if (!await candidate.isExisting()) continue;
    // Hover can expose an existing cover control on a later render. Never
    // mistake its first opacity-zero observation for an absent identity.
    await candidate.waitForDisplayed({ timeout: 10_000, reverse: false });
    await candidate.waitForClickable({ timeout: 10_000, reverse: false });
    return candidate;
  }
  throw new Error(missingMessage);
}
