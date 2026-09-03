import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { createMacosUpdaterProbeSandboxProfile } from
  "../scripts/macosUpdaterProbeSandbox.mjs";

const execFileAsync = promisify(execFile);

describe("macOS updater probe Seatbelt", () => {
  it("runs the production-trust probe with Seatbelt and a closed parent env", async () => {
    const [workflow, probe] = await Promise.all([
      readFile(
        ".github/workflows/electron-updater-tauri-v22-compatibility.yml",
        "utf8"
      ),
      readFile("scripts/runElectronUpdaterTransactionProbe.mjs", "utf8")
    ]);
    const start = workflow.indexOf(
      "- name: Run macOS published-v22-input plus v23 layout replacement probe"
    );
    const end = workflow.indexOf(
      "- name: Run Windows published-v22-input plus v23 layout replacement probe without private signing material",
      start
    );
    const runtimeStep = workflow.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(runtimeStep).toContain("macosUpdaterProbeSandbox.mjs");
    expect(runtimeStep).toContain('/usr/bin/sandbox-exec -p "${sandbox_profile}"');
    expect(runtimeStep).toContain('/usr/bin/env -i "${runtime_environment[@]}"');
    expect(runtimeStep).toContain('"CFFIXED_USER_HOME=${runtime_home}"');
    expect(runtimeStep).not.toContain("GITHUB_ENV");
    expect(runtimeStep).not.toContain("GITHUB_OUTPUT");
    expect(runtimeStep).not.toContain("GITHUB_PATH");
    expect(runtimeStep).not.toContain("GITHUB_STEP_SUMMARY");
    expect(runtimeStep).not.toContain("NODE_OPTIONS");
    expect(runtimeStep).not.toContain("TAURI_SIGNING_");
    expect(runtimeStep).not.toContain("pnpm run");
    expect(probe).toContain('"test", "--locked", "--offline"');
  });

  it("allows writes only under closed runtime roots and denies escape tools", async () => {
    const testRoot = await mkdtemp(join(tmpdir(), "rion-updater-seatbelt-"));
    const runtimeRoot = join(testRoot, "runtime");
    const cargoTargetDirectory = join(runtimeRoot, "cargo-target");
    const runtimeHome = join(runtimeRoot, "runtime-home");
    const runtimeTemp = join(runtimeRoot, "runtime-temp");
    const deniedRoot = join(testRoot, "prepared-input");
    await Promise.all([
      mkdir(cargoTargetDirectory, { recursive: true }),
      mkdir(runtimeHome, { recursive: true }),
      mkdir(runtimeTemp, { recursive: true }),
      mkdir(deniedRoot)
    ]);
    try {
      const profile = await createMacosUpdaterProbeSandboxProfile({
        cargoTargetDirectory,
        runtimeHome,
        runtimeRoot,
        runtimeTemp
      });
      const canonicalRuntime = await realpath(runtimeRoot);
      expect(profile).toContain("(allow default)");
      expect(profile).toContain("(deny file-write*");
      expect(profile).toContain(
        `(subpath "${canonicalRuntime}")`
      );
      for (const executable of [
        "/bin/launchctl",
        "/usr/bin/open",
        "/usr/bin/osascript",
        "/usr/bin/sudo"
      ]) {
        expect(profile).toContain(`(literal "${executable}")`);
      }
      expect(profile).not.toContain('(literal "/usr/bin/sandbox-exec")');

      if (process.platform === "darwin") {
        const script = [
          "const fs = require('node:fs');",
          "for (const root of process.argv.slice(1, 5)) {",
          "  fs.writeFileSync(`${root}/allowed`, 'allowed');",
          "}",
          "fs.writeFileSync('/dev/null', 'allowed');",
          "let denied = false;",
          "try { fs.writeFileSync(`${process.argv[5]}/forbidden`, 'forbidden'); }",
          "catch (error) { denied = error?.code === 'EPERM' || error?.code === 'EACCES'; }",
          "if (!denied) process.exit(9);"
        ].join("\n");
        await execFileAsync("/usr/bin/sandbox-exec", [
          "-p", profile, process.execPath, "-e", script,
          runtimeRoot, cargoTargetDirectory, runtimeHome, runtimeTemp, deniedRoot
        ]);
        await expect(execFileAsync("/usr/bin/sandbox-exec", [
          "-p", profile,
          "/usr/bin/sandbox-exec", "-p",
          "(version 1) (allow default) (deny process-exec*)",
          "/usr/bin/true"
        ])).rejects.toThrow();
      }
    } finally {
      await rm(testRoot, { force: true, recursive: true });
    }
  });

  it("rejects writable roots that escape through a symlink", async () => {
    const testRoot = await mkdtemp(join(tmpdir(), "rion-updater-seatbelt-link-"));
    const runtimeRoot = join(testRoot, "runtime");
    const cargoTargetDirectory = join(runtimeRoot, "cargo-target");
    const runtimeTemp = join(runtimeRoot, "runtime-temp");
    const outsideHome = join(testRoot, "outside-home");
    const linkedHome = join(runtimeRoot, "runtime-home");
    await Promise.all([
      mkdir(cargoTargetDirectory, { recursive: true }),
      mkdir(runtimeTemp, { recursive: true }),
      mkdir(outsideHome)
    ]);
    await symlink(outsideHome, linkedHome, "dir");
    try {
      await expect(createMacosUpdaterProbeSandboxProfile({
        cargoTargetDirectory,
        runtimeHome: linkedHome,
        runtimeRoot,
        runtimeTemp
      })).rejects.toThrow("runtime home must be a real directory");
      await expect(createMacosUpdaterProbeSandboxProfile({
        cargoTargetDirectory,
        runtimeHome: `${outsideHome}\nunsafe`,
        runtimeRoot,
        runtimeTemp
      })).rejects.toThrow("one safe absolute path");
    } finally {
      await rm(testRoot, { force: true, recursive: true });
    }
  });
});
