export interface ChromiumDrmDecision {
  readonly allowed: boolean;
  readonly origin: string;
  readonly embeddingOrigin: string;
  readonly reason: "https-web-app" | "drm-disabled" | "invalid-requesting-origin" |
    "invalid-embedding-origin";
}

function httpsOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === ""
      ? url.origin : null;
  } catch {
    return null;
  }
}

function mainFrameUrl(contents: unknown): unknown {
  if (typeof contents !== "object" || contents === null) return undefined;
  try {
    const owner = contents as { getURL?: () => string; isDestroyed?: () => boolean };
    return owner.isDestroyed?.() ? undefined : owner.getURL?.();
  } catch {
    return undefined;
  }
}

/** Uses only native callback metadata. A top-level URL never substitutes for
 * an unknown requesting frame. Chromium retains Permissions Policy enforcement.
 */
export function decideChromiumDrmPermission(
  enabled: boolean,
  contents: unknown,
  requestingOrigin: unknown,
  details: unknown
): ChromiumDrmDecision {
  const frame = (typeof details === "object" && details !== null ? details : {}) as {
    requestingUrl?: unknown;
    embeddingOrigin?: unknown;
    isMainFrame?: unknown;
  };
  const origin = httpsOrigin(requestingOrigin ?? frame.requestingUrl);
  // Check callbacks supply embeddingOrigin for cross-origin frames; request
  // callbacks supply WebContents plus the requesting frame URL instead.
  const embedding = frame.embeddingOrigin !== undefined
    ? frame.embeddingOrigin
    : contents !== null && contents !== undefined ? mainFrameUrl(contents) : undefined;
  const embeddingOrigin = httpsOrigin(embedding);
  const reason = !enabled ? "drm-disabled"
    : !origin ? "invalid-requesting-origin"
    : !embeddingOrigin ? "invalid-embedding-origin"
    : "https-web-app";
  return {
    allowed: reason === "https-web-app",
    origin: origin ?? "null",
    embeddingOrigin: embeddingOrigin ?? "null",
    reason
  };
}
