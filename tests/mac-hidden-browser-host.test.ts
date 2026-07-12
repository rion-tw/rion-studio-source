import { chmod, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { getMacAppBundlePathFromExecutable, MacHiddenBrowserHost } from "../src/main/browser/MacHiddenBrowserHost";

describe("MacHiddenBrowserHost", () => {
  it("returns no executable override outside macOS", async () => {
    const getChromiumExecutablePath = vi.fn().mockResolvedValue("/tmp/Chromium");
    const userDataDir = await mkdtemp(join(tmpdir(), "rion-hidden-browser-test-"));
    const host = new MacHiddenBrowserHost(userDataDir, {
      platform: "linux",
      getChromiumExecutablePath
    });

    await expect(host.resolveExecutablePath()).resolves.toBeUndefined();
    expect(getChromiumExecutablePath).not.toHaveBeenCalled();
  });

  it("copies a macOS app bundle and patches it as a hidden Rion Studio helper", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "rion-hidden-browser-test-"));
    const sourceExecutablePath = await createFakeBrowserApp(baseDir);
    const appIconPath = join(baseDir, "rion-studio.icns");
    await writeFile(appIconPath, "rion studio icon\n", "utf8");
    const userDataDir = join(baseDir, "user-data");
    const signApp = vi.fn().mockResolvedValue(undefined);
    const registerApp = vi.fn().mockResolvedValue(undefined);
    const host = new MacHiddenBrowserHost(userDataDir, {
      platform: "darwin",
      getChromiumExecutablePath: vi.fn().mockResolvedValue(sourceExecutablePath),
      appIconPath,
      signApp,
      registerApp
    });

    const executablePath = await host.resolveExecutablePath();

    expect(executablePath).toBe(
      join(userDataDir, "browser-host", "Rion Studio Browser.app", "Contents", "MacOS", "Rion Studio Browser")
    );
    expect(signApp).toHaveBeenCalledWith(
      join(userDataDir, "browser-host", "Rion Studio Browser.app"),
      "com.rionstudio.launcher.browser"
    );
    expect(registerApp).toHaveBeenCalledWith(join(userDataDir, "browser-host", "Rion Studio Browser.app"));

    const plistPath = join(userDataDir, "browser-host", "Rion Studio Browser.app", "Contents", "Info.plist");
    const plist = await readFile(plistPath, "utf8");
    expect(rootValueFor(plist, "LSUIElement")).toBeUndefined();
    expect(nestedValueFor(plist, "ASWebAuthenticationSessionWebBrowserSupportCapabilities", "LSUIElement")).toBe(
      "<false/>"
    );
    expect(plist).toContain("<key>CFBundleName</key>");
    expect(plist).toContain("<string>Rion Studio Browser</string>");
    expect(plist).toContain("<key>CFBundleExecutable</key>");
    expect(plist).toContain("<string>Rion Studio Browser</string>");
    expect(plist).toContain("<key>CFBundleIdentifier</key>");
    expect(plist).toContain("<string>com.rionstudio.launcher.browser</string>");
    expect(plist).toContain("<key>CFBundleIconFile</key>");
    expect(plist).toContain("<string>app.icns</string>");
    expect(rootValueFor(plist, "CFBundleIconName")).toBeUndefined();
    expect(rootValueFor(plist, "LSHasLocalizedDisplayName")).toBeUndefined();
    await expect(
      readFile(
        join(userDataDir, "browser-host", "Rion Studio Browser.app", "Contents", "MacOS", "Rion Studio Browser"),
        "utf8"
      )
    ).resolves.toBe("#!/bin/sh\nexit 0\n");
    await expect(
      readFile(
        join(
          userDataDir,
          "browser-host",
          "Rion Studio Browser.app",
          "Contents",
          "MacOS",
          "Google Chrome for Testing"
        ),
        "utf8"
      )
    ).rejects.toThrow();
    await expect(
      readFile(
        join(
          userDataDir,
          "browser-host",
          "Rion Studio Browser.app",
          "Contents",
          "Resources",
          "en.lproj",
          "InfoPlist.strings"
        ),
        "utf8"
      )
    ).resolves.toContain('CFBundleDisplayName = "Rion Studio Browser";');
    await expect(
      readFile(
        join(
          userDataDir,
          "browser-host",
          "Rion Studio Browser.app",
          "Contents",
          "Resources",
          "en.lproj",
          "InfoPlist.strings"
        ),
        "utf8"
      )
    ).resolves.toContain('CFBundleGetInfoString = "Rion Studio Browser";');
    await expect(
      readFile(
        join(userDataDir, "browser-host", "Rion Studio Browser.app", "Contents", "Resources", "app.icns"),
        "utf8"
      )
    ).resolves.toBe("rion studio icon\n");

    const metadata = JSON.parse(await readFile(join(userDataDir, "browser-host", "source.json"), "utf8")) as {
      patchVersion?: number;
      targetExecutableName?: string;
    };
    expect(metadata.patchVersion).toBe(7);
    expect(metadata.targetExecutableName).toBe("Rion Studio Browser");
  });

  it("preserves relative symlinks when copying the browser app bundle", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "rion-hidden-browser-test-"));
    const sourceExecutablePath = await createFakeBrowserApp(baseDir);
    const frameworkPath = join(
      getMacAppBundlePathFromExecutable(sourceExecutablePath) ?? "",
      "Contents",
      "Frameworks",
      "Fake.framework"
    );
    await mkdir(join(frameworkPath, "Versions", "A", "Resources"), { recursive: true });
    await symlink("A", join(frameworkPath, "Versions", "Current"));
    await symlink("Versions/Current/Resources", join(frameworkPath, "Resources"));
    const userDataDir = join(baseDir, "user-data");
    const host = new MacHiddenBrowserHost(userDataDir, {
      platform: "darwin",
      getChromiumExecutablePath: vi.fn().mockResolvedValue(sourceExecutablePath),
      signApp: vi.fn().mockResolvedValue(undefined),
      registerApp: vi.fn().mockResolvedValue(undefined)
    });

    await expect(host.resolveExecutablePath()).resolves.toBe(
      join(userDataDir, "browser-host", "Rion Studio Browser.app", "Contents", "MacOS", "Rion Studio Browser")
    );

    const copiedLink = await readlink(
      join(
        userDataDir,
        "browser-host",
        "Rion Studio Browser.app",
        "Contents",
        "Frameworks",
        "Fake.framework",
        "Resources"
      )
    );
    expect(copiedLink.replaceAll("\\", "/")).toBe("Versions/Current/Resources");
  });

  it("recopies helpers that were prepared before the current patch version", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "rion-hidden-browser-test-"));
    const sourceExecutablePath = await createFakeBrowserApp(baseDir);
    const userDataDir = join(baseDir, "user-data");
    const targetAppPath = join(userDataDir, "browser-host", "Rion Studio Browser.app");
    const targetExecutablePath = join(targetAppPath, "Contents", "MacOS", "Rion Studio Browser");
    await createFakeBrowserApp(join(userDataDir, "browser-host"), "Rion Studio Browser.app");
    await writeFile(
      join(userDataDir, "browser-host", "source.json"),
      `${JSON.stringify({
        sourceAppPath: getMacAppBundlePathFromExecutable(sourceExecutablePath),
        sourceExecutableName: "Google Chrome for Testing"
      })}\n`,
      "utf8"
    );
    await writeFile(targetExecutablePath, "stale helper\n", "utf8");

    const host = new MacHiddenBrowserHost(userDataDir, {
      platform: "darwin",
      getChromiumExecutablePath: vi.fn().mockResolvedValue(sourceExecutablePath),
      signApp: vi.fn().mockResolvedValue(undefined),
      registerApp: vi.fn().mockResolvedValue(undefined)
    });

    await expect(host.resolveExecutablePath()).resolves.toBe(targetExecutablePath);
    await expect(readFile(targetExecutablePath, "utf8")).resolves.toBe("#!/bin/sh\nexit 0\n");
  });

  it("revalidates cached helpers before reusing them", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "rion-hidden-browser-test-"));
    const sourceExecutablePath = await createFakeBrowserApp(baseDir);
    const userDataDir = join(baseDir, "user-data");
    const targetExecutablePath = join(
      userDataDir,
      "browser-host",
      "Rion Studio Browser.app",
      "Contents",
      "MacOS",
      "Rion Studio Browser"
    );
    const copyApp = vi.fn(async (sourceAppPath: string, targetAppPath: string) => {
      expect(sourceAppPath).toBe(getMacAppBundlePathFromExecutable(sourceExecutablePath));
      expect(targetAppPath).toBe(join(userDataDir, "browser-host", "Rion Studio Browser.app"));
      await rm(targetAppPath, { force: true, recursive: true });
      await createFakeBrowserApp(join(userDataDir, "browser-host"), "Rion Studio Browser.app");
    });
    const host = new MacHiddenBrowserHost(userDataDir, {
      platform: "darwin",
      getChromiumExecutablePath: vi.fn().mockResolvedValue(sourceExecutablePath),
      copyApp,
      signApp: vi.fn().mockResolvedValue(undefined),
      registerApp: vi.fn().mockResolvedValue(undefined)
    });

    await expect(host.resolveExecutablePath()).resolves.toBe(targetExecutablePath);
    await writeFile(
      join(userDataDir, "browser-host", "source.json"),
      `${JSON.stringify({
        sourceAppPath: getMacAppBundlePathFromExecutable(sourceExecutablePath),
        sourceExecutableName: "Google Chrome for Testing",
        targetExecutableName: "Rion Studio Browser",
        patchVersion: 6
      })}\n`,
      "utf8"
    );
    await writeFile(targetExecutablePath, "stale cached helper\n", "utf8");

    await expect(host.resolveExecutablePath()).resolves.toBe(targetExecutablePath);
    await expect(readFile(targetExecutablePath, "utf8")).resolves.toBe("#!/bin/sh\nexit 0\n");
    expect(copyApp).toHaveBeenCalledTimes(2);
  });

  it("continues when LaunchServices registration fails", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "rion-hidden-browser-test-"));
    const sourceExecutablePath = await createFakeBrowserApp(baseDir);
    const userDataDir = join(baseDir, "user-data");
    const logger = {
      warn: vi.fn()
    };
    const host = new MacHiddenBrowserHost(userDataDir, {
      platform: "darwin",
      getChromiumExecutablePath: vi.fn().mockResolvedValue(sourceExecutablePath),
      signApp: vi.fn().mockResolvedValue(undefined),
      registerApp: vi.fn().mockRejectedValue(new Error("lsregister failed")),
      logger
    });

    await expect(host.resolveExecutablePath()).resolves.toBe(
      join(userDataDir, "browser-host", "Rion Studio Browser.app", "Contents", "MacOS", "Rion Studio Browser")
    );
    await expect(readFile(join(userDataDir, "browser-host", "source.json"), "utf8")).resolves.toContain(
      "\"patchVersion\": 7"
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "Unable to register Rion Studio browser helper with LaunchServices.",
      expect.any(Error)
    );
  });

  it("fails helper preparation when signing fails", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "rion-hidden-browser-test-"));
    const sourceExecutablePath = await createFakeBrowserApp(baseDir);
    const logger = {
      warn: vi.fn()
    };
    const host = new MacHiddenBrowserHost(join(baseDir, "user-data"), {
      platform: "darwin",
      getChromiumExecutablePath: vi.fn().mockResolvedValue(sourceExecutablePath),
      signApp: vi.fn().mockRejectedValue(new Error("codesign failed")),
      registerApp: vi.fn().mockResolvedValue(undefined),
      logger
    });

    await expect(host.resolveExecutablePath()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      "Unable to prepare hidden Rion Studio browser helper.",
      expect.any(Error)
    );
  });

  it("falls back when helper preparation fails", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "rion-hidden-browser-test-"));
    const sourceExecutablePath = await createFakeBrowserApp(baseDir);
    const logger = {
      warn: vi.fn()
    };
    const host = new MacHiddenBrowserHost(join(baseDir, "user-data"), {
      platform: "darwin",
      getChromiumExecutablePath: vi.fn().mockResolvedValue(sourceExecutablePath),
      copyApp: vi.fn().mockRejectedValue(new Error("copy failed")),
      logger
    });

    await expect(host.resolveExecutablePath()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      "Unable to prepare hidden Rion Studio browser helper.",
      expect.any(Error)
    );
  });

  it("finds the containing macOS app bundle from a Chromium executable", () => {
    expect(
      getMacAppBundlePathFromExecutable(
        "/Users/aron/Library/Caches/ms-playwright/chromium/chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
      )
    ).toBe(
      "/Users/aron/Library/Caches/ms-playwright/chromium/chrome-mac/Google Chrome for Testing.app"
    );
    expect(
      getMacAppBundlePathFromExecutable(
        String.raw`C:\Users\runneradmin\AppData\Local\ms-playwright\chromium\chrome-win\Google Chrome for Testing.app\Contents\MacOS\Google Chrome for Testing`
      )
    ).toBe(
      String.raw`C:\Users\runneradmin\AppData\Local\ms-playwright\chromium\chrome-win\Google Chrome for Testing.app`
    );
    expect(getMacAppBundlePathFromExecutable("/usr/bin/chromium")).toBeUndefined();
  });
});

async function createFakeBrowserApp(baseDir: string, appName = "Google Chrome for Testing.app"): Promise<string> {
  const appPath = join(baseDir, appName);
  const contentsPath = join(appPath, "Contents");
  const macOsPath = join(contentsPath, "MacOS");
  const resourcesPath = join(contentsPath, "Resources");
  const localizedResourcesPath = join(resourcesPath, "en.lproj");
  const executablePath = join(macOsPath, "Google Chrome for Testing");

  await mkdir(macOsPath, { recursive: true });
  await mkdir(resourcesPath, { recursive: true });
  await mkdir(localizedResourcesPath, { recursive: true });
  await writeFile(
    join(contentsPath, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>ASWebAuthenticationSessionWebBrowserSupportCapabilities</key>
  <dict>
    <key>IsSupported</key>
    <true/>
    <key>LSUIElement</key>
    <false/>
  </dict>
  <key>CFBundleExecutable</key>
  <string>Google Chrome for Testing</string>
  <key>CFBundleDisplayName</key>
  <string>Google Chrome for Testing</string>
  <key>CFBundleIconFile</key>
  <string>app.icns</string>
  <key>CFBundleIconName</key>
  <string>AppIcon</string>
  <key>CFBundleIdentifier</key>
  <string>com.google.chrome.for.testing</string>
  <key>CFBundleName</key>
  <string>Google Chrome for Testing</string>
  <key>LSHasLocalizedDisplayName</key>
  <string>1</string>
</dict>
</plist>
`,
    "utf8"
  );
  await writeFile(executablePath, "#!/bin/sh\nexit 0\n", "utf8");
  await writeFile(join(resourcesPath, "app.icns"), "chrome test icon\n", "utf8");
  await writeFile(
    join(localizedResourcesPath, "InfoPlist.strings"),
    [
      'CFBundleDisplayName = "Google Chrome for Testing";',
      'CFBundleGetInfoString = "Google Chrome for Testing 149.0.7827.55";',
      'CFBundleName = "Google Chrome for Testing";',
      'NSCameraUsageDescription = "Once Chromium has access, websites will be able to ask you for access.";'
    ].join("\n"),
    "utf8"
  );
  await chmod(executablePath, 0o755);

  return executablePath;
}

function rootValueFor(plist: string, key: string): string | undefined {
  const rootBody = rootDictBody(plist).replace(
    /<key>ASWebAuthenticationSessionWebBrowserSupportCapabilities<\/key>\s*<dict>[\s\S]*?<\/dict>/,
    ""
  );
  const matches = [
    ...rootBody.matchAll(new RegExp(`<key>${key}</key>\\s*(<[^>]+/?>|<string>[\\s\\S]*?</string>)`, "g"))
  ];
  return matches.at(-1)?.[1];
}

function nestedValueFor(plist: string, dictionaryKey: string, key: string): string | undefined {
  const nestedMatch = new RegExp(`<key>${dictionaryKey}</key>\\s*<dict>([\\s\\S]*?)</dict>`).exec(plist);

  if (!nestedMatch) {
    return undefined;
  }

  const valueMatch = new RegExp(`<key>${key}</key>\\s*(<[^>]+/?>|<string>[\\s\\S]*?</string>)`).exec(nestedMatch[1]);
  return valueMatch?.[1];
}

function rootDictBody(plist: string): string {
  const startMatch = /<plist[^>]*>\s*<dict>/u.exec(plist);

  if (!startMatch) {
    throw new Error("Missing root dictionary.");
  }

  return plist.slice(startMatch.index + startMatch[0].length, plist.lastIndexOf("</dict>"));
}
