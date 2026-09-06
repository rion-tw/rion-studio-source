import { resolve } from "node:path";
import { build } from "vite";
import { resolveConfig } from "electron-vite";
import { afterEach, describe, expect, it } from "vitest";
import { electronMainBundleGuard } from "../scripts/electronMainBundleGuard.mjs";

describe("Electron executable main bundles", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });
  it("rejects missing and empty executable entries, including whitespace output", () => {
    const plugin = electronMainBundleGuard();
    const invalid: Array<Parameters<typeof plugin.generateBundle>[1]> = [{}, { entry: { type: "chunk", isEntry: true, code: " \n" } },
      { helper: { type: "chunk", isEntry: false, code: "export const value = 1" } }];
    for (const bundle of invalid) {
      expect(() => plugin.generateBundle({}, bundle)).toThrow("empty or missing executable entry");
    }
    expect(() => plugin.generateBundle({}, { entry: { type: "chunk", isEntry: true, code: "start();" } })).not.toThrow();
  });

  it.each(["production", "e2e"] as const)("builds the actual %s entry with the pinned Electron plugins", async mode => {
    const resolved = await resolveConfig({ configFile: "electron.vite.config.ts" }, "build", "production");
    const config = resolved.config?.main;
    if (!config) throw new Error("The Electron main build configuration is absent.");
    config.build = { ...config.build, write: false, rollupOptions: { ...config.build?.rollupOptions,
      input: { index: resolve(mode === "e2e" ? "src/electron/e2e/entry.ts" : "src/electron/main/index.ts") },
      output: { codeSplitting: false, format: "es" }
    } };
    config.logLevel = "silent";
    const result = await build(config);
    if (!("output" in result)) throw new Error("Expected one in-memory main build.");
    const main = result.output.find(output => output.type === "chunk" && output.isEntry);
    if (!main || main.type !== "chunk") throw new Error("The executable main entry is absent.");
    expect(main.code).toContain("ELECTRON_STARTUP_FAILED");
    expect(main.code).toContain("createWindowsChromiumTrustedInputRuntime");
    expect(main.code).toContain("readWindowsRuntimeForeground");
    expect(main.code.includes("rion:e2e:invoke")).toBe(mode === "e2e");
    if (mode === "e2e") expect(main.code).toContain("retainedV22Precondition");
  });
});
