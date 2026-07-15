import { describe, expect, it } from "vitest";

import config from "../electron.vite.config";

describe("electron-vite configuration", () => {
  it("keeps Electron external in main and preload bundles", () => {
    expect(config.main?.build?.externalizeDeps).toEqual({ include: ["electron"] });
    expect(config.preload?.build?.externalizeDeps).toEqual({ include: ["electron"] });
  });

  it("does not emit source maps into packaged application bundles", () => {
    expect(config.main?.build?.sourcemap).toBe(false);
    expect(config.preload?.build?.sourcemap).toBe(false);
    expect(config.renderer?.build?.sourcemap).toBe(false);
  });
});
