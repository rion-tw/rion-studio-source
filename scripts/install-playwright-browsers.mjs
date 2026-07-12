import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const cliPath = resolve("node_modules", "playwright", "cli.js");

if (!existsSync(cliPath)) {
  console.warn("Playwright CLI not found; skipping browser installation.");
  process.exit(0);
}

const result = spawnSync(process.execPath, [cliPath, "install", "chromium"], {
  env: {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH: "0"
  },
  stdio: "inherit"
});

process.exit(result.status ?? 1);
