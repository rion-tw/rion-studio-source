import type {
  BrowserFontRuntimeFaceRecord,
  BrowserFontRuntimePayloadRecord,
  BrowserFontSelectionRecord,
  BrowserFontSettingsRecord
} from "../../shared/generated";

const FONT_SLOTS = ["cjk", "latin", "numeric", "monospace", "math"] as const;
const FONT_SLOT_SET = new Set<string>(FONT_SLOTS);
const MAX_FONT_FAMILY_BYTES = 120;
const MAX_FONT_FACE_COUNT = FONT_SLOTS.length * 256;
const MAX_FONT_FACE_BYTES = 16 * 1024 * 1024;
const MAX_FONT_PAYLOAD_BYTES = FONT_SLOTS.length * 64 * 1024 * 1024;
const MAX_UNICODE_RANGE_BYTES = 8 * 1024;
const MAX_BASE64_LENGTH = Math.ceil(MAX_FONT_FACE_BYTES / 3) * 4;
const encoder = new TextEncoder();

export class ChromiumRoleFontPayloadError extends Error {
  readonly code = "ELECTRON_ROLE_FONT_PAYLOAD_INVALID";
}

function invalid(message: string): never {
  throw new ChromiumRoleFontPayloadError(message);
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid(`The Chromium ${label} must be an exact object.`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    invalid(`The Chromium ${label} contains unsupported fields.`);
  }
  return record;
}

function optionalExactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid(`The Chromium ${label} must be an exact object.`);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    required.some((key) => !Object.hasOwn(record, key)) ||
    keys.some((key) => !required.includes(key) && !optional.includes(key))
  ) {
    invalid(`The Chromium ${label} contains unsupported fields.`);
  }
  return record;
}

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

function isCanonicalText(value: unknown, maximumBytes: number): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    byteLength(value) <= maximumBytes &&
    value.trim() === value &&
    ![...value].some((character) => {
      const point = character.codePointAt(0)!;
      return point <= 0x1f || point === 0x7f;
    });
}

function isCanonicalFamily(value: unknown): value is string {
  return isCanonicalText(value, MAX_FONT_FAMILY_BYTES) &&
    value.split(/\s+/u).join(" ") === value;
}

function parseSelection(value: unknown): BrowserFontSelectionRecord {
  const common = optionalExactRecord(
    value,
    ["source"],
    ["catalogId", "family"],
    "browser-font selection"
  );
  if (common.source === "system") {
    const record = exactRecord(
      value,
      ["source", "family"],
      "system browser-font selection"
    );
    if (!isCanonicalFamily(record.family)) {
      invalid("The Chromium system font family is not canonical.");
    }
    return Object.freeze({ source: "system", family: record.family });
  }
  if (common.source !== "google") {
    invalid("The Chromium browser-font selection source is invalid.");
  }
  const record = optionalExactRecord(
    value,
    ["source", "catalogId"],
    ["family"],
    "Google browser-font selection"
  );
  if (
    typeof record.catalogId !== "string" ||
    record.catalogId.length === 0 ||
    record.catalogId.length > 64 ||
    !/^[a-z0-9-]+$/u.test(record.catalogId)
  ) {
    invalid("The Chromium browser-font catalog identity is invalid.");
  }
  const custom = record.catalogId.startsWith("custom-");
  if (
    (custom && !isCanonicalFamily(record.family)) ||
    (!custom && Object.hasOwn(record, "family"))
  ) {
    invalid("The Chromium Google font family binding is invalid.");
  }
  return Object.freeze({
    source: "google",
    catalogId: record.catalogId,
    ...(custom ? { family: record.family as string } : {})
  });
}

function parseSettings(value: unknown): BrowserFontSettingsRecord {
  const record = optionalExactRecord(
    value,
    ["mode", "fontSmoothingEnabled", "cjkVariant", "slots"],
    ["presetId"],
    "browser-font settings"
  );
  if (record.mode !== "default" && record.mode !== "custom") {
    invalid("The Chromium browser-font mode is invalid.");
  }
  if (typeof record.fontSmoothingEnabled !== "boolean") {
    invalid("The Chromium browser-font smoothing setting is invalid.");
  }
  if (!new Set(["auto", "tc", "sc", "jp"]).has(String(record.cjkVariant))) {
    invalid("The Chromium browser-font CJK variant is invalid.");
  }
  if (
    Object.hasOwn(record, "presetId") &&
    (typeof record.presetId !== "string" ||
      record.presetId.length === 0 ||
      record.presetId.length > 64 ||
      !/^[a-z0-9-]+$/u.test(record.presetId))
  ) {
    invalid("The Chromium browser-font preset identity is invalid.");
  }
  if (!record.slots || typeof record.slots !== "object" || Array.isArray(record.slots)) {
    invalid("The Chromium browser-font slots must be an exact object.");
  }
  const slotRecord = record.slots as Record<string, unknown>;
  const slotKeys = Object.keys(slotRecord);
  if (slotKeys.length > FONT_SLOTS.length || slotKeys.some((key) => !FONT_SLOT_SET.has(key))) {
    invalid("The Chromium browser-font slots contain an invalid identity.");
  }
  const slots = Object.fromEntries(
    slotKeys.sort().map((slot) => [slot, parseSelection(slotRecord[slot])])
  ) as BrowserFontSettingsRecord["slots"];
  return Object.freeze({
    mode: record.mode,
    fontSmoothingEnabled: record.fontSmoothingEnabled,
    ...(Object.hasOwn(record, "presetId")
      ? { presetId: record.presetId as string }
      : {}),
    cjkVariant: record.cjkVariant as BrowserFontSettingsRecord["cjkVariant"],
    slots: Object.freeze(slots)
  });
}

function decodedBase64Length(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return value.length / 4 * 3 - padding;
}

function hasWoff2Header(value: string): boolean {
  try {
    return atob(value.slice(0, 8)).startsWith("wOF2");
  } catch {
    return false;
  }
}

function isCanonicalBase64(value: string): boolean {
  try {
    return btoa(atob(value)) === value;
  } catch {
    return false;
  }
}

function parseFace(
  value: unknown,
  googleSelections: ReadonlyMap<string, BrowserFontSelectionRecord>
): Readonly<{ face: BrowserFontRuntimeFaceRecord; decodedBytes: number }> {
  const record = exactRecord(
    value,
    ["catalogId", "family", "style", "weight", "unicodeRange", "dataBase64"],
    "browser-font face"
  );
  if (
    typeof record.catalogId !== "string" ||
    !googleSelections.has(record.catalogId)
  ) {
    invalid("The Chromium browser-font face is not selected by this payload.");
  }
  if (!isCanonicalFamily(record.family)) {
    invalid("The Chromium browser-font face family is not canonical.");
  }
  const selection = googleSelections.get(record.catalogId)!;
  if (
    selection.source !== "google" ||
    (selection.family !== undefined && selection.family !== record.family)
  ) {
    invalid("The Chromium browser-font face family does not match its selection.");
  }
  if (
    !isCanonicalText(record.style, 32) ||
    !isCanonicalText(record.weight, 32) ||
    typeof record.unicodeRange !== "string" ||
    byteLength(record.unicodeRange) > MAX_UNICODE_RANGE_BYTES ||
    [...record.unicodeRange].some((character) => {
      const point = character.codePointAt(0)!;
      return point <= 0x1f || point === 0x7f;
    })
  ) {
    invalid("The Chromium browser-font face descriptors are invalid.");
  }
  if (
    typeof record.dataBase64 !== "string" ||
    record.dataBase64.length < 8 ||
    record.dataBase64.length > MAX_BASE64_LENGTH ||
    record.dataBase64.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(record.dataBase64) ||
    !isCanonicalBase64(record.dataBase64) ||
    !hasWoff2Header(record.dataBase64)
  ) {
    invalid("The Chromium browser-font face bytes are not canonical WOFF2 data.");
  }
  const decodedBytes = decodedBase64Length(record.dataBase64);
  if (decodedBytes > MAX_FONT_FACE_BYTES) {
    invalid("The Chromium browser-font face exceeds its byte bound.");
  }
  return Object.freeze({
    decodedBytes,
    face: Object.freeze({
      catalogId: record.catalogId,
      family: record.family,
      style: record.style,
      weight: record.weight,
      unicodeRange: record.unicodeRange,
      dataBase64: record.dataBase64
    })
  });
}

export function validateChromiumRoleFontPayload(
  value: unknown
): BrowserFontRuntimePayloadRecord {
  const record = exactRecord(value, ["settings", "faces"], "browser-font payload");
  const settings = parseSettings(record.settings);
  if (!Array.isArray(record.faces) || record.faces.length > MAX_FONT_FACE_COUNT) {
    invalid("The Chromium browser-font payload contains too many faces.");
  }
  const googleSelections = new Map<string, BrowserFontSelectionRecord>();
  for (const selection of Object.values(settings.slots)) {
    if (selection?.source === "google") {
      googleSelections.set(selection.catalogId, selection);
    }
  }
  const countByCatalog = new Map<string, number>();
  let totalDecodedBytes = 0;
  const faces = record.faces.map((candidate) => {
    const parsed = parseFace(candidate, googleSelections);
    const count = (countByCatalog.get(parsed.face.catalogId) ?? 0) + 1;
    if (count > 256) {
      invalid("The Chromium browser-font payload exceeds one catalog's face bound.");
    }
    countByCatalog.set(parsed.face.catalogId, count);
    totalDecodedBytes += parsed.decodedBytes;
    if (totalDecodedBytes > MAX_FONT_PAYLOAD_BYTES) {
      invalid("The Chromium browser-font payload exceeds its aggregate byte bound.");
    }
    return parsed.face;
  });
  const frozenFaces = Object.freeze(faces) as unknown as BrowserFontRuntimeFaceRecord[];
  return Object.freeze({ settings, faces: frozenFaces });
}

export function chromiumRoleFontMaximumLoadedFaceCount(
  payload: BrowserFontRuntimePayloadRecord
): number {
  const facesByCatalog = new Map<string, number>();
  for (const face of payload.faces) {
    facesByCatalog.set(
      face.catalogId,
      (facesByCatalog.get(face.catalogId) ?? 0) + 1
    );
  }
  return Object.values(payload.settings.slots).reduce((total, selection) => {
    if (!selection) return total;
    return total + (selection.source === "google"
      ? facesByCatalog.get(selection.catalogId) ?? 0
      : 1);
  }, 0);
}
