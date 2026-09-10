import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  assertMacosGameModeInfo,
  createMacosGameModeDevelopmentBundle,
  MACOS_GAME_MODE_CATEGORY,
  MACOS_GAME_MODE_DEVELOPMENT_BUNDLE_ID,
  MACOS_GAME_MODE_DEVELOPMENT_NAME,
  resolveElectronMacosApplicationPath,
  type MacosGameModeDevelopmentBundle
} from "../scripts/electronMacosGameModeBundle.mjs";
import {
  electronDevLaunchSpec,
  runElectronDev
} from "../scripts/runElectronDev.mjs";

const DEVELOPMENT_EXECUTABLE =
  "/private/tmp/Rion Studio Dev.app/Contents/MacOS/Electron";

function preparedBundle(cleanup = vi.fn(async () => undefined)):
MacosGameModeDevelopmentBundle {
  return {
    applicationPath: "/private/tmp/Rion Studio Dev.app",
    cleanup,
    executablePath: DEVELOPMENT_EXECUTABLE,
    info: {
      CFBundleDisplayName: MACOS_GAME_MODE_DEVELOPMENT_NAME,
      CFBundleIdentifier: MACOS_GAME_MODE_DEVELOPMENT_BUNDLE_ID,
      CFBundleName: MACOS_GAME_MODE_DEVELOPMENT_NAME,
      LSApplicationCategoryType: MACOS_GAME_MODE_CATEGORY,
      LSSupportsGameMode: true
    },
    privateRoot: "/private/tmp/rion-electron-game-mode-test",
    sourceApplicationPath: "/repository/node_modules/electron/dist/Electron.app"
  };
}

function childThatCloses(exitCode = 0): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    kill: vi.fn(() => true),
    signalCode: null as NodeJS.Signals | null
  });
  queueMicrotask(() => {
    child.exitCode = exitCode;
    child.emit("close", exitCode, null);
  });
  return child as unknown as ChildProcess;
}

describe("macOS Electron Game Mode development bundle", () => {
  it("accepts only an absolute normalized Electron.app executable path", () => {
    const executable = resolve(
      "fixture/Electron.app/Contents/MacOS/Electron"
    );
    expect(resolveElectronMacosApplicationPath(executable)).toBe(
      resolve("fixture/Electron.app")
    );
    expect(() => resolveElectronMacosApplicationPath(
      "fixture/Electron.app/Contents/MacOS/Electron"
    )).toThrow("absolute and normalized");
    expect(() => resolveElectronMacosApplicationPath(
      resolve("fixture/NotElectron.app/Contents/MacOS/Electron")
    )).toThrow("pinned Electron.app executable");
  });

  it("requires exact Game Mode values and types", () => {
    const valid = {
      CFBundleDisplayName: MACOS_GAME_MODE_DEVELOPMENT_NAME,
      CFBundleIdentifier: MACOS_GAME_MODE_DEVELOPMENT_BUNDLE_ID,
      CFBundleName: MACOS_GAME_MODE_DEVELOPMENT_NAME,
      LSApplicationCategoryType: MACOS_GAME_MODE_CATEGORY,
      LSSupportsGameMode: true
    };
    expect(() => assertMacosGameModeInfo(valid, { development: true }))
      .not.toThrow();
    expect(() => assertMacosGameModeInfo({
      ...valid,
      LSSupportsGameMode: "true"
    }, { development: true })).toThrow("LSSupportsGameMode");
    expect(() => assertMacosGameModeInfo({
      ...valid,
      LSApplicationCategoryType: "public.app-category.developer-tools"
    }, { development: true })).toThrow("LSApplicationCategoryType");
  });

  it.runIf(process.platform === "darwin")(
    "copies and verifies all development metadata without changing the source",
    async () => {
      const fixtureRoot = await mkdtemp(join(tmpdir(), "rion-game-mode-source-"));
      const sourceApplication = join(fixtureRoot, "Electron.app");
      const sourceExecutable = join(
        sourceApplication,
        "Contents",
        "MacOS",
        "Electron"
      );
      const sourceInfoPath = join(sourceApplication, "Contents", "Info.plist");
      const sourceInfo = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleDisplayName</key><string>Electron</string>
<key>CFBundleExecutable</key><string>Electron</string>
<key>CFBundleIdentifier</key><string>com.github.Electron</string>
<key>CFBundleName</key><string>Electron</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
</dict></plist>
`;
      let bundle: MacosGameModeDevelopmentBundle | undefined;
      try {
        await mkdir(join(sourceApplication, "Contents", "MacOS"), {
          recursive: true
        });
        await Promise.all([
          writeFile(sourceExecutable, "fixture executable"),
          writeFile(sourceInfoPath, sourceInfo)
        ]);
        const originalSourceInfo = await readFile(sourceInfoPath);

        bundle = await createMacosGameModeDevelopmentBundle(sourceExecutable);

        expect(bundle.info).toEqual(expect.objectContaining({
          CFBundleDisplayName: MACOS_GAME_MODE_DEVELOPMENT_NAME,
          CFBundleIdentifier: MACOS_GAME_MODE_DEVELOPMENT_BUNDLE_ID,
          CFBundleName: MACOS_GAME_MODE_DEVELOPMENT_NAME,
          LSApplicationCategoryType: MACOS_GAME_MODE_CATEGORY,
          LSSupportsGameMode: true
        }));
        expect(bundle.applicationPath).toBe(join(
          bundle.privateRoot,
          `${MACOS_GAME_MODE_DEVELOPMENT_NAME}.app`
        ));
        expect((await stat(bundle.privateRoot)).mode & 0o777).toBe(0o700);
        expect(await readFile(sourceInfoPath)).toEqual(originalSourceInfo);

        await bundle.cleanup();
        await bundle.cleanup();
        await expect(stat(bundle.privateRoot)).rejects.toMatchObject({
          code: "ENOENT"
        });
      } finally {
        await bundle?.cleanup();
        await rm(fixtureRoot, { force: true, recursive: true });
      }
    }
  );
});

describe("Electron development launcher", () => {
  it("routes pnpm dev:electron through the fail-closed wrapper", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(packageJson.scripts?.["dev:electron"]).toBe(
      "pnpm run build:electron:rust && node scripts/runElectronDev.mjs"
    );
  });

  it("forwards CLI arguments through the prepared macOS executable", () => {
    expect(electronDevLaunchSpec({
      arguments: ["--host", "127.0.0.1"],
      electronExecutable: DEVELOPMENT_EXECUTABLE,
      environment: { RION_EXISTING: "1" },
      platform: "darwin"
    })).toEqual({
      args: [
        "exec",
        "electron-vite",
        "dev",
        "--config",
        "electron.vite.config.ts",
        "--host",
        "127.0.0.1"
      ],
      command: "pnpm",
      environment: {
        ELECTRON_EXEC_PATH: DEVELOPMENT_EXECUTABLE,
        RION_EXISTING: "1"
      }
    });
  });

  it("keeps the Windows launch path unchanged", async () => {
    const prepareBundle = vi.fn();
    const spawnCommand = vi.fn(() => childThatCloses(0));
    await expect(runElectronDev(["--inspect"], {
      environment: { RION_EXISTING: "1" },
      platform: "win32",
      prepareBundle,
      spawnCommand
    })).resolves.toBe(0);
    expect(prepareBundle).not.toHaveBeenCalled();
    expect(spawnCommand).toHaveBeenCalledWith(
      "pnpm.cmd",
      [
        "exec",
        "electron-vite",
        "dev",
        "--config",
        "electron.vite.config.ts",
        "--inspect"
      ],
      expect.objectContaining({ env: { RION_EXISTING: "1" } })
    );
  });

  it("cleans the temporary bundle after normal exit", async () => {
    const cleanup = vi.fn(async () => undefined);
    await expect(runElectronDev([], {
      environment: {},
      platform: "darwin",
      prepareBundle: vi.fn(async () => preparedBundle(cleanup)),
      resolveElectronExecutable: () =>
        "/repository/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
      spawnCommand: vi.fn(() => childThatCloses(0))
    })).resolves.toBe(0);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143]
  ] as const)("forwards %s and cleans the temporary bundle", async (signal, code) => {
    const cleanup = vi.fn(async () => undefined);
    const signals = new EventEmitter();
    const eventChild = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill: vi.fn()
    });
    eventChild.kill.mockImplementation((forwardedSignal: NodeJS.Signals) => {
      eventChild.signalCode = forwardedSignal;
      queueMicrotask(() => eventChild.emit("close", null, forwardedSignal));
      return true;
    });
    const child = eventChild as unknown as ChildProcess;
    const result = runElectronDev([], {
      environment: {},
      platform: "darwin",
      prepareBundle: vi.fn(async () => preparedBundle(cleanup)),
      resolveElectronExecutable: () =>
        "/repository/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
      signalEmitter: signals as unknown as Pick<NodeJS.Process, "off" | "on">,
      spawnCommand: vi.fn(() => child)
    });
    queueMicrotask(() => signals.emit(signal));

    await expect(result).resolves.toBe(code);
    expect(child.kill).toHaveBeenCalledWith(signal);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("fails closed when the macOS bundle cannot be prepared", async () => {
    const spawnCommand = vi.fn();
    await expect(runElectronDev([], {
      platform: "darwin",
      prepareBundle: vi.fn(async () => {
        throw new Error("bundle preparation failed");
      }),
      resolveElectronExecutable: () =>
        "/repository/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
      spawnCommand
    })).rejects.toThrow("bundle preparation failed");
    expect(spawnCommand).not.toHaveBeenCalled();
  });
});
