import { describe, expect, it } from "vitest";
import { buildMacosAppKitRuntimeWindowOptions } from "../src/electron/main/macosAppKitRuntimeWindowOptions";
import { buildWindowsRuntimeHostWindowOptions } from "../src/electron/main/windowsRuntimeHostWindowOptions";
import { Fixture, target } from "./support/macosAppKitRuntimeHostFactoryFixtures";

describe.each(["darwin", "win32"])("Core-owned runtime title (%s)", (platform) => {
  it.each([undefined, "Saved window"])("preserves the persisted name %s", (persistedName) => {
    const input = { ...target(), persistedName };
    const options = platform === "darwin" ? buildMacosAppKitRuntimeWindowOptions(input)
      : buildWindowsRuntimeHostWindowOptions(input);
    expect(options.title).toBe(persistedName ?? "");
  });
});

it("keeps the temporary AppKit controller name empty", async () => {
  const fixture = new Fixture();
  await fixture.factory.createEmpty({ ...target(), persistedName: undefined }, {
    attemptGeneration: "temporary-window", windowGeneration: 1, topologyRevision: 1
  });
  expect(fixture.addon.controllers[0]!.windowName).toBe("");
  expect(fixture.order).toContain("controller-window-name-");
});

it("restores an absent AppKit title when the first rename fails after mutation", async () => {
  const fixture = new Fixture();
  const host = await fixture.factory.createEmpty({ ...target(), persistedName: undefined }, {
    attemptGeneration: "temporary-window", windowGeneration: 1, topologyRevision: 1
  });
  const controller = fixture.addon.controllers[0]!;
  controller.windowNameFailures.add("Failed rename");
  expect(() => fixture.factory.applyWindowName(host.appKitIdentity!, "Failed rename"))
    .toThrow("native window-name Failed rename failed after mutation");
  expect(controller.windowName).toBe("");
  expect(fixture.onError).not.toHaveBeenCalled();
});
