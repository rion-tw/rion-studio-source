import { spawn } from "node:child_process";
import process from "node:process";

// Node no longer permits directly spawning .cmd/.bat files on Windows. Invoke
// cmd.exe explicitly so arguments stay out of Node's deprecated `shell: true`
// path, while native .exe and resolved Cargo executables remain direct.
export function spawnPlatformCommand(executable, args, options = {}) {
  if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(executable)) {
    return spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", executable, ...args], {
      ...options,
      windowsVerbatimArguments: false
    });
  }
  return spawn(executable, args, options);
}
