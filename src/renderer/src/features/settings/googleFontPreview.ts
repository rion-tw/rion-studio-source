export type GoogleFontPreviewStatus = "idle" | "loading" | "loaded" | "error";

export interface GoogleFontPreviewRequest {
  families: string[];
  text: string;
  url: string;
}

const GOOGLE_FONT_CSS_ENDPOINT = "https://fonts.googleapis.com/css2";
const MAX_REQUEST_URL_LENGTH = 1_800;
const LOAD_TIMEOUT_MS = 10_000;

interface PreviewEntry {
  family: string;
  status: GoogleFontPreviewStatus;
  subscribers: Set<(status: GoogleFontPreviewStatus) => void>;
  text: string;
}

const entries = new Map<string, PreviewEntry>();
const pendingFamiliesByText = new Map<string, Set<string>>();
const previewLinks = new Set<HTMLLinkElement>();
let flushScheduled = false;

export function buildGoogleFontPreviewRequests(
  families: readonly string[],
  text: string,
  maxUrlLength = MAX_REQUEST_URL_LENGTH
): GoogleFontPreviewRequest[] {
  const normalizedText = text.trim();
  const normalizedFamilies = [...new Set(families.map(normalizeFamily).filter(Boolean))].sort(
    (left, right) => left.localeCompare(right)
  );
  if (!normalizedText || normalizedFamilies.length === 0) return [];

  const requests: GoogleFontPreviewRequest[] = [];
  let chunk: string[] = [];
  for (const family of normalizedFamilies) {
    const candidate = [...chunk, family];
    const candidateUrl = buildRequestUrl(candidate, normalizedText);
    if (chunk.length > 0 && candidateUrl.length > maxUrlLength) {
      requests.push({ families: chunk, text: normalizedText, url: buildRequestUrl(chunk, normalizedText) });
      chunk = [family];
    } else {
      chunk = candidate;
    }
  }
  if (chunk.length > 0) {
    requests.push({ families: chunk, text: normalizedText, url: buildRequestUrl(chunk, normalizedText) });
  }
  return requests;
}

export function requestGoogleFontPreview(family: string, text: string): void {
  const normalizedFamily = normalizeFamily(family);
  const normalizedText = text.trim();
  if (!normalizedFamily || !normalizedText) return;
  const key = previewKey(normalizedFamily, normalizedText);
  const existing = entries.get(key);
  if (existing && (existing.status === "loading" || existing.status === "loaded")) return;

  const entry: PreviewEntry = existing ?? {
    family: normalizedFamily,
    status: "idle",
    subscribers: new Set(),
    text: normalizedText
  };
  entries.set(key, entry);
  updateStatus(entry, "loading");
  const pending = pendingFamiliesByText.get(normalizedText) ?? new Set<string>();
  pending.add(normalizedFamily);
  pendingFamiliesByText.set(normalizedText, pending);
  scheduleFlush();
}

export function retryGoogleFontPreview(family: string, text: string): void {
  const normalizedFamily = normalizeFamily(family);
  const normalizedText = text.trim();
  if (!normalizedFamily || !normalizedText) return;
  requestGoogleFontPreview(normalizedFamily, normalizedText);
}

export function getGoogleFontPreviewStatus(family: string, text: string): GoogleFontPreviewStatus {
  return entries.get(previewKey(normalizeFamily(family), text.trim()))?.status ?? "idle";
}

export function subscribeGoogleFontPreview(
  family: string,
  text: string,
  subscriber: (status: GoogleFontPreviewStatus) => void
): () => void {
  const normalizedFamily = normalizeFamily(family);
  const normalizedText = text.trim();
  if (!normalizedFamily || !normalizedText) return () => undefined;
  const key = previewKey(normalizedFamily, normalizedText);
  const entry = entries.get(key) ?? {
    family: normalizedFamily,
    status: "idle" as const,
    subscribers: new Set<(status: GoogleFontPreviewStatus) => void>(),
    text: normalizedText
  };
  entries.set(key, entry);
  entry.subscribers.add(subscriber);
  subscriber(entry.status);
  return () => entry.subscribers.delete(subscriber);
}

export function quoteFontFamily(family: string): string {
  return `"${family.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function resetGoogleFontPreviewRegistryForTests(): void {
  entries.clear();
  pendingFamiliesByText.clear();
  flushScheduled = false;
  for (const link of previewLinks) link.remove();
  previewLinks.clear();
}

function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(() => {
    flushScheduled = false;
    flushPendingRequests();
  });
}

function flushPendingRequests(): void {
  if (typeof document === "undefined") {
    failPendingRequests();
    return;
  }
  const batches = [...pendingFamiliesByText.entries()];
  pendingFamiliesByText.clear();
  for (const [text, families] of batches) {
    for (const request of buildGoogleFontPreviewRequests([...families], text)) {
      loadRequest(request);
    }
  }
}

function loadRequest(request: GoogleFontPreviewRequest): void {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = request.url;
  link.dataset.rionGoogleFontPreview = "true";
  previewLinks.add(link);
  let settled = false;
  const timeout = window.setTimeout(() => settle(false), LOAD_TIMEOUT_MS);

  const settle = (loaded: boolean): void => {
    if (settled) return;
    settled = true;
    window.clearTimeout(timeout);
    if (!loaded) {
      for (const family of request.families) markRequestStatus(family, request.text, "error");
      return;
    }
    const fontSet = document.fonts;
    if (!fontSet?.load) {
      for (const family of request.families) markRequestStatus(family, request.text, "loaded");
      return;
    }
    void Promise.allSettled(
      request.families.map(async (family) => {
        try {
          await fontSet.load(`400 16px ${quoteFontFamily(family)}`, request.text);
          markRequestStatus(family, request.text, "loaded");
        } catch {
          markRequestStatus(family, request.text, "error");
        }
      })
    );
  };

  link.onload = () => settle(true);
  link.onerror = () => settle(false);
  document.head.append(link);
}

function failPendingRequests(): void {
  for (const [text, families] of pendingFamiliesByText) {
    for (const family of families) markRequestStatus(family, text, "error");
  }
  pendingFamiliesByText.clear();
}

function markRequestStatus(
  family: string,
  text: string,
  status: GoogleFontPreviewStatus
): void {
  const entry = entries.get(previewKey(family, text));
  if (entry) updateStatus(entry, status);
}

function updateStatus(entry: PreviewEntry, status: GoogleFontPreviewStatus): void {
  entry.status = status;
  for (const subscriber of entry.subscribers) subscriber(status);
}

function buildRequestUrl(families: readonly string[], text: string): string {
  const parameters = new URLSearchParams();
  for (const family of families) parameters.append("family", family);
  parameters.set("display", "swap");
  parameters.set("text", text);
  return `${GOOGLE_FONT_CSS_ENDPOINT}?${parameters.toString()}`;
}

function normalizeFamily(family: string): string {
  const normalized = family.replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > 120) return "";
  return [...normalized].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  })
    ? ""
    : normalized;
}

function previewKey(family: string, text: string): string {
  return `${family}\u0000${text}`;
}
