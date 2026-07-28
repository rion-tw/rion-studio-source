import { describe, expect, it } from "vitest";

import { platformCommandInvocation } from "../scripts/spawnPlatformCommand.mjs";

describe("platform command invocation", () => {
  it.each(["pnpm.cmd", "tool.BAT"])(
    "routes Windows command script %s through cmd.exe without shell mode",
    (executable) => {
      expect(platformCommandInvocation(executable, ["exec", "tauri"], {
        environment: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
        platform: "win32"
      })).toEqual({
        args: ["/d", "/s", "/c", executable, "exec", "tauri"],
        executable: "C:\\Windows\\System32\\cmd.exe",
        windowsVerbatimArguments: false
      });
    }
  );

  it("falls back to cmd.exe when Windows does not expose ComSpec", () => {
    expect(platformCommandInvocation("pnpm.cmd", [], {
      environment: {},
      platform: "win32"
    })).toEqual({
      args: ["/d", "/s", "/c", "pnpm.cmd"],
      executable: "cmd.exe",
      windowsVerbatimArguments: false
    });
  });

  it.each([
    ["win32", "cargo.exe"],
    ["darwin", "pnpm.cmd"],
    ["linux", "pnpm"]
  ] as const)("keeps native %s command %s direct", (platform, executable) => {
    expect(platformCommandInvocation(executable, ["build"], {
      environment: {},
      platform
    })).toEqual({ args: ["build"], executable });
  });
});
