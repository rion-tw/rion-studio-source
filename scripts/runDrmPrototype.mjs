import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { runElectronDev } from "./runElectronDev.mjs";

const userData = resolve(import.meta.dirname, "../.electron-cache/drm-manual-user-data");
await mkdir(userData, { recursive: true, mode: 0o700 });
const environment = { ...process.env, RION_STUDIO_USER_DATA_DIR: userData };
for (const key of Object.keys(environment)) {
  if (key.startsWith("RION_STUDIO_E2E_") || key === "RION_STUDIO_DESKTOP_E2E_BUILD") delete environment[key];
}
console.log(`Isolated DRM prototype data: ${userData}`);
process.exitCode = await runElectronDev([], { environment });
