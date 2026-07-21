import { screen } from "electron";

import type { PixelBounds } from "../../shared/types";

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

export interface CreateExternalChromeWindowBoundsAdapterOptions {
  dipToScreenRect?: (window: null, bounds: PixelBounds) => PixelBounds;
  nativeAlignVisibleBounds?: (
    input: AlignExternalChromeVisibleBoundsInput
  ) => Promise<PixelBounds>;
  platform?: NodeJS.Platform;
}

/**
 * Electron owns DIP conversion while the Rust windows-rs adapter owns native
 * window discovery and visible-frame alignment. There is intentionally no
 * executable fallback: a missing addon is a startup error, not a second
 * platform implementation.
 */
export function createExternalChromeWindowBoundsAdapter(
  options: CreateExternalChromeWindowBoundsAdapterOptions = {}
): ExternalChromeWindowBoundsAdapter | undefined {
  if ((options.platform ?? process.platform) !== "win32") {
    return undefined;
  }
  if (!options.nativeAlignVisibleBounds) {
    throw new Error("The Rust Windows frame adapter is unavailable.");
  }

  return new WindowsExternalChromeWindowBoundsAdapter({
    dipToScreenRect:
      options.dipToScreenRect ?? ((window, bounds) => screen.dipToScreenRect(window, bounds)),
    nativeAlignVisibleBounds: options.nativeAlignVisibleBounds
  });
}

interface WindowsExternalChromeWindowBoundsAdapterOptions {
  dipToScreenRect: (window: null, bounds: PixelBounds) => PixelBounds;
  nativeAlignVisibleBounds: (
    input: AlignExternalChromeVisibleBoundsInput
  ) => Promise<PixelBounds>;
}

class WindowsExternalChromeWindowBoundsAdapter implements ExternalChromeWindowBoundsAdapter {
  constructor(private readonly options: WindowsExternalChromeWindowBoundsAdapterOptions) {}

  dipToPhysicalBounds(bounds: PixelBounds): PixelBounds {
    const physicalBounds = this.options.dipToScreenRect(null, bounds);
    assertPixelBounds(physicalBounds, "physicalBounds");
    return { ...physicalBounds };
  }

  async alignVisibleBounds({
    browserProcessId,
    physicalBounds
  }: AlignExternalChromeVisibleBoundsInput): Promise<void> {
    assertBrowserProcessId(browserProcessId);
    assertPixelBounds(physicalBounds, "physicalBounds");

    const actualBounds = await this.options.nativeAlignVisibleBounds({
      browserProcessId,
      physicalBounds
    });
    assertPixelBounds(actualBounds, "alignedBounds");
    if (!boundsEqual(actualBounds, physicalBounds)) {
      throw new Error("Rust window adapter did not align the visible frame to the requested bounds.");
    }
  }
}

function assertBrowserProcessId(browserProcessId: number): void {
  if (!Number.isInteger(browserProcessId) || browserProcessId <= 0 || browserProcessId > MAX_UINT32) {
    throw new Error("External Chrome browser process id must be a positive uint32.");
  }
}

function assertPixelBounds(
  bounds: { height: unknown; width: unknown; x: unknown; y: unknown },
  field: string
): asserts bounds is PixelBounds {
  if (
    !isInt32(bounds.x) ||
    !isInt32(bounds.y) ||
    !isInt32(bounds.width) ||
    !isInt32(bounds.height) ||
    bounds.width <= 0 ||
    bounds.height <= 0
  ) {
    throw new Error(`Rust Windows frame adapter received invalid ${field} bounds.`);
  }
}

function isInt32(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= MIN_INT32 && (value as number) <= MAX_INT32;
}

function boundsEqual(left: PixelBounds, right: PixelBounds): boolean {
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}
