import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { installElectronDesktopE2eViewInputObservationObserver as install } from "../src/electron/e2e/viewInputObservationObserver";
import type { ChromiumViewInputObservation } from "../src/electron/main/chromiumViewInputSubmission";

describe.each(["macos", "windows"] as const)("%s exact input admission observation", platform => {
  it("returns the original sample and records it after admission without rereading native state", async () => {
    const directory = mkdtempSync(join(tmpdir(), `rion-${platform}-input-observer-`));
    const output = join(directory, "electron-view-input-observations.json");
    const identity = { roleId: "role", surfaceGeneration: 1, nativeGeneration: 2,
      bindingRevision: "3", parentIdentity: "a".repeat(64), webContentsId: 4 };
    const bounds = { x: 0, y: 0, width: 400, height: 300 };
    const sample: ChromiumViewInputObservation = { identity, focusIdentity: "b".repeat(64),
      parentForeground: false, parentVisible: true, parentMinimized: false,
      viewAttached: true, viewVisible: true, contentsDestroyed: false, contentsFocused: true,
      focusedWebContentsId: 4, bounds, zoomFactor: 1 };
    const observe = vi.fn(() => sample);
    const input = {};
    const resolve = vi.fn(() => ({ identity, input, observe }));
    const prototype = { resolve } as unknown as Parameters<typeof install>[0];
    try {
      install(prototype, directory);
      const attachment = prototype.resolve("role", 1)!;
      expect(resolve).toHaveBeenCalledExactlyOnceWith("role", 1);
      expect(attachment.input).toBe(input);
      expect(attachment.identity).toBe(identity);
      expect(attachment.observe()).toBe(sample);
      expect(observe).toHaveBeenCalledTimes(1);
      expect(existsSync(output)).toBe(false);
      bounds.width = 500;
      await new Promise<void>(accept => queueMicrotask(accept));
      expect(JSON.parse(readFileSync(output, "utf8"))).toEqual([
        { sequence: 1, observation: { ...sample, bounds: { ...sample.bounds, width: 400 } } }
      ]);
      const failure = new Error("retired native owner");
      observe.mockImplementation(() => { throw failure; });
      expect(() => attachment.observe()).toThrow(failure);
      expect(observe).toHaveBeenCalledTimes(2);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("preserves unavailable attachments and does not install without an artifact path", () => {
    const prototype = { resolve: vi.fn(() => null) };
    const original = prototype.resolve;
    install(prototype, undefined);
    expect(prototype.resolve).toBe(original);
    install(prototype, "relative-output");
    expect(prototype.resolve).toBe(original);
    expect(prototype.resolve()).toBeNull();
  });
});
