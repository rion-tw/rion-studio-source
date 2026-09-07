interface Bounds { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
interface Point { readonly x: number; readonly y: number }
interface TabChrome {
  readonly hostKind: string;
  readonly tabIds: readonly string[];
  readonly native: { readonly appKit?: {
    readonly tabScreenBounds?: Bounds;
    readonly tabAnchors?: Readonly<Record<string, Point>>;
  } };
}
interface TabRuntime {
  readonly hostKind: string;
  readonly windowId: string;
  readonly nativeTabIds: readonly string[];
}
function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/** Pure geometry from matching retained AppKit observations; never performs UI actions. */
export function resolveMacosNativeTabPoint(input: Readonly<{
  tabId: string;
  tabName: string;
  windowId: string;
}>, inspection: TabChrome, runtime: TabRuntime | null): Readonly<Point> {
  const bounds = inspection.native.appKit?.tabScreenBounds;
  const tabIndex = inspection.tabIds.indexOf(input.tabId);
  const anchor = inspection.native.appKit?.tabAnchors?.[input.tabId];
  const firstTabId = inspection.tabIds[0];
  const firstAnchor = firstTabId === undefined
    ? undefined
    : inspection.native.appKit?.tabAnchors?.[firstTabId];
  const previousTabId = tabIndex > 0 ? inspection.tabIds[tabIndex - 1] : undefined;
  const previousAnchor = previousTabId === undefined
    ? undefined
    : inspection.native.appKit?.tabAnchors?.[previousTabId];
  if (
    inspection.hostKind !== "appkit" ||
    inspection.tabIds.filter((tabId) => tabId === input.tabId).length !== 1 ||
    !sameOrder(runtime?.nativeTabIds ?? [], inspection.tabIds) ||
    tabIndex < 0 || firstAnchor === undefined ||
    (tabIndex > 0 && previousAnchor === undefined) ||
    bounds === undefined || anchor === undefined || !runtime ||
    runtime.hostKind !== "appkit-chromium" ||
    runtime.windowId !== input.windowId ||
    runtime.nativeTabIds.filter((tabId) => tabId === input.tabId).length !== 1
  ) {
    throw new Error(
      `The exact AppKit desktop-E2E geometry for ${input.tabName} is unavailable`
    );
  }
  // AppKit exposes the first rendered tab's absolute screen bounds plus every
  // tab's window-relative right-centre anchor. Use their shared first-tab edge
  // to translate all anchors into screen coordinates. Core's nativeDisplay
  // bounds describe Chromium content and can begin below the retained titlebar.
  const anchorScreenOffsetX = bounds.x + bounds.width - firstAnchor.x;
  const tabLeft = previousAnchor === undefined
    ? bounds.x
    : anchorScreenOffsetX + previousAnchor.x;
  const tabRight = anchorScreenOffsetX + anchor.x;
  const clickX = tabLeft + (tabRight - tabLeft) / 2;
  const clickY = bounds.y + bounds.height / 2;
  if (
    bounds.width <= 0 || bounds.height <= 0 ||
    anchor.x < 0 || anchor.y < 0 || firstAnchor.x < 0 ||
    tabLeft < bounds.x || tabRight <= tabLeft ||
    clickY < bounds.y || clickY > bounds.y + bounds.height ||
    ![
      anchorScreenOffsetX, tabLeft, tabRight, clickX, clickY,
      anchor.x, anchor.y, firstAnchor.x, firstAnchor.y,
      bounds.x, bounds.y, bounds.width, bounds.height
    ].every(Number.isFinite)
  ) {
    throw new Error("The AppKit native tab geometry escaped its exact window");
  }
  return Object.freeze({ x: clickX, y: clickY });
}
