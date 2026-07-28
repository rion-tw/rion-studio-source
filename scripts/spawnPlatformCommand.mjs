import { spawn } from "node:child_process";
import process from "node:process";

// Node no longer permits directly spawning .cmd/.bat files on Windows. Invoke
// cmd.exe explicitly so arguments stay out of Node's deprecated `shell: true`
// path, while native .exe and resolved Cargo executables remain direct.
export function platformCommandInvocation(executable, args, {
  environment = process.env,
  platform = process.platform
} = {}) {
  if (platform === "win32" && /\.(?:cmd|bat)$/i.test(executable)) {
    return {
      args: ["/d", "/s", "/c", executable, ...args],
      executable: environment.ComSpec || environment.COMSPEC || "cmd.exe",
      windowsVerbatimArguments: false
    };
  }
  return { args, executable };
}

export function spawnPlatformCommand(executable, args, options = {}) {
  const invocation = platformCommandInvocation(executable, args);
  return spawn(invocation.executable, invocation.args, {
    ...options,
    ...(invocation.windowsVerbatimArguments === undefined
      ? {}
      : { windowsVerbatimArguments: invocation.windowsVerbatimArguments })
  });
}
