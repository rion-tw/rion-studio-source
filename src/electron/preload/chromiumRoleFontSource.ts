import browserFontsRuntimeSource from
  "../../shared/browser-overlay/browserFontsRuntime.js?raw";
import type { BrowserFontRuntimePayloadRecord } from "../../shared/generated";

const INJECTED_PAYLOAD_KEY = "__rionStudioBrowserFontsInjectedPayloadV1";

function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

export function assembleChromiumRoleFontSource(
  payload: BrowserFontRuntimePayloadRecord
): string {
  const source = browserFontsRuntimeSource.trim();
  if (
    !source.startsWith("(() => {") ||
    !source.endsWith("})();") ||
    !source.includes(INJECTED_PAYLOAD_KEY)
  ) {
    throw new Error("The shared browser-font runtime source is not canonical.");
  }
  return `(() => {
    const key = ${JSON.stringify(INJECTED_PAYLOAD_KEY)};
    if (Object.prototype.hasOwnProperty.call(globalThis, key)) {
      throw new Error("The browser-font injection slot is already occupied.");
    }
    Object.defineProperty(globalThis, key, {
      configurable: true,
      enumerable: false,
      writable: false,
      value: ${scriptJson(payload)}
    });
    try {
      const application = ${source}
      return Promise.resolve(application);
    } catch (error) {
      delete globalThis[key];
      throw error;
    }
  })()`;
}
