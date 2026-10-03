import { EventEmitter } from "node:events";
import { posix, win32 } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ChromiumRoleSurfaceRegistry, type CreateChromiumRoleSurfaceInput } from
  "../src/electron/main/chromiumRoleSurfaceRegistry";

function fixture(platform: "darwin" | "win32") {
  const events = new EventEmitter();
  let committed = false;
  let destroyed = false;
  let zoom = 1;
  let muted = false;
  let visible = false;
  let bounds = { x: 0, y: 0, width: 640, height: 480 };
  const session = {};
  const contents = {
    session, mainFrame: { frameToken: "zoom-document" },
    on: events.on.bind(events), removeListener: events.removeListener.bind(events),
    getURL: () => "https://game.test/launch", isDestroyed: () => destroyed,
    close: vi.fn(), loadURL: vi.fn(async () => undefined),
    setWindowOpenHandler: vi.fn(), setAudioMuted: (value: boolean) => { muted = value; },
    isAudioMuted: () => muted, getZoomFactor: () => zoom,
    setZoomFactor: vi.fn((value: number) => { if (committed) zoom = value; })
  };
  const view = { webContents: contents, setBackgroundColor: vi.fn(),
    getBounds: () => bounds, setBounds: (value: typeof bounds) => { bounds = value; },
    getVisible: () => visible, setVisible: (value: boolean) => { visible = value; } };
  const releaseRole = vi.fn(async () => true);
  const paths = platform === "darwin" ? posix : win32;
  const chromiumUserDataDir = paths.join(platform === "darwin" ? "/Rion" : "C:\\Rion", "role", "chromium");
  const registry = new ChromiumRoleSurfaceRegistry({
    ensure: () => ({ session, chromiumUserDataDir }), releaseRole, dispose: vi.fn()
  } as never, { create: () => view } as never);
  const input = { roleId: "role", tabId: "tab", generation: 1,
    rolePaths: { chromiumUserDataDir, browserUserDataDir: paths.dirname(chromiumUserDataDir),
      systemBrowserDataDir: paths.join(paths.dirname(chromiumUserDataDir), "system-webview"),
      webview2UserDataDir: paths.join(paths.dirname(chromiumUserDataDir), "system-webview", "webview2"),
      webkitDataStoreKey: "role:role:wkwebview", webkitDataStoreIdentifier: "role" },
    preloadPath: paths.join(paths.dirname(chromiumUserDataDir), "preload.js"),
    parent: { id: 1, isDestroyed: () => false,
      contentView: { addChildView: vi.fn(), removeChildView: vi.fn() } },
    bounds, visible: true, audioMuted: false, zoomFactor: 1.1,
    url: "https://game.test/launch" } as CreateChromiumRoleSurfaceInput;
  return { registry, input, contents, events, releaseRole,
    commit: () => { committed = true; events.emit("did-navigate", {}, input.url, 200, "OK"); },
    finish: () => events.emit("did-finish-load"),
    destroy: () => { destroyed = true; events.emit("destroyed"); } };
}

describe.each(["darwin", "win32"] as const)("%s Role initial document zoom", platform => {
  it("waits for the main-frame commit and keeps newer loading zoom through readiness", async () => {
    const subject = fixture(platform);
    const creation = subject.registry.create(subject.input);
    expect(subject.contents.setZoomFactor).not.toHaveBeenCalled();
    subject.commit();
    expect(subject.registry.readProjection("role", 1).zoomFactor).toBe(1.1);
    subject.registry.setZoomFactor("role", 1, 1.2);
    subject.finish();
    await expect(creation).resolves.toMatchObject({ roleId: "role", generation: 1 });
    expect(subject.registry.readProjection("role", 1).zoomFactor).toBe(1.2);
    const closing = subject.registry.closeRole("role", 1);
    subject.destroy();
    await closing;
  });

  it("rejects a real zoom mismatch and waits for exact destruction before releasing the session", async () => {
    const subject = fixture(platform);
    subject.contents.setZoomFactor.mockImplementation(() => undefined);
    const creation = subject.registry.create(subject.input);
    const rejected = expect(creation).rejects.toMatchObject({ code: "ELECTRON_ROLE_SURFACE_ZOOM_READBACK_FAILED" });
    subject.commit();
    await rejected;
    expect(subject.contents.close).toHaveBeenCalled();
    expect(subject.releaseRole).not.toHaveBeenCalled();
    subject.destroy();
    await subject.registry.closeRole("role", 1);
    expect(subject.releaseRole).toHaveBeenCalledOnce();
  });

  it("ignores late document events after cancellation", async () => {
    const subject = fixture(platform);
    const creation = subject.registry.create(subject.input);
    const rejected = expect(creation).rejects.toBeDefined();
    const closing = subject.registry.closeRole("role", 1);
    subject.commit(); subject.finish(); subject.destroy();
    await rejected;
    await closing;
    expect(subject.contents.setZoomFactor).not.toHaveBeenCalled();
  });
});
