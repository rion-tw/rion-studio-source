import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("desktop E2E build isolation", () => {
  it("keeps WebDriver permissions out of the production Tauri config", async () => {
    const config = JSON.parse(await readFile("src-tauri/tauri.conf.json", "utf8"));
    expect(config.app.withGlobalTauri).not.toBe(true);
    expect(JSON.stringify(config.app.security.capabilities ?? []))
      .not.toMatch(/wdio|desktop-e2e/iu);
  });

  it("compiles the control plane only behind the desktop-e2e feature", async () => {
    const source = await readFile("src-tauri/src/lib.rs", "utf8");
    expect(source).toContain("#[cfg(feature = \"desktop-e2e\")]\nmod desktop_e2e;");
    const control = await readFile("src-tauri/src/desktop_e2e.rs", "utf8");
    expect(control).toContain("#[cfg(not(debug_assertions))]");
    expect(control).toContain("compile_error!");
  });

  it("grants native runtime evidence commands only in the desktop E2E capability", async () => {
    const config = JSON.parse(await readFile("src-tauri/tauri.e2e.conf.json", "utf8"));
    const capabilities = config.app.security.capabilities as Array<{
      identifier?: string;
      permissions?: string[];
    }>;
    const debug = capabilities.find((capability) =>
      capability.identifier === "desktop-e2e-debug-only"
    );
    expect(debug?.permissions).toEqual(expect.arrayContaining([
      "allow-desktop-e2e-input-diagnostics",
      "allow-desktop-e2e-runtime-ui-action"
    ]));
  });
});
