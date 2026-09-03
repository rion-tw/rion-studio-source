import designTokensCss from "../../shared/designTokens.css?raw";
import keyboardInputGuardSource from
  "../../shared/browser-overlay/macro-overlay-runtime/keyboard-input-guard.js?raw";
import presentationAndLifecycleSource from
  "../../shared/browser-overlay/macro-overlay-runtime/presentation-and-lifecycle.js?raw";
import stateAndInputSource from
  "../../shared/browser-overlay/macro-overlay-runtime/state-and-input.js?raw";
import coordinateMeasurementSource from
  "../../shared/browser-overlay/macroCoordinateMeasurement.js?raw";
import overlayCss from "../../shared/browser-overlay/macroOverlay.css?raw";
import shortcutGuardSource from
  "../../shared/browser-overlay/macroOverlayShortcutGuard.js?raw";
import { CHROMIUM_ROLE_OVERLAY_API_KEY } from
  "../ipc/chromiumRoleOverlayProtocol";

const TOKENS = Object.freeze({
  binding: "__RION_STUDIO_MACRO_OVERLAY_BINDING__",
  coordinateModule: "__RION_STUDIO_MACRO_COORDINATE_MEASUREMENT_MODULE_SOURCE__",
  coordinateModuleImporter:
    "__RION_STUDIO_MACRO_COORDINATE_MEASUREMENT_MODULE_IMPORTER__",
  css: "__RION_STUDIO_MACRO_OVERLAY_CSS__",
  shortcutGuard: "__RION_STUDIO_MACRO_OVERLAY_SHORTCUT_GUARD__",
  trustedEventGuard: "__RION_STUDIO_MACRO_OVERLAY_TRUSTED_EVENT_GUARD__"
});

const CHROMIUM_BINDING_SOURCE = `(() => {
  const native = globalThis[${JSON.stringify(CHROMIUM_ROLE_OVERLAY_API_KEY)}];
  if (!native || typeof native.request !== "function") {
    throw new Error("Rion Studio Chromium overlay IPC is unavailable.");
  }
  Object.defineProperty(globalThis, "__rionStudioDocumentInstanceId", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: native.frameToken
  });
  const bridge = (payload) => native.request(payload);
  bridge.ready = () => native.ready();
  bridge.refreshReceipt = (payload) => native.refreshReceipt(payload);
  bridge.managedShortcutKeyPhase = (payload) => native.managedShortcutKeyPhase(payload);
  if (typeof native.inputContextLost === "function") {
    bridge.inputContextLost = (payload) => native.inputContextLost(payload);
  }
  return Object.freeze(bridge);
})()`;

function replaceSingleToken(source: string, token: string, replacement: string): string {
  const serialized = JSON.stringify(token);
  const first = source.indexOf(serialized);
  if (first < 0 || source.indexOf(serialized, first + serialized.length) >= 0) {
    throw new Error(`Chromium overlay source token must occur exactly once: ${token}`);
  }
  return `${source.slice(0, first)}${replacement}${source.slice(first + serialized.length)}`;
}

export function assembleChromiumRoleOverlaySource(): string {
  const runtime = [
    stateAndInputSource,
    keyboardInputGuardSource,
    presentationAndLifecycleSource
  ].join("\n");
  const replacements = [
    [TOKENS.shortcutGuard, shortcutGuardSource.trim()],
    [TOKENS.trustedEventGuard, "(event) => event.isTrusted === true"],
    [TOKENS.css, JSON.stringify(`${designTokensCss}\n${overlayCss}`)],
    [TOKENS.coordinateModule, JSON.stringify(coordinateMeasurementSource)],
    [TOKENS.coordinateModuleImporter, "(moduleUrl) => import(moduleUrl)"],
    [TOKENS.binding, CHROMIUM_BINDING_SOURCE]
  ] as const;
  const assembled = replacements.reduce(
    (source, [token, replacement]) => replaceSingleToken(source, token, replacement),
    runtime
  );
  for (const token of Object.values(TOKENS)) {
    if (assembled.includes(token)) {
      throw new Error(`Chromium overlay source retained an unresolved token: ${token}`);
    }
  }
  return assembled;
}
