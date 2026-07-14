import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createExternalChromeWindowBoundsAdapter,
  type ExternalChromeWindowBoundsExecFile
} from "../src/main/browser/WindowsExternalChromeWindowBoundsAdapter";
import type { PixelBounds } from "../src/shared/types";

const electronMocks = vi.hoisted(() => ({
  dipToScreenRect: vi.fn(),
  getAppPath: vi.fn(() => "/default-app")
}));

vi.mock("electron", () => ({
  app: {
    get isPackaged() {
      return false;
    },
    getAppPath: electronMocks.getAppPath
  },
  screen: {
    dipToScreenRect: electronMocks.dipToScreenRect
  }
}));

const targetBounds: PixelBounds = { x: -1920, y: 0, width: 1920, height: 1040 };

describe("WindowsExternalChromeWindowBoundsAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not create a native adapter on non-Windows platforms", () => {
    expect(createExternalChromeWindowBoundsAdapter({ platform: "darwin" })).toBeUndefined();
    expect(electronMocks.getAppPath).not.toHaveBeenCalled();
  });

  it("converts the complete DIP rectangle through Electron screen coordinates", () => {
    const dipBounds = { x: -1536, y: 12, width: 1536, height: 832 };
    const physicalBounds = { x: -1920, y: 15, width: 1920, height: 1040 };
    const dipToScreenRect = vi.fn(() => physicalBounds);
    const adapter = createExternalChromeWindowBoundsAdapter({
      platform: "win32",
      appPath: "/app",
      dipToScreenRect,
      execFile: createExecFileMock(createHelperOutput(targetBounds))
    });

    expect(adapter?.dipToPhysicalBounds(dipBounds)).toEqual(physicalBounds);
    expect(dipToScreenRect).toHaveBeenCalledWith(null, dipBounds);
  });

  it("invokes the development helper with protocol 1 and hardened process options", async () => {
    const execFile = createExecFileMock(createHelperOutput(targetBounds, { pid: 4321 }));
    const adapter = createExternalChromeWindowBoundsAdapter({
      platform: "win32",
      isPackaged: false,
      appPath: "/app",
      dipToScreenRect: (_window, bounds) => bounds,
      execFile
    });

    await expect(
      adapter?.alignVisibleBounds({ browserProcessId: 4321, physicalBounds: targetBounds })
    ).resolves.toBeUndefined();
    expect(execFile).toHaveBeenCalledWith(
      join("/app", "build", "native", "win32-x64", "rion-window-frame-helper.exe"),
      [
        "align-visible-frame",
        "--protocol",
        "1",
        "--pid",
        "4321",
        "--x",
        "-1920",
        "--y",
        "0",
        "--width",
        "1920",
        "--height",
        "1040"
      ],
      {
        encoding: "utf8",
        maxBuffer: 64 * 1024,
        timeout: 3_000,
        windowsHide: true
      }
    );
  });

  it("resolves the packaged helper below resources/native", async () => {
    const execFile = createExecFileMock(createHelperOutput(targetBounds));
    const adapter = createExternalChromeWindowBoundsAdapter({
      platform: "win32",
      isPackaged: true,
      resourcesPath: "/resources",
      dipToScreenRect: (_window, bounds) => bounds,
      execFile
    });

    await adapter?.alignVisibleBounds({ browserProcessId: 12, physicalBounds: targetBounds });

    expect(execFile).toHaveBeenCalledWith(
      join("/resources", "native", "rion-window-frame-helper.exe"),
      expect.any(Array),
      expect.any(Object)
    );
  });

  it("supports an explicitly injected helper path", async () => {
    const execFile = createExecFileMock(createHelperOutput(targetBounds));
    const adapter = createExternalChromeWindowBoundsAdapter({
      platform: "win32",
      helperPath: "/custom/frame-helper.exe",
      dipToScreenRect: (_window, bounds) => bounds,
      execFile
    });

    await adapter?.alignVisibleBounds({ browserProcessId: 12, physicalBounds: targetBounds });

    expect(execFile).toHaveBeenCalledWith("/custom/frame-helper.exe", expect.any(Array), expect.any(Object));
  });

  it.each([
    ["malformed JSON", "not-json", "invalid JSON"],
    ["multiple output lines", `${createHelperOutput(targetBounds)}\nwarning`, "invalid output"],
    ["wrong protocol", createHelperOutput(targetBounds, { protocol: 2 }), "unsupported protocol"],
    ["unsuccessful response", createHelperOutput(targetBounds, { ok: false }), "successful response"],
    ["invalid process id", createHelperOutput(targetBounds, { pid: 0 }), "invalid browser process id"],
    ["missing window handle", createHelperOutput(targetBounds, { hwnd: "" }), "invalid window handle"],
    ["invalid DPI", createHelperOutput(targetBounds, { dpi: 0 }), "invalid window DPI"],
    [
      "missing frame data",
      JSON.stringify({
        protocol: 1,
        ok: true,
        pid: 12,
        hwnd: "0x1234",
        dpi: 120,
        target: targetBounds,
        attempts: 1
      }),
      "invalid before frame"
    ],
    ["invalid attempts", createHelperOutput(targetBounds, { attempts: 4 }), "invalid attempts"]
  ])("rejects %s", async (_case, stdout, expectedMessage) => {
    const adapter = createExternalChromeWindowBoundsAdapter({
      platform: "win32",
      helperPath: "/helper.exe",
      dipToScreenRect: (_window, bounds) => bounds,
      execFile: createExecFileMock(stdout)
    });

    await expect(
      adapter?.alignVisibleBounds({ browserProcessId: 12, physicalBounds: targetBounds })
    ).rejects.toThrow(expectedMessage);
  });

  it("rejects a response for a different target", async () => {
    const differentTarget = { ...targetBounds, width: targetBounds.width - 1 };
    const adapter = createExternalChromeWindowBoundsAdapter({
      platform: "win32",
      helperPath: "/helper.exe",
      dipToScreenRect: (_window, bounds) => bounds,
      execFile: createExecFileMock(createHelperOutput(targetBounds, { target: differentTarget }))
    });

    await expect(
      adapter?.alignVisibleBounds({ browserProcessId: 12, physicalBounds: targetBounds })
    ).rejects.toThrow("target that does not match");
  });

  it("rejects a response for a different Chrome process", async () => {
    const adapter = createExternalChromeWindowBoundsAdapter({
      platform: "win32",
      helperPath: "/helper.exe",
      dipToScreenRect: (_window, bounds) => bounds,
      execFile: createExecFileMock(createHelperOutput(targetBounds, { pid: 99 }))
    });

    await expect(
      adapter?.alignVisibleBounds({ browserProcessId: 12, physicalBounds: targetBounds })
    ).rejects.toThrow("process id that does not match");
  });

  it("rejects a response whose final visible frame still has a gap", async () => {
    const visible = { ...targetBounds, x: targetBounds.x + 8, width: targetBounds.width - 16 };
    const adapter = createExternalChromeWindowBoundsAdapter({
      platform: "win32",
      helperPath: "/helper.exe",
      dipToScreenRect: (_window, bounds) => bounds,
      execFile: createExecFileMock(createHelperOutput(targetBounds, { visible }))
    });

    await expect(
      adapter?.alignVisibleBounds({ browserProcessId: 12, physicalBounds: targetBounds })
    ).rejects.toThrow("did not align the visible frame");
  });

  it("rejects invalid process ids and bounds before invoking the helper", async () => {
    const execFile = createExecFileMock(createHelperOutput(targetBounds));
    const adapter = createExternalChromeWindowBoundsAdapter({
      platform: "win32",
      helperPath: "/helper.exe",
      dipToScreenRect: (_window, bounds) => bounds,
      execFile
    });

    await expect(
      adapter?.alignVisibleBounds({ browserProcessId: 0, physicalBounds: targetBounds })
    ).rejects.toThrow("positive uint32");
    await expect(
      adapter?.alignVisibleBounds({
        browserProcessId: 12,
        physicalBounds: { ...targetBounds, width: 0 }
      })
    ).rejects.toThrow("invalid physicalBounds bounds");
    expect(execFile).not.toHaveBeenCalled();
  });

  it.each(["helper timed out", "helper exited with code 4"])("propagates execFile failure: %s", async (message) => {
    const execFile = vi.fn(async () => {
      throw new Error(message);
    }) as ExternalChromeWindowBoundsExecFile;
    const adapter = createExternalChromeWindowBoundsAdapter({
      platform: "win32",
      helperPath: "/helper.exe",
      dipToScreenRect: (_window, bounds) => bounds,
      execFile
    });

    await expect(
      adapter?.alignVisibleBounds({ browserProcessId: 12, physicalBounds: targetBounds })
    ).rejects.toThrow(message);
  });
});

function createExecFileMock(stdout: string): ExternalChromeWindowBoundsExecFile {
  return vi.fn(async () => ({ stdout }));
}

function createHelperOutput(
  target: PixelBounds,
  overrides: {
    attempts?: number;
    dpi?: number;
    hwnd?: string;
    ok?: boolean;
    pid?: number;
    protocol?: number;
    target?: PixelBounds;
    visible?: PixelBounds;
  } = {}
): string {
  const outer = { x: target.x - 8, y: target.y - 8, width: target.width + 16, height: target.height + 16 };
  return JSON.stringify({
    protocol: overrides.protocol ?? 1,
    ok: overrides.ok ?? true,
    pid: overrides.pid ?? 12,
    hwnd: overrides.hwnd ?? "0x0000000000012345",
    dpi: overrides.dpi ?? 120,
    target: overrides.target ?? target,
    before: {
      outer,
      visible: { ...target, x: target.x + 8, width: target.width - 16 }
    },
    after: {
      outer,
      visible: overrides.visible ?? target
    },
    attempts: overrides.attempts ?? 1
  });
}
