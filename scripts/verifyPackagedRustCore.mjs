import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const [executableArgument, addonArgument] = process.argv.slice(2);
if (!executableArgument || !addonArgument) {
  throw new Error("Usage: verifyPackagedRustCore.mjs <electron-executable> <addon-path>");
}
const executablePath = resolve(repositoryRoot, executableArgument);
const addonPath = resolve(repositoryRoot, addonArgument);
const verificationScript = resolve(repositoryRoot, "scripts/verifyRustCore.mjs");
await Promise.all([access(executablePath), access(addonPath)]);

await new Promise((resolveVerification, rejectVerification) => {
  const child = spawn(executablePath, [verificationScript, addonPath], {
    cwd: repositoryRoot,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: "inherit",
    windowsHide: true
  });
  child.once("error", rejectVerification);
  child.once("exit", (code, signal) => {
    if (code === 0) {
      resolveVerification();
      return;
    }
    rejectVerification(new Error(
      signal
        ? `Packaged Electron verification was terminated by ${signal}.`
        : `Packaged Electron verification exited with code ${code ?? "unknown"}.`
    ));
  });
});
