import type { WebContents } from "electron";
import { RionBridgeError } from "../ipc/errors";

type FontContents = Pick<WebContents, "session" | "getURL" | "isDestroyed" | "mainFrame" | "on">;
const queryFamilies = `(async () => {
  const fonts = await window.queryLocalFonts();
  return [...new Set(fonts.map(font => font.family))].slice(0, 4096);
})()`;

function documentUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href;
  } catch { return ""; }
}

/** One authenticated app document may enumerate fonts; all other permissions stay denied. */
export function createChromiumSystemFontProvider(contents: FontContents, expectedUrl: string) {
  const trustedUrl = documentUrl(expectedUrl);
  if (!trustedUrl) throw new Error("The local font provider requires an exact application URL");
  let revision = 0;
  const current = () => !contents.isDestroyed() && documentUrl(contents.getURL()) === trustedUrl;
  const allowed = (owner: unknown, permission: string, details: unknown) => {
    const request = details as { isMainFrame?: boolean; requestingUrl?: string } | null;
    return owner === contents && permission === "local-fonts" && current() &&
      request?.isMainFrame === true && typeof request.requestingUrl === "string" &&
      documentUrl(request.requestingUrl) === trustedUrl;
  };
  contents.session.setPermissionCheckHandler((owner, permission, _origin, details) =>
    allowed(owner, permission, details));
  contents.session.setPermissionRequestHandler((owner, permission, callback, details) =>
    callback(allowed(owner, permission, details)));
  contents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) revision += 1;
  });
  contents.on("render-process-gone", () => { revision += 1; });
  const unavailable = () => new RionBridgeError({
    code: "ELECTRON_LOCAL_FONTS_DOCUMENT_RETIRED",
    message: "The application font request belongs to a retired document."
  });
  return {
    async list(): Promise<string[]> {
      if (!current()) throw unavailable();
      const expectedRevision = revision;
      const frame = contents.mainFrame;
      let result: unknown;
      try {
        // EventBound: queryLocalFonts settles from Chromium's native query, not a timer.
        result = await frame.executeJavaScript(queryFamilies, false);
      } catch {
        result = [];
      }
      if (!current() || revision !== expectedRevision || contents.mainFrame !== frame) throw unavailable();
      // Rust owns normalization, the cached result and the empty-provider fallback.
      return Array.isArray(result) && result.length <= 4096 &&
        result.every(value => typeof value === "string" && value.length <= 1024)
        ? result : [];
    }
  };
}
