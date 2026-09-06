import type { CoreEffectRequest, RuntimeWindowPreferencesRecord } from
  "../../shared/generated";
import type { RuntimeTabActivationPhaseRecord } from "../../shared/generated";
import type {
  WindowsRuntimeHostMoveTargetProjection,
  WindowsRuntimeWorkspaceDividerProjection
} from
  "../../shared/windowsRuntimeHost";
import { RionBridgeError } from "../ipc/errors";
import type { ChromiumRuntimeEffectExecutorInput } from
  "./chromiumRuntimeEffectExecutor";
import type { ChromiumRuntimeHostProjection } from "./chromiumRuntimeHostPorts";
import type {
  ChromiumRuntimeRoleRecord,
  ChromiumRuntimeTabRecord,
  ChromiumRuntimeWebSurfaceRecord,
  ChromiumRuntimeWindowRecord
} from "./chromiumRuntimeAppKitProjection";

export interface ChromiumRuntimeWindowChromeTab {
  readonly active: boolean;
  readonly audioMuted: boolean;
  readonly hidden: boolean;
  readonly name: string;
  readonly phase: RuntimeTabActivationPhaseRecord;
  readonly tabId: string;
}

export interface ChromiumRuntimeWindowChromeLayoutTab {
  readonly active: boolean;
  readonly audioMuted: boolean;
  readonly hidden: boolean;
  readonly name: string;
  readonly tabId: string;
}

export interface ChromiumRuntimeWindowChromeProjection {
  readonly activeTabId: string | null;
  readonly contentBounds: Readonly<{ x: number; y: number; width: number; height: number }>;
  readonly moveTargets: readonly WindowsRuntimeHostMoveTargetProjection[];
  readonly tabs: readonly ChromiumRuntimeWindowChromeTab[];
  readonly topologyRevision: number;
  readonly windowGeneration: number;
  readonly windowId: string;
  readonly workspaceDividers: readonly WindowsRuntimeWorkspaceDividerProjection[];
}

export type ChromiumRuntimeWindowChromeLayoutProjection = Omit<
  ChromiumRuntimeWindowChromeProjection,
  "moveTargets" | "tabs"
> & Readonly<{ tabs: readonly ChromiumRuntimeWindowChromeLayoutTab[] }>;

export interface ChromiumRuntimeWindowPresentationRequest {
  readonly presentation: "fullscreen" | "maximized" | "normal";
  readonly topologyRevision: number;
  readonly windowGeneration: number;
  readonly windowId: string;
}

export interface ChromiumRuntimeFullscreenToolbarObservation {
  readonly alwaysShowToolbarInFullScreen: boolean;
  readonly fullscreen: boolean;
  readonly nativeControlsVisible: boolean;
  readonly nativeWindowControlCount: number;
  readonly projectionRevision: number;
  readonly revealed: boolean;
  readonly toolbarVisible: boolean;
  readonly topologyRevision: number;
  readonly windowGeneration: number;
  readonly windowId: string;
  readonly appKit?: Readonly<{
    accessoryOnScreen: boolean;
    accessoryVisibleHeight: number;
    fullscreenHostReady: boolean;
    presentationAutoHideToolbar: boolean;
    revealLocked: boolean;
    tabCloseButtonEnabledCount: number;
    fullscreenControlScreenBounds?: Readonly<{
      height: number;
      width: number;
      x: number;
      y: number;
    }>;
    tabScreenBounds?: Readonly<{
      height: number;
      width: number;
      x: number;
      y: number;
    }>;
    tabAnchors?: Readonly<Record<string, Readonly<{ x: number; y: number }>>>;
    tabStripOnScreen: boolean;
    toolbarPinned: boolean;
    visibleTrafficLightCount: number;
  }>;
}

export interface ChromiumRuntimeWindowPreferencesProjectionPort {
  applyWindowPreferences: (
    preferences: RuntimeWindowPreferencesRecord
  ) => Promise<void>;
}

export interface ChromiumRuntimeFullscreenToolbarInspection {
  readonly hostKind: "appkit" | "windows";
  readonly native: ChromiumRuntimeFullscreenToolbarObservation;
  readonly presentation: "fullscreen" | "maximized" | "normal";
  readonly surfaces: readonly Readonly<{
    bounds: Readonly<{ x: number; y: number; width: number; height: number }>;
    generation: number;
    id: string;
    kind: "role" | "web";
    tabId: string;
    visible: boolean;
  }>[];
  readonly tabIds: readonly string[];
  readonly topologyRevision: number;
  readonly windowGeneration: number;
  readonly windowId: string;
}

type PresentationAction = Extract<
  CoreEffectRequest["action"],
  { type: "embeddedSetRuntimeWindowPresentation" }
>;

function fullscreenError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    value === value.trim() && !value.includes("/") && !value.includes("\\") &&
    ![...value].some((character) => character.codePointAt(0)! <= 0x1f);
}

/**
 * Runs the Core-owned presentation effect against one exact native host.
 * Completion comes only from the host's native enter/leave/maximize event (or
 * an exact native readback when the requested presentation is already live).
 */
export async function applyChromiumRuntimeWindowPresentationEffect(input: {
  readonly effect: CoreEffectRequest;
  readonly action: PresentationAction;
  readonly windows: Map<string, ChromiumRuntimeWindowRecord>;
}): Promise<ChromiumRuntimeHostProjection> {
  const { effect, action } = input;
  if (
    effect.target.kind !== "app" || effect.target.handleId !== action.windowId ||
    effect.completionPolicy !== "eventBound" || effect.deadlineMs !== undefined ||
    !validIdentifier(action.windowId) ||
    !Number.isSafeInteger(action.windowGeneration) || action.windowGeneration < 1 ||
    !Number.isSafeInteger(action.topologyRevision) || action.topologyRevision < 1 ||
    !(["normal", "maximized", "fullscreen"] as const).includes(action.presentation)
  ) {
    throw fullscreenError(
      "ELECTRON_RUNTIME_WINDOW_PRESENTATION_EFFECT_INVALID",
      "Core supplied a malformed or deadline-bound native presentation effect."
    );
  }
  const record = input.windows.get(action.windowId);
  if (
    !record || record.host.isDestroyed() ||
    record.windowGeneration !== action.windowGeneration ||
    action.topologyRevision < record.topologyRevision ||
    !record.host.setRuntimeWindowPresentation
  ) {
    throw fullscreenError(
      "ELECTRON_RUNTIME_WINDOW_PRESENTATION_FENCE_STALE",
      "The native runtime window no longer owns the exact Core presentation fence."
    );
  }
  const projection = await record.host.setRuntimeWindowPresentation({
    windowId: action.windowId,
    windowGeneration: action.windowGeneration,
    topologyRevision: action.topologyRevision,
    presentation: action.presentation
  });
  if (projection.presentation !== action.presentation) {
    throw fullscreenError(
      "ELECTRON_RUNTIME_WINDOW_PRESENTATION_READBACK_MISMATCH",
      "The native presentation event completed without the requested readback."
    );
  }
  record.hostTarget = Object.freeze({
    ...record.hostTarget,
    presentation: action.presentation
  });
  record.topologyRevision = Math.max(
    record.topologyRevision,
    action.topologyRevision
  );
  return projection;
}

/** Bind exact toolbar geometry changes to every live Role/Web surface. */
export function bindChromiumRuntimeWindowLayout(input: {
  readonly ports: ChromiumRuntimeEffectExecutorInput;
  readonly record: ChromiumRuntimeWindowRecord;
  readonly tabs: Map<string, ChromiumRuntimeTabRecord>;
  readonly roles: Map<string, ChromiumRuntimeRoleRecord>;
  readonly webSurfaces: Map<string, ChromiumRuntimeWebSurfaceRecord>;
}): void {
  const { record } = input;
  if (!record.host.bindRuntimeWindowLayout) return;
  record.host.bindRuntimeWindowLayout(async () => {
    const workspaceDividers: WindowsRuntimeWorkspaceDividerProjection[] = [];
    let contentBounds = record.host.getContentBounds();
    for (const tabId of record.tabIds) {
      const tab = input.tabs.get(tabId);
      if (!tab || tab.windowId !== record.host.logicalWindowId) continue;
      const layout = input.ports.layout.resolveWorkspaceLayout
        ? await input.ports.layout.resolveWorkspaceLayout(
            tab.specification,
            record.host
          )
        : null;
      const bounds = layout?.roles ?? await input.ports.layout.resolveRoleBounds(
          tab.specification,
          record.host
        );
      if (layout) {
        contentBounds = layout.contentBounds;
        const attemptGeneration = tab.specification.attemptGeneration;
        if (tab.specification.workspaceId && attemptGeneration) {
          workspaceDividers.push(...layout.dividers.map((divider) => ({
            attemptGeneration,
            axis: divider.axis,
            bounds: Object.freeze({ ...divider.bounds }),
            dividerIndex: divider.index,
            tabId,
            visible: record.activeTabId === tabId &&
              !record.hiddenTabIds.has(tabId) && record.host.isVisible()
          })));
        }
      }
      for (const role of input.roles.values()) {
        if (role.tabId !== tabId || role.windowId !== record.host.logicalWindowId) continue;
        const next = bounds.get(role.roleId);
        if (next) input.ports.surfaces.setBounds(role.roleId, role.generation, next);
      }
      for (const surface of input.webSurfaces.values()) {
        if (surface.tabId !== tabId || surface.windowId !== record.host.logicalWindowId) {
          continue;
        }
        const next = bounds.get(surface.surfaceId);
        if (next) {
          input.ports.webSurfaces.setBounds(surface.surfaceId, surface.generation, next);
        }
      }
    }
    if (record.host.applyWindowsChromeLayoutProjection && record.windowGeneration > 0 &&
        record.topologyRevision > 0) {
      await record.host.applyWindowsChromeLayoutProjection({
        activeTabId: record.activeTabId || null,
        contentBounds: Object.freeze({ ...contentBounds }),
        tabs: Object.freeze(record.tabIds.map((tabId) => {
          const tab = input.tabs.get(tabId);
          if (!tab) {
            throw fullscreenError(
              "ELECTRON_RUNTIME_WINDOW_LAYOUT_TAB_STALE",
              "The native Windows relayout lost an exact Core tab."
            );
          }
          return Object.freeze({
            active: record.activeTabId === tabId,
            audioMuted: tab.audioMuted,
            hidden: record.hiddenTabIds.has(tabId),
            name: tab.specification.name,
            tabId
          });
        })),
        topologyRevision: record.topologyRevision,
        windowGeneration: record.windowGeneration,
        windowId: record.host.logicalWindowId,
        workspaceDividers: Object.freeze(workspaceDividers)
      });
    }
  });
}

/** Captures read-only native/Core identity evidence for desktop E2E. */
export function inspectChromiumRuntimeFullscreenToolbar(input: {
  readonly ports: ChromiumRuntimeEffectExecutorInput;
  readonly roles: Map<string, ChromiumRuntimeRoleRecord>;
  readonly webSurfaces: Map<string, ChromiumRuntimeWebSurfaceRecord>;
  readonly windows: Map<string, ChromiumRuntimeWindowRecord>;
  readonly windowId: string;
}): ChromiumRuntimeFullscreenToolbarInspection {
  const record = input.windows.get(input.windowId);
  if (!record || record.host.isDestroyed() || !record.host.readFullscreenToolbar) {
    throw fullscreenError(
      "ELECTRON_RUNTIME_FULLSCREEN_TOOLBAR_OBSERVATION_STALE",
      "The requested runtime window has no exact fullscreen-toolbar observer."
    );
  }
  const native = record.host.readFullscreenToolbar();
  if (
    native.windowId !== input.windowId ||
    native.windowGeneration !== record.windowGeneration ||
    native.topologyRevision !== record.topologyRevision
  ) {
    throw fullscreenError(
      "ELECTRON_RUNTIME_FULLSCREEN_TOOLBAR_OBSERVATION_FENCE_STALE",
      "The native fullscreen-toolbar observation lost its Core fence."
    );
  }
  const surfaces = [
    ...[...input.roles.values()]
      .filter((role) => role.windowId === input.windowId)
      .map((role) => {
        const projection = input.ports.surfaces.readProjection(
          role.roleId,
          role.generation
        );
        return Object.freeze({
          bounds: Object.freeze({ ...projection.bounds }),
          generation: role.generation,
          id: role.roleId,
          kind: "role" as const,
          tabId: role.tabId,
          visible: projection.visible
        });
      }),
    ...[...input.webSurfaces.values()]
      .filter((surface) => surface.windowId === input.windowId)
      .map((surface) => {
        const projection = input.ports.webSurfaces.readProjection(
          surface.surfaceId,
          surface.generation
        );
        return Object.freeze({
          bounds: Object.freeze({ ...projection.bounds }),
          generation: surface.generation,
          id: surface.surfaceId,
          kind: "web" as const,
          tabId: surface.tabId,
          visible: projection.visible
        });
      })
  ].sort((left, right) => left.id.localeCompare(right.id));
  return Object.freeze({
    hostKind: record.host.appKitIdentity ? "appkit" : "windows",
    native,
    presentation: record.host.readProjection().presentation,
    surfaces: Object.freeze(surfaces),
    tabIds: Object.freeze([...record.tabIds]),
    topologyRevision: record.topologyRevision,
    windowGeneration: record.windowGeneration,
    windowId: input.windowId
  });
}
