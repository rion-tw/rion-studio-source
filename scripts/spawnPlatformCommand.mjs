import { spawn } from "node:child_process";
import process from "node:process";

// Node no longer permits directly spawning .cmd/.bat files on Windows. The
// repository invokes pnpm through that wrapper in several platform scripts,
// while native .exe and the resolved cargo executable must remain direct.
export function spawnPlatformCommand(executable, args, options = {}) {
  const needsWindowsShell =
    process.platform === "win32" && /\.(?:cmd|bat)$/i.test(executable);
  return spawn(executable, args, {
    ...options,
    ...(needsWindowsShell ? { shell: true } : {})
  });
}
