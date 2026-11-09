import designTokensCss from "../../shared/designTokens.css?raw";
import indicatorCss from "../../shared/browser-overlay/runtimeIndicators.css?raw";
import indicatorSource from "../../shared/browser-overlay/runtimeIndicators.js?raw";
import {
  isGameEffectRuntimeSettings,
  type GameEffectRuntimeSettings
} from "../../shared/gameEffects";
import { CHROMIUM_ROLE_OVERLAY_WORLD_ID } from "../ipc/chromiumRoleOverlayProtocol";
import {
  CHROMIUM_ROLE_GAME_EFFECTS_SYNC_CHANNEL,
  CHROMIUM_ROLE_GAME_EFFECTS_TRACE_CHANNEL,
  CHROMIUM_ROLE_GAME_EFFECTS_TRACE_LINE_LIMIT,
  CHROMIUM_ROLE_PAGE_PRESENTATION_CHANNEL,
  isChromiumRolePagePresentationMessage,
  type ChromiumRolePagePresentationMessage
} from "../ipc/chromiumRolePagePresentationProtocol";
import { installChromiumRoleGameEffectsRuntime } from "./chromiumRoleGameEffectsRuntime";

const INDICATOR_CSS_TOKEN = JSON.stringify("__RION_STUDIO_RUNTIME_INDICATOR_CSS__");

export interface ChromiumRolePagePresentationPorts {
  readonly contextBridge: {
    executeInMainWorld: (script: { func: (...args: never[]) => unknown; args?: unknown[] }) => unknown;
  };
  readonly ipc: {
    sendSync: (channel: string) => unknown;
    send: (channel: string, message: string) => unknown;
    on: (channel: string, listener: (event: unknown, message: unknown) => void) => unknown;
  };
  readonly webFrame: {
    executeJavaScriptInIsolatedWorld: (
      worldId: number,
      scripts: Array<{ code: string; url?: string }>
    ) => Promise<unknown>;
  };
  readonly isMainFrame: boolean;
}

type EffectsSetter = (
  brightness: number, dimBrightSkills: boolean, hideHitEffects: boolean, density: number
) => void;

/** The indicator runtime is idempotent; each message re-asserts it once. */
export function assembleRuntimeIndicatorScript(message: ChromiumRolePagePresentationMessage): string {
  const css = JSON.stringify(`${designTokensCss}\n${indicatorCss}`);
  const runtime = indicatorSource.split(INDICATOR_CSS_TOKEN).join(css);
  const call = message.type === "zoomIndicator"
    ? `globalThis.__rionStudioZoomIndicator?.(${JSON.stringify(message.label)});`
    : message.type === "resizeIndicator"
      ? `globalThis.__rionStudioWorkspaceResizeIndicator?.(${JSON.stringify({ type: "show", label: message.label })});`
      : `globalThis.__rionStudioWorkspaceResizeIndicator?.({ type: "hide" });`;
  return `${runtime}\n${call}`;
}

function installEffects(
  ports: ChromiumRolePagePresentationPorts,
  settings: GameEffectRuntimeSettings,
  trace: boolean
): EffectsSetter | null {
  // Pages loaded while dimming is off keep the game's untouched WebGL.
  if (!settings.enabled) return null;
  // Development builds only: the main world hands back bounded summary lines.
  const report = (summary: unknown) => {
    if (typeof summary === "string" && summary.length <= CHROMIUM_ROLE_GAME_EFFECTS_TRACE_LINE_LIMIT) {
      ports.ipc.send(CHROMIUM_ROLE_GAME_EFFECTS_TRACE_CHANNEL, summary);
    }
  };
  const setter = ports.contextBridge.executeInMainWorld({
    func: installChromiumRoleGameEffectsRuntime as (...args: never[]) => unknown,
    args: [{
      brightness: settings.brightness,
      dimBrightSkills: settings.dimBrightSkills,
      hideHitEffects: settings.hideHitEffects,
      density: settings.density,
      ...(trace ? { report } : {})
    }]
  });
  return typeof setter === "function" ? setter as EffectsSetter : null;
}

export function installChromiumRolePagePresentation(ports: ChromiumRolePagePresentationPorts): boolean {
  if (!ports.isMainFrame) return false;
  let setEffects: EffectsSetter | null = null;
  try {
    const initial = ports.ipc.sendSync(CHROMIUM_ROLE_GAME_EFFECTS_SYNC_CHANNEL) as
      Partial<Record<"effects" | "trace", unknown>> | null;
    if (initial && isGameEffectRuntimeSettings(initial.effects)) {
      setEffects = installEffects(ports, initial.effects, initial.trace === true);
    }
  } catch {
    // The page keeps the game's own rendering when settings are unavailable.
  }
  ports.ipc.on(CHROMIUM_ROLE_PAGE_PRESENTATION_CHANNEL, (_event, message) => {
    if (!isChromiumRolePagePresentationMessage(message)) return;
    if (message.type === "effects") {
      const { settings } = message;
      if (!isGameEffectRuntimeSettings(settings)) return;
      // A page hooked earlier keeps its hooks; disabling makes them a pass-through.
      try {
        setEffects?.(settings.brightness, settings.dimBrightSkills, settings.hideHitEffects, settings.density);
      } catch {
        // The main-world runtime is presentation-only.
      }
      return;
    }
    void ports.webFrame.executeJavaScriptInIsolatedWorld(CHROMIUM_ROLE_OVERLAY_WORLD_ID, [{
      code: assembleRuntimeIndicatorScript(message),
      url: "rion-studio://runtime-indicators.js"
    }]).catch(() => undefined);
  });
  return true;
}
