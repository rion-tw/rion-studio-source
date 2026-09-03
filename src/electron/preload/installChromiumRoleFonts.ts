import {
  CHROMIUM_ROLE_FONTS_CHANNEL,
  CHROMIUM_ROLE_FONTS_REFRESH_CHANNEL,
  CHROMIUM_ROLE_FONTS_RUNTIME_VERSION,
  type ChromiumRoleFontsApplicationEvidence,
  type ChromiumRoleFontsEnvelope,
  type ChromiumRoleFontsFailurePayload,
  type ChromiumRoleFontsPayloadResponse,
  type ChromiumRoleFontsReceiptPayload,
  type ChromiumRoleFontsRefreshControl
} from "../ipc/chromiumRoleFontsProtocol";
import {
  chromiumRoleFontMaximumLoadedFaceCount,
  ChromiumRoleFontPayloadError,
  validateChromiumRoleFontPayload
} from "./chromiumRoleFontPayload";
import { assembleChromiumRoleFontSource } from "./chromiumRoleFontSource";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export interface ChromiumRoleFontsIpcRendererPort {
  invoke: (channel: string, envelope: ChromiumRoleFontsEnvelope) => Promise<unknown>;
  on: (
    channel: string,
    listener: (event: unknown, control: unknown) => void
  ) => unknown;
}

export interface ChromiumRoleFontsWebFramePort {
  readonly frameToken: string;
  executeJavaScript: (code: string, userGesture?: boolean) => Promise<unknown>;
}

class ChromiumRoleFontsPreloadError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new ChromiumRoleFontsPreloadError(code, message);
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  code: string,
  message: string
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(code, message);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(code, message);
  }
  return record;
}

function validFrameToken(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    value.trim() === value;
}

function validRoleId(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value &&
    ![...value].some((character) => character.codePointAt(0)! <= 0x1f);
}

function validId(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function parseControl(
  value: unknown,
  frameToken: string
): ChromiumRoleFontsRefreshControl {
  const record = exactRecord(
    value,
    ["frameToken", "generation", "refreshId", "roleId"],
    "ELECTRON_ROLE_FONT_REFRESH_CONTROL_INVALID",
    "The Chromium browser-font refresh control is malformed."
  );
  if (
    record.frameToken !== frameToken ||
    !Number.isSafeInteger(record.generation) ||
    (record.generation as number) < 1 ||
    !validId(record.refreshId) ||
    !validRoleId(record.roleId)
  ) {
    fail(
      "ELECTRON_ROLE_FONT_REFRESH_CONTROL_INVALID",
      "The Chromium browser-font refresh control is stale or malformed."
    );
  }
  return Object.freeze({
    frameToken,
    generation: record.generation as number,
    refreshId: record.refreshId,
    roleId: record.roleId
  });
}

function parsePayloadResponse(
  value: unknown,
  frameToken: string,
  refreshId: string | null,
  expected?: ChromiumRoleFontsRefreshControl
): ChromiumRoleFontsPayloadResponse {
  const record = exactRecord(
    value,
    [
      "applicationId",
      "frameToken",
      "generation",
      "payload",
      "payloadRevision",
      "refreshId",
      "roleId"
    ],
    "ELECTRON_ROLE_FONT_PAYLOAD_RESPONSE_INVALID",
    "The Chromium browser-font payload response is malformed."
  );
  if (
    !validId(record.applicationId) ||
    record.frameToken !== frameToken ||
    !Number.isSafeInteger(record.generation) ||
    (record.generation as number) < 1 ||
    !Number.isSafeInteger(record.payloadRevision) ||
    (record.payloadRevision as number) < 1 ||
    record.refreshId !== refreshId ||
    !validRoleId(record.roleId) ||
    (expected !== undefined && (
      record.generation !== expected.generation ||
      record.roleId !== expected.roleId
    ))
  ) {
    fail(
      "ELECTRON_ROLE_FONT_PAYLOAD_RESPONSE_INVALID",
      "The Chromium browser-font payload response does not match the live document."
    );
  }
  let payload;
  try {
    payload = validateChromiumRoleFontPayload(record.payload);
  } catch (error) {
    if (error instanceof ChromiumRoleFontPayloadError) {
      fail(error.code, error.message);
    }
    throw error;
  }
  return Object.freeze({
    applicationId: record.applicationId,
    frameToken,
    generation: record.generation as number,
    payload,
    payloadRevision: record.payloadRevision as number,
    refreshId,
    roleId: record.roleId
  });
}

function parseEvidence(
  value: unknown,
  response: ChromiumRoleFontsPayloadResponse
): ChromiumRoleFontsApplicationEvidence {
  const record = exactRecord(
    value,
    [
      "canvasFontsActive",
      "canvasTextQualityActive",
      "failedFaceCount",
      "fontMode",
      "fontSmoothingEnabled",
      "loadedCatalogIds",
      "loadedFaceCount",
      "runtimeVersion",
      "sequence",
      "status",
      "styleInstalled"
    ],
    "ELECTRON_ROLE_FONT_MAIN_WORLD_RECEIPT_INVALID",
    "The main-world browser-font runtime returned a malformed receipt."
  );
  const loadedCatalogIds = record.loadedCatalogIds;
  const fontMode = record.fontMode;
  if (
    typeof record.canvasFontsActive !== "boolean" ||
    typeof record.canvasTextQualityActive !== "boolean" ||
    !Number.isSafeInteger(record.failedFaceCount) ||
    (record.failedFaceCount as number) < 0 ||
    fontMode !== response.payload.settings.mode ||
    record.fontSmoothingEnabled !== response.payload.settings.fontSmoothingEnabled ||
    !Array.isArray(loadedCatalogIds) ||
    loadedCatalogIds.some((id) => typeof id !== "string" || !/^[a-z0-9-]+$/u.test(id)) ||
    new Set(loadedCatalogIds).size !== loadedCatalogIds.length ||
    [...loadedCatalogIds].sort().some((id, index) => id !== loadedCatalogIds[index]) ||
    !Number.isSafeInteger(record.loadedFaceCount) ||
    (record.loadedFaceCount as number) < 0 ||
    (record.loadedFaceCount as number) >
      chromiumRoleFontMaximumLoadedFaceCount(response.payload) ||
    record.runtimeVersion !== CHROMIUM_ROLE_FONTS_RUNTIME_VERSION ||
    !Number.isSafeInteger(record.sequence) ||
    (record.sequence as number) < 1 ||
    record.status !== "applied" ||
    typeof record.styleInstalled !== "boolean"
  ) {
    fail(
      "ELECTRON_ROLE_FONT_MAIN_WORLD_RECEIPT_INVALID",
      "The main-world browser-font runtime receipt does not match its payload."
    );
  }
  return Object.freeze({
    canvasFontsActive: record.canvasFontsActive,
    canvasTextQualityActive: record.canvasTextQualityActive,
    failedFaceCount: record.failedFaceCount as number,
    fontMode: fontMode as "default" | "custom",
    fontSmoothingEnabled: record.fontSmoothingEnabled,
    loadedCatalogIds: Object.freeze([...(loadedCatalogIds as string[])]),
    loadedFaceCount: record.loadedFaceCount as number,
    runtimeVersion: CHROMIUM_ROLE_FONTS_RUNTIME_VERSION,
    sequence: record.sequence as number,
    status: "applied",
    styleInstalled: record.styleInstalled
  });
}

function errorCode(error: unknown, fallback: string): string {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z0-9_]{1,96}$/u.test(error.code)
  ) {
    return error.code;
  }
  return fallback;
}

function envelope(
  frameToken: string,
  method: ChromiumRoleFontsEnvelope["method"],
  payload: unknown
): ChromiumRoleFontsEnvelope {
  return Object.freeze({ frameToken, method, payload });
}

async function reportFailure(
  ipc: ChromiumRoleFontsIpcRendererPort,
  frameToken: string,
  refreshId: string | null,
  error: unknown
): Promise<void> {
  const payload: ChromiumRoleFontsFailurePayload = Object.freeze({
    code: errorCode(error, "ELECTRON_ROLE_FONT_PRELOAD_FAILED"),
    refreshId,
    status: "failed"
  });
  await ipc.invoke(
    CHROMIUM_ROLE_FONTS_CHANNEL,
    envelope(frameToken, "failure", payload)
  );
}

async function applyPayload(
  ipc: ChromiumRoleFontsIpcRendererPort,
  webFrame: ChromiumRoleFontsWebFramePort,
  refreshId: string | null,
  expected?: ChromiumRoleFontsRefreshControl
): Promise<void> {
  const response = parsePayloadResponse(
    await ipc.invoke(
      CHROMIUM_ROLE_FONTS_CHANNEL,
      envelope(webFrame.frameToken, "payload", Object.freeze({ refreshId }))
    ),
    webFrame.frameToken,
    refreshId,
    expected
  );
  const evidence = parseEvidence(
    await webFrame.executeJavaScript(
      assembleChromiumRoleFontSource(response.payload),
      false
    ),
    response
  );
  const receipt: ChromiumRoleFontsReceiptPayload = Object.freeze({
    applicationId: response.applicationId,
    evidence,
    payloadRevision: response.payloadRevision,
    refreshId,
    status: "applied"
  });
  const acknowledgement = exactRecord(
    await ipc.invoke(
      CHROMIUM_ROLE_FONTS_CHANNEL,
      envelope(webFrame.frameToken, "receipt", receipt)
    ),
    ["applicationId", "status"],
    "ELECTRON_ROLE_FONT_RECEIPT_ACK_INVALID",
    "The Chromium browser-font receipt acknowledgement is malformed."
  );
  if (
    acknowledgement.applicationId !== response.applicationId ||
    acknowledgement.status !== "accepted"
  ) {
    fail(
      "ELECTRON_ROLE_FONT_RECEIPT_ACK_INVALID",
      "The Chromium browser-font receipt acknowledgement is mismatched."
    );
  }
}

export async function installChromiumRoleFonts(
  ipc: ChromiumRoleFontsIpcRendererPort,
  webFrame: ChromiumRoleFontsWebFramePort,
  isMainFrame: boolean
): Promise<boolean> {
  if (!isMainFrame) return false;
  if (!validFrameToken(webFrame.frameToken)) {
    fail(
      "ELECTRON_ROLE_FONT_FRAME_TOKEN_INVALID",
      "The Chromium browser-font runtime requires an exact frame token."
    );
  }

  let applicationTail = Promise.resolve();
  ipc.on(CHROMIUM_ROLE_FONTS_REFRESH_CHANNEL, (_event, rawControl) => {
    let control: ChromiumRoleFontsRefreshControl;
    try {
      control = parseControl(rawControl, webFrame.frameToken);
    } catch {
      return;
    }
    const application = applicationTail.then(() =>
      applyPayload(ipc, webFrame, control.refreshId, control)
    );
    applicationTail = application.catch(async (error: unknown) => {
      await reportFailure(
        ipc,
        webFrame.frameToken,
        control.refreshId,
        error
      ).catch(() => undefined);
    });
  });

  try {
    await applyPayload(ipc, webFrame, null);
  } catch (error) {
    await reportFailure(ipc, webFrame.frameToken, null, error)
      .catch(() => undefined);
    throw error;
  }
  return true;
}
