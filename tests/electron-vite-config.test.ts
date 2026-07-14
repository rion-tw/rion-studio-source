import { describe, expect, it } from "vitest";

import config from "../electron.vite.config";

describe("electron-vite configuration", () => {
  it("keeps Electron external in main and preload bundles", () => {
    expect(config.main?.build?.externalizeDeps).toEqual({ include: ["electron"] });
    expect(config.preload?.build?.externalizeDeps).toEqual({ include: ["electron"] });
  });
});
