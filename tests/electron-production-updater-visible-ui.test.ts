import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  openVisibleProductionUpdaterSettings,
  pressVisibleProductionUpdaterCheck,
  pressVisibleProductionUpdaterInstall
} from "../scripts/electronProductionUpdaterVisibleUi.mjs";
import {
  runElectronProductionUpdaterVisibleUiCli
} from "../scripts/electronProductionUpdaterVisibleUiCli.mjs";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    force: true,
    recursive: true
  })));
});

describe("Electron production updater visible UI", () => {
  it.each([
    ["darwin", "runMacos"],
    ["win32", "runWindows"]
  ] as const)("presses the real %s settings, check, and install controls", async (
    platform,
    dependencyName
  ) => {
    const action = vi.fn(async () => undefined);
    const other = vi.fn(async () => undefined);
    const times = [
      "2026-09-02T00:00:00Z", "2026-09-02T00:00:01Z",
      "2026-09-02T00:00:02Z", "2026-09-02T00:00:03Z",
      "2026-09-02T00:00:04Z", "2026-09-02T00:00:05Z",
      "2026-09-02T00:00:06Z", "2026-09-02T00:00:07Z"
    ].map((value) => new Date(value));
    const dependencies = {
      now: () => times.shift()!,
      runMacos: dependencyName === "runMacos" ? action : other,
      runWindows: dependencyName === "runWindows" ? action : other
    };

    const opened = await openVisibleProductionUpdaterSettings(
      { platform, processId: 4242 },
      dependencies
    );
    const checked = await pressVisibleProductionUpdaterCheck(
      { platform, processId: 4242 },
      dependencies
    );
    const installed = await pressVisibleProductionUpdaterInstall(
      { platform, processId: 4242 },
      dependencies
    );

    expect(action.mock.calls).toEqual([
      [4242, "Settings"],
      [4242, "App update"],
      [4242, "Check updates"],
      [4242, "Restart and update"]
    ]);
    expect(other).not.toHaveBeenCalled();
    expect(opened).toMatchObject({
      interaction: "visible-os-accessibility-press",
      remoteDebugging: false,
      controls: [{ action: "settings" }, { action: "updates" }]
    });
    expect(checked).toMatchObject({ action: "check", processId: 4242 });
    expect(installed).toMatchObject({ action: "install", processId: 4242 });
  });

  it("rejects ambiguous input and time reversal before it can become evidence", async () => {
    expect(() => pressVisibleProductionUpdaterCheck({
      platform: "darwin",
      processId: 42,
      unknown: true
    } as never, { runMacos: async () => undefined })).toThrow(
      "input schema is not exact"
    );
    const times = [
      new Date("2026-09-02T00:00:02Z"),
      new Date("2026-09-02T00:00:01Z")
    ];
    await expect(pressVisibleProductionUpdaterInstall({
      platform: "win32",
      processId: 42
    }, {
      now: () => times.shift()!,
      runWindows: async () => undefined
    })).rejects.toThrow("completion cannot precede invocation");
  });

  it("writes a canonical create-new receipt through the closed CLI", async () => {
    const root = await mkdtemp(join(tmpdir(), "rion-visible-updater-ui-"));
    roots.push(root);
    const outputPath = join(root, "check-action.json");
    const runMacos = vi.fn(async () => undefined);
    const times = [
      new Date("2026-09-02T00:00:00Z"),
      new Date("2026-09-02T00:00:01Z")
    ];
    let stdout = Buffer.alloc(0);

    const summary = await runElectronProductionUpdaterVisibleUiCli([
      "check",
      "--platform", "darwin",
      "--process-id", "4242",
      "--output", outputPath
    ], {
      now: () => times.shift()!,
      runMacos,
      writeStdout: (source) => { stdout = Buffer.from(source); }
    });

    expect(JSON.parse(stdout.toString("utf8"))).toEqual(summary);
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toMatchObject({
      action: "check",
      processId: 4242,
      remoteDebugging: false
    });
    expect(runMacos).toHaveBeenCalledWith(4242, "Check updates");
    await expect(runElectronProductionUpdaterVisibleUiCli([
      "check",
      "--platform", "darwin",
      "--process-id", "4242",
      "--output", join(root, "other-check-action.json"),
      "--fallback", "debug"
    ])).rejects.toThrow("Unknown visible updater UI option --fallback");
  });
});
