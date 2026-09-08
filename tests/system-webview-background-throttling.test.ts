import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("does not restore the retired background-throttling override", async () => {
  const bootstrap = await readFile("crates/rion-core/src/bootstrap_settings.rs", "utf8");
  expect(bootstrap).not.toContain("disable-background-timer-throttling");
});
