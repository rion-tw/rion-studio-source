import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { installElectronDesktopE2eRoleSurfaceLifecycleObserver } from
  "../src/electron/e2e/roleSurfaceLifecycleObserver";

describe.each(["macos", "windows"] as const)("%s Role close observation", (platform) => {
  it.each([false, true])("records local chrome navigation without replacing its promise (failure=%s)", async fails => {
    const directory = mkdtempSync(join(tmpdir(), "rion-chrome-load-observer-"));
    try {
      const app = new EventEmitter();
      const failure = new Error("local navigation aborted");
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const navigation = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
      const contents = Object.assign(new EventEmitter(), {
        id: 18,
        session: { storagePath: null },
        isDestroyed: () => false,
        isLoading: () => true,
        isLoadingMainFrame: () => true,
        getURL: () => "about:blank",
        getType: () => "window",
        close: vi.fn(),
        loadURL: vi.fn(function (this: unknown, _url: string) {
          expect(this).toBe(contents);
          return navigation;
        })
      });
      const nativeClose = contents.close;
      installElectronDesktopE2eRoleSurfaceLifecycleObserver(
        app as unknown as Parameters<typeof installElectronDesktopE2eRoleSurfaceLifecycleObserver>[0], directory
      );
      app.emit("web-contents-created", {}, contents);
      expect(contents.loadURL("https://unrelated.test/")).toBe(navigation);
      expect(existsSync(join(directory, "electron-local-web-chrome-lifecycle-observations.json"))).toBe(false);
      const url = platform === "windows"
        ? "file:///C:/Rion/runtime-web-chrome-electron.html"
        : "file:///Rion/runtime-web-chrome-electron.html";
      expect(contents.loadURL(url)).toBe(navigation);
      contents.emit("did-start-navigation", {}, url, false, true);
      if (fails) reject(failure);
      else resolve();
      if (fails) await expect(navigation).rejects.toBe(failure);
      else await navigation;
      contents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
      const rows = JSON.parse(readFileSync(join(
        directory, "electron-local-web-chrome-lifecycle-observations.json"
      ), "utf8")) as Array<{ stage: string; roleId?: string; details?: unknown }>;
      expect(rows.map(row => row.stage)).toEqual([
        "local-chrome-identified", "load-url-entered", "did-start-navigation",
        fails ? "load-url-rejected" : "load-url-resolved", "render-process-gone"
      ]);
      expect(rows.every(row => row.roleId === undefined)).toBe(true);
      expect(rows.at(-1)?.details).toEqual({ reason: "crashed", exitCode: 1 });
      expect(nativeClose).not.toHaveBeenCalled();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([false, true])("preserves native close behavior (failure=%s)", (fails) => {
    const directory = mkdtempSync(join(tmpdir(), "rion-role-close-observer-"));
    try {
      const app = new EventEmitter();
      let destroyed = false;
      const failure = new Error("native close rejected");
      const contents = Object.assign(new EventEmitter(), {
        id: 17,
        session: { storagePath: platform === "windows"
          ? "C:\\data\\roles\\role-one\\browser\\chromium"
          : "/data/roles/role-one/browser/chromium" },
        isDestroyed: () => destroyed,
        isLoading: () => false,
        isLoadingMainFrame: () => false,
        getURL: () => "https://example.test/",
        getType: () => "window",
        close: vi.fn(function (this: unknown, _options: unknown) {
          expect(this).toBe(contents);
          if (fails) throw failure;
        })
      });
      const nativeClose = contents.close;
      installElectronDesktopE2eRoleSurfaceLifecycleObserver(
        app as unknown as Parameters<
          typeof installElectronDesktopE2eRoleSurfaceLifecycleObserver
        >[0], directory
      );
      app.emit("web-contents-created", {}, contents);
      const options = { waitForBeforeUnload: false };
      if (fails) expect(() => contents.close(options)).toThrow(failure);
      else expect(contents.close(options)).toBeUndefined();
      expect(nativeClose).toHaveBeenCalledExactlyOnceWith(options);
      const read = () => JSON.parse(readFileSync(
        join(directory, "electron-role-surface-lifecycle-observations.json"), "utf8"
      )) as Array<{ stage: string; destroyed: boolean }>;
      expect(read().map((entry) => entry.stage)).toEqual([
        "created", "close-entered", fails ? "close-threw" : "close-returned"
      ]);
      // Returning from close does not claim destruction; only its exact event does.
      expect(read().every((entry) => !entry.destroyed)).toBe(true);
      destroyed = true;
      contents.emit("destroyed");
      expect(read().at(-1)).toMatchObject({ stage: "destroyed", destroyed: true });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
