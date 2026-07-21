import { describe, expect, it } from "vitest";

import { resolveCargoExecutable } from "../scripts/cargoExecutable.mjs";

function usablePaths(...paths: string[]) {
  const available = new Set(paths);
  return async (path: string) => available.has(path);
}

describe("Rust cargo executable resolution", () => {
  it("uses cargo from PATH on macOS", async () => {
    await expect(resolveCargoExecutable({
      environment: { PATH: "/usr/bin:/opt/rust/bin" },
      homeDirectory: "/Users/rion",
      isUsable: usablePaths("/opt/rust/bin/cargo"),
      platform: "darwin"
    })).resolves.toBe("/opt/rust/bin/cargo");
  });

  it("finds the rustup default when a GUI shell omits .cargo/bin from PATH", async () => {
    await expect(resolveCargoExecutable({
      environment: { PATH: "/usr/bin:/bin" },
      homeDirectory: "/Users/rion",
      isUsable: usablePaths("/Users/rion/.cargo/bin/cargo"),
      platform: "darwin"
    })).resolves.toBe("/Users/rion/.cargo/bin/cargo");
  });

  it("honors CARGO_HOME and an explicit CARGO override", async () => {
    await expect(resolveCargoExecutable({
      environment: { CARGO_HOME: "/opt/cargo", PATH: "/usr/bin" },
      homeDirectory: "/Users/rion",
      isUsable: usablePaths("/opt/cargo/bin/cargo"),
      platform: "linux"
    })).resolves.toBe("/opt/cargo/bin/cargo");

    await expect(resolveCargoExecutable({
      environment: { CARGO: "/toolchains/stable/cargo", PATH: "/usr/bin" },
      homeDirectory: "/Users/rion",
      isUsable: usablePaths("/toolchains/stable/cargo"),
      platform: "darwin"
    })).resolves.toBe("/toolchains/stable/cargo");
  });

  it("resolves cargo.exe using Windows environment key and extension rules", async () => {
    await expect(resolveCargoExecutable({
      environment: {
        Path: String.raw`C:\Windows\System32;C:\Rust\bin`,
        PATHEXT: ".EXE;.CMD"
      },
      homeDirectory: String.raw`C:\Users\rion`,
      isUsable: usablePaths(String.raw`C:\Rust\bin\cargo.EXE`),
      platform: "win32"
    })).resolves.toBe(String.raw`C:\Rust\bin\cargo.EXE`);
  });

  it("returns an actionable error when Rust is not installed", async () => {
    await expect(resolveCargoExecutable({
      environment: { PATH: "/usr/bin:/bin" },
      homeDirectory: "/Users/rion",
      isUsable: async () => false,
      platform: "darwin"
    })).rejects.toThrow("Install Rust with rustup");
  });
});
