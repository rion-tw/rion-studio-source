import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(root, path), "utf8")) as Record<string, unknown>;
}

describe("Tauri Preview shell", () => {
  it("uses a distinct Preview identifier and the shared renderer build", async () => {
    const config = await readJson("src-tauri/tauri.conf.json");
    const build = config.build as Record<string, unknown>;
    const app = config.app as { windows: Array<Record<string, unknown>> };

    expect(config.identifier).toBe("com.rionstudio.preview");
    expect(build.frontendDist).toBe("../out/renderer");
    expect(build.beforeBuildCommand).toBe("pnpm run build:tauri:renderer");
    expect(app.windows[0]).toMatchObject({
      label: "main",
      minWidth: 960,
      minHeight: 640,
      visible: true
    });
  });

  it("grants only the local main window the default core capability", async () => {
    const capability = await readJson("src-tauri/capabilities/main.json");
    expect(capability).toMatchObject({
      identifier: "main-local-only",
      windows: ["main"],
      permissions: ["core:default"]
    });
    expect(capability).not.toHaveProperty("remote");
  });

  it("links rion-core directly and keeps the shared data lock in core", async () => {
    const [manifest, shellSource, coreSource] = await Promise.all([
      readFile(join(root, "src-tauri/Cargo.toml"), "utf8"),
      readFile(join(root, "src-tauri/src/lib.rs"), "utf8"),
      readFile(join(root, "crates/rion-core/src/app.rs"), "utf8")
    ]);

    expect(manifest).toContain('rion-core = { path = "../crates/rion-core" }');
    expect(shellSource).toContain('const SHARED_DATA_DIRECTORY_NAME: &str = "Rion Studio"');
    expect(shellSource).toContain("AppCore::create");
    expect(coreSource).toContain('const INSTANCE_LOCK_FILE_NAME: &str = "rion-studio.instance.lock"');
    expect(coreSource).toContain("try_lock_exclusive");
    expect(coreSource).toContain('"APP_INSTANCE_LOCKED"');
  });

  it("installs one typed window.rionStudio bridge before rendering React", async () => {
    const [entry, bridge, runtime] = await Promise.all([
      readFile(join(root, "src/renderer/src/main.tsx"), "utf8"),
      readFile(join(root, "src/renderer/src/tauri/installTauriBridge.ts"), "utf8"),
      readFile(join(root, "src-tauri/src/system_runtime.rs"), "utf8")
    ]);

    expect(entry.indexOf("await installTauriBridgeIfNeeded()"))
      .toBeLessThan(entry.indexOf("ReactDOM.createRoot"));
    expect(bridge).toContain("const api: RionStudioApi");
    expect(bridge).toContain('invoke<CoreCommandResult<C>>("rion_core_invoke"');
    expect(runtime).toContain("SystemRuntimeExecutor");
    expect(runtime).toContain("EmbeddedCreateTab");
    expect(runtime).toContain("EmbeddedApplyRuntime");
    expect(bridge).not.toContain("window.__TAURI_INTERNALS__.postMessage");
  });
});
