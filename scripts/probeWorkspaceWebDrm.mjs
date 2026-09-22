import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

if (!["darwin", "win32"].includes(process.platform)) throw new Error("Native macOS or Windows is required.");
const root = resolve(import.meta.dirname, "..");
const artifactRoot = resolve(root, ".desktop-e2e-artifacts", `drm-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`);
const prefix = process.platform === "darwin" ? "chromium-macos-appkit" : "chromium-windows";
const profile = `${prefix}-${process.argv.includes("--playback") ? "drm" : "smoke"}`;
const child = spawn(process.execPath, [join(root, "scripts/runDesktopE2e.mjs"), `--profile=${profile}`,
  "--phase=chromium-workspace-web-fullscreen-restart"], { cwd: root, stdio: "inherit",
  env: { ...process.env, RION_STUDIO_E2E_ARTIFACT_ROOT: artifactRoot, RION_STUDIO_E2E_DRM_DIAGNOSTIC: "1",
    RION_STUDIO_E2E_DRM_PLAYBACK: process.argv.includes("--playback") ? "1" : "0" } });
child.on("error", error => { console.error(error.message); process.exitCode = 1; });
child.on("exit", async code => {
  process.exitCode = code ?? 1;
  console.log(`DRM diagnostic artifacts: ${artifactRoot}`);
  const summarize = async () => {
    for (const entry of await readdir(artifactRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      for (const phase of ["seed", "restart"]) {
        const path = join(artifactRoot, entry.name, "phases", `chromium-workspace-web-fullscreen-${phase}`,
          "workspace-web-drm-capability.json");
        let report;
        try { report = JSON.parse(await readFile(path, "utf8")); }
        catch (error) { if (error.code === "ENOENT") continue; throw error; }
        console.log(JSON.stringify({ phase: report.phase, runtime: report.runtime,
          nextStage: report.capability.nextStage, acceptance: report.acceptance }, null, 2));
      }
    }
  };
  try { await summarize(); } catch (error) { console.error(error.message); process.exitCode = 1; }
});
