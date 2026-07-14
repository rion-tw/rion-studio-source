import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import { app, screen } from "electron";

import type { PixelBounds } from "../../shared/types";

const execFileAsync = promisify(execFile);

const HELPER_PROTOCOL = 1;
const HELPER_FILENAME = "rion-window-frame-helper.exe";
const HELPER_TIMEOUT_MS = 3_000;
const HELPER_MAX_BUFFER = 64 * 1024;
const MAX_UINT32 = 0xffff_ffff;
const MIN_INT32 = -0x8000_0000;
const MAX_INT32 = 0x7fff_ffff;

export interface AlignExternalChromeVisibleBoundsInput {
  browserProcessId: number;
  physicalBounds: PixelBounds;
}

export interface ExternalChromeWindowBoundsAdapter {
  dipToPhysicalBounds: (bounds: PixelBounds) => PixelBounds;
  alignVisibleBounds: (input: AlignExternalChromeVisibleBoundsInput) => Promise<void>;
}

export type ExternalChromeWindowBoundsExecFile = (
  file: string,
  args: string[],
  options: {
    encoding: "utf8";
    maxBuffer: number;
    timeout: number;
    windowsHide: true;
  }
) => Promise<{ stdout: string }>;

export interface CreateExternalChromeWindowBoundsAdapterOptions {
  appPath?: string;
  dipToScreenRect?: (window: null, bounds: PixelBounds) => PixelBounds;
  execFile?: ExternalChromeWindowBoundsExecFile;
  helperPath?: string;
  isPackaged?: boolean;
  platform?: NodeJS.Platform;
  resourcesPath?: string;
}

interface WindowFrameHelperResult {
  after: WindowFrameSnapshot;
  attempts: number;
  before: WindowFrameSnapshot;
  dpi: number;
  hwnd: string;
  ok: true;
  pid: number;
  protocol: number;
  target: PixelBounds;
}

interface WindowFrameSnapshot {
  outer: PixelBounds;
  visible: PixelBounds;
}

export function createExternalChromeWindowBoundsAdapter(
  options: CreateExternalChromeWindowBoundsAdapterOptions = {}
): ExternalChromeWindowBoundsAdapter | undefined {
  if ((options.platform ?? process.platform) !== "win32") {
    return undefined;
  }

  const isPackaged = options.isPackaged ?? app.isPackaged;
  const helperPath =
    options.helperPath ??
    (isPackaged
      ? join(options.resourcesPath ?? process.resourcesPath, "native", HELPER_FILENAME)
      : join(options.appPath ?? app.getAppPath(), "build", "native", "win32-x64", HELPER_FILENAME));

  return new WindowsExternalChromeWindowBoundsAdapter({
    dipToScreenRect: options.dipToScreenRect ?? ((window, bounds) => screen.dipToScreenRect(window, bounds)),
    execFile: options.execFile ?? (execFileAsync as ExternalChromeWindowBoundsExecFile),
    helperPath
  });
}

interface WindowsExternalChromeWindowBoundsAdapterOptions {
  dipToScreenRect: (window: null, bounds: PixelBounds) => PixelBounds;
  execFile: ExternalChromeWindowBoundsExecFile;
  helperPath: string;
}

class WindowsExternalChromeWindowBoundsAdapter implements ExternalChromeWindowBoundsAdapter {
  constructor(private readonly options: WindowsExternalChromeWindowBoundsAdapterOptions) {}

  dipToPhysicalBounds(bounds: PixelBounds): PixelBounds {
    const physicalBounds = this.options.dipToScreenRect(null, bounds);
    return {
      x: physicalBounds.x,
      y: physicalBounds.y,
      width: physicalBounds.width,
      height: physicalBounds.height
    };
  }

  async alignVisibleBounds({
    browserProcessId,
    physicalBounds
  }: AlignExternalChromeVisibleBoundsInput): Promise<void> {
    assertBrowserProcessId(browserProcessId);
    assertPixelBounds(physicalBounds, "physicalBounds", true);

    const { stdout } = await this.options.execFile(
      this.options.helperPath,
      [
        "align-visible-frame",
        "--protocol",
        String(HELPER_PROTOCOL),
        "--pid",
        String(browserProcessId),
        "--x",
        String(physicalBounds.x),
        "--y",
        String(physicalBounds.y),
        "--width",
        String(physicalBounds.width),
        "--height",
        String(physicalBounds.height)
      ],
      {
        encoding: "utf8",
        maxBuffer: HELPER_MAX_BUFFER,
        timeout: HELPER_TIMEOUT_MS,
        windowsHide: true
      }
    );

    const result = parseHelperResult(stdout);
    if (result.pid !== browserProcessId) {
      throw new Error("Windows frame helper returned a browser process id that does not match the request.");
    }

    if (!boundsEqual(result.target, physicalBounds)) {
      throw new Error("Windows frame helper returned a target that does not match the requested bounds.");
    }

    if (!boundsEqual(result.after.visible, physicalBounds)) {
      throw new Error("Windows frame helper did not align the visible frame to the requested bounds.");
    }
  }
}

function parseHelperResult(stdout: string): WindowFrameHelperResult {
  const serialized = stdout.trim();
  if (!serialized || /[\r\n]/.test(serialized)) {
    throw new Error("Windows frame helper returned invalid output.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    throw new Error("Windows frame helper returned invalid JSON.");
  }

  if (!isRecord(parsed) || parsed.protocol !== HELPER_PROTOCOL) {
    throw new Error("Windows frame helper returned an unsupported protocol response.");
  }

  if (parsed.ok !== true) {
    throw new Error("Windows frame helper did not return a successful response.");
  }

  const pid = parsed.pid;
  if (!Number.isInteger(pid) || (pid as number) <= 0 || (pid as number) > MAX_UINT32) {
    throw new Error("Windows frame helper returned an invalid browser process id.");
  }

  const hwnd = parsed.hwnd;
  if (typeof hwnd !== "string" || hwnd.trim().length === 0) {
    throw new Error("Windows frame helper returned an invalid window handle.");
  }

  const dpi = parsed.dpi;
  if (!Number.isInteger(dpi) || (dpi as number) <= 0 || (dpi as number) > MAX_UINT32) {
    throw new Error("Windows frame helper returned an invalid window DPI.");
  }

  const target = parsePixelBounds(parsed.target, "target", true);
  const before = parseWindowFrameSnapshot(parsed.before, "before");
  const after = parseWindowFrameSnapshot(parsed.after, "after");
  const attempts = parsed.attempts;
  if (!Number.isInteger(attempts) || (attempts as number) < 0 || (attempts as number) > 3) {
    throw new Error("Windows frame helper returned an invalid attempts count.");
  }

  return {
    protocol: HELPER_PROTOCOL,
    ok: true,
    pid: pid as number,
    hwnd,
    dpi: dpi as number,
    target,
    before,
    after,
    attempts: attempts as number
  };
}

function parseWindowFrameSnapshot(value: unknown, field: string): WindowFrameSnapshot {
  if (!isRecord(value)) {
    throw new Error(`Windows frame helper returned an invalid ${field} frame.`);
  }

  return {
    outer: parsePixelBounds(value.outer, `${field}.outer`, true),
    visible: parsePixelBounds(value.visible, `${field}.visible`, true)
  };
}

function parsePixelBounds(value: unknown, field: string, requirePositiveSize: boolean): PixelBounds {
  if (!isRecord(value)) {
    throw new Error(`Windows frame helper returned invalid ${field} bounds.`);
  }

  const bounds = {
    x: value.x,
    y: value.y,
    width: value.width,
    height: value.height
  };
  assertPixelBounds(bounds, field, requirePositiveSize);
  return bounds;
}

function assertBrowserProcessId(browserProcessId: number): void {
  if (!Number.isInteger(browserProcessId) || browserProcessId <= 0 || browserProcessId > MAX_UINT32) {
    throw new Error("External Chrome browser process id must be a positive uint32.");
  }
}

function assertPixelBounds(
  bounds: { height: unknown; width: unknown; x: unknown; y: unknown },
  field: string,
  requirePositiveSize: boolean
): asserts bounds is PixelBounds {
  if (
    !isInt32(bounds.x) ||
    !isInt32(bounds.y) ||
    !isInt32(bounds.width) ||
    !isInt32(bounds.height) ||
    (requirePositiveSize && (bounds.width <= 0 || bounds.height <= 0))
  ) {
    throw new Error(`Windows frame helper received or returned invalid ${field} bounds.`);
  }
}

function isInt32(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= MIN_INT32 && (value as number) <= MAX_INT32;
}

function boundsEqual(left: PixelBounds, right: PixelBounds): boolean {
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
