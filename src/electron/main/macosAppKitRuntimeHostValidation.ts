import type {
  EmbeddedLaunchTargetRecord,
  EmbeddedTabEffectRecord
} from "../../shared/generated";
import { RionBridgeError } from "../ipc/errors";
import type { ChromiumRoleSurfaceBounds } from "./chromiumRoleSurfacePorts";
import type { ChromiumRuntimeEmptyHostIdentity } from
  "./chromiumRuntimeEffectExecutor";

export interface MacosAppKitRuntimeHostFences {
  readonly launchGeneration: string;
  readonly windowGeneration: number;
  readonly topologyRevision: number;
}

export interface RawAppKitRuntimeContentLayout {
  readonly heightInset: number;
  readonly yOffset: number;
  readonly valid: boolean;
}

interface AppKitRuntimeHostIdentityEvidence {
  readonly logicalWindowId: string;
  readonly launchGeneration: string;
  readonly nativeGeneration: number;
}

function fail(code: string, message: string): never {
  throw new RionBridgeError({ code, message });
}

export function requireMacosAppKitIdentifier(
  value: unknown,
  field: string
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value.trim() !== value ||
    value.includes("/") ||
    value.includes("\\") ||
    [...value].some((character) => character.codePointAt(0)! <= 0x1f)
  ) {
    fail(
      "ELECTRON_MACOS_APPKIT_ID_INVALID",
      "Core supplied an invalid " + field + " identity for the AppKit host."
    );
  }
  return value;
}

export function requireMacosAppKitBounds(
  bounds: ChromiumRoleSurfaceBounds,
  field: string,
  minimumWidth = 1,
  minimumHeight = 1
): void {
  if (
    !bounds ||
    ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isSafeInteger) ||
    bounds.width < minimumWidth ||
    bounds.height < minimumHeight ||
    !Number.isSafeInteger(bounds.x + bounds.width) ||
    !Number.isSafeInteger(bounds.y + bounds.height)
  ) {
    fail(
      "ELECTRON_MACOS_APPKIT_BOUNDS_INVALID",
      "The AppKit " + field + " bounds are invalid."
    );
  }
}

export function matchesMacosAppKitHostIdentity(
  value: unknown,
  expected: AppKitRuntimeHostIdentityEvidence
): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Reflect.get(value, "logicalWindowId") === expected.logicalWindowId &&
    Reflect.get(value, "launchGeneration") === expected.launchGeneration &&
    Reflect.get(value, "nativeGeneration") === expected.nativeGeneration;
}

export function requireMacosAppKitContentLayout(
  value: unknown
): RawAppKitRuntimeContentLayout {
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    Reflect.get(value, "valid") !== true ||
    typeof Reflect.get(value, "heightInset") !== "number" ||
    typeof Reflect.get(value, "yOffset") !== "number" ||
    !Number.isFinite(Reflect.get(value, "heightInset")) ||
    !Number.isFinite(Reflect.get(value, "yOffset")) ||
    Reflect.get(value, "heightInset") < 0 ||
    Reflect.get(value, "yOffset") < 0 ||
    Reflect.get(value, "yOffset") > Reflect.get(value, "heightInset")
  ) {
    fail(
      "ELECTRON_MACOS_APPKIT_LAYOUT_INVALID",
      "The AppKit adapter returned invalid content-layout evidence."
    );
  }
  return Object.freeze({
    heightInset: Reflect.get(value, "heightInset") as number,
    yOffset: Reflect.get(value, "yOffset") as number,
    valid: true
  });
}

function validateTarget(target: EmbeddedLaunchTargetRecord): void {
  requireMacosAppKitIdentifier(target.windowId, "logical window");
  requireMacosAppKitBounds(target.bounds, "window", 640, 480);
  requireMacosAppKitBounds(target.workArea, "display work-area");
  const workAreaRight = target.workArea.x + target.workArea.width;
  const workAreaBottom = target.workArea.y + target.workArea.height;
  if (
    target.bounds.x < target.workArea.x ||
    target.bounds.y < target.workArea.y ||
    target.bounds.x + target.bounds.width > workAreaRight ||
    target.bounds.y + target.bounds.height > workAreaBottom
  ) {
    fail(
      "ELECTRON_MACOS_APPKIT_BOUNDS_INVALID",
      "The AppKit window bounds must remain inside the Rust-resolved work area."
    );
  }
  if (
    target.persistedName !== undefined &&
    (
      target.persistedName.length === 0 ||
      target.persistedName.length > 512 ||
      target.persistedName.trim() !== target.persistedName ||
      [...target.persistedName].some(
        (character) => character.codePointAt(0)! <= 0x1f
      )
    )
  ) {
    fail(
      "ELECTRON_MACOS_APPKIT_TITLE_INVALID",
      "Core supplied an invalid AppKit runtime-window title."
    );
  }
  if (
    !Number.isSafeInteger(target.displayId) ||
    !Number.isFinite(target.scaleFactor) ||
    target.scaleFactor <= 0 ||
    target.scaleFactor > 8 ||
    !(["normal", "maximized", "fullscreen"] as const).includes(target.presentation)
  ) {
    fail(
      "ELECTRON_MACOS_APPKIT_DISPLAY_INVALID",
      "Core supplied invalid AppKit display or presentation evidence."
    );
  }
}

export function validateMacosAppKitRuntimeHostRequest(
  target: EmbeddedLaunchTargetRecord,
  initialTab: EmbeddedTabEffectRecord
): MacosAppKitRuntimeHostFences {
  requireMacosAppKitIdentifier(initialTab.tabId, "tab");
  const launchGeneration = requireMacosAppKitIdentifier(
    initialTab.attemptGeneration,
    "launch generation"
  );
  const windowGeneration = initialTab.appkitWindowGeneration;
  const topologyRevision = initialTab.appkitTopologyRevision;
  if (
    !Number.isSafeInteger(windowGeneration) ||
    (windowGeneration ?? 0) < 1 ||
    !Number.isSafeInteger(topologyRevision) ||
    (topologyRevision ?? 0) < 1
  ) {
    fail(
      "ELECTRON_MACOS_APPKIT_CORE_FENCE_MISSING",
      "The initial AppKit tab is missing its Rust-owned window generation or topology revision."
    );
  }
  if (
    initialTab.target.windowId !== target.windowId ||
    initialTab.target.displayId !== target.displayId ||
    initialTab.target.scaleFactor !== target.scaleFactor ||
    initialTab.target.presentation !== target.presentation ||
    JSON.stringify(initialTab.target.bounds) !== JSON.stringify(target.bounds) ||
    JSON.stringify(initialTab.target.workArea) !== JSON.stringify(target.workArea)
  ) {
    fail(
      "ELECTRON_MACOS_APPKIT_TARGET_MISMATCH",
      "The initial tab does not match the AppKit runtime-window target."
    );
  }
  validateTarget(target);
  return Object.freeze({
    launchGeneration,
    windowGeneration: windowGeneration!,
    topologyRevision: topologyRevision!
  });
}

export function validateMacosAppKitEmptyHostRequest(
  target: EmbeddedLaunchTargetRecord,
  identity: ChromiumRuntimeEmptyHostIdentity
): MacosAppKitRuntimeHostFences {
  validateTarget(target);
  const launchGeneration = requireMacosAppKitIdentifier(
    identity.attemptGeneration,
    "launch generation"
  );
  if (
    !Number.isSafeInteger(identity.windowGeneration) ||
    identity.windowGeneration < 1 ||
    !Number.isSafeInteger(identity.topologyRevision) ||
    identity.topologyRevision < 1
  ) {
    fail(
      "ELECTRON_MACOS_APPKIT_CORE_FENCE_MISSING",
      "The empty AppKit host is missing its positive Rust-owned generation or revision."
    );
  }
  return Object.freeze({
    launchGeneration,
    windowGeneration: identity.windowGeneration,
    topologyRevision: identity.topologyRevision
  });
}
