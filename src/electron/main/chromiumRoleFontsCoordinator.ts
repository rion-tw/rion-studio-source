import { randomUUID } from "node:crypto";

import type { BrowserFontRuntimePayloadRecord } from "../../shared/generated";
import { RionBridgeError } from "../ipc/errors";
import {
  CHROMIUM_ROLE_FONTS_CHANNEL,
  CHROMIUM_ROLE_FONTS_RUNTIME_VERSION,
  type ChromiumRoleFontsApplicationEvidence,
  type ChromiumRoleFontsEnvelope,
  type ChromiumRoleFontsFailurePayload,
  type ChromiumRoleFontsPayloadRequest,
  type ChromiumRoleFontsPayloadResponse,
  type ChromiumRoleFontsReceiptPayload,
  type ChromiumRoleFontsRefreshControl,
  type ChromiumRoleFontsRefreshSubmissionReceipt
} from "../ipc/chromiumRoleFontsProtocol";
import {
  chromiumRoleFontMaximumLoadedFaceCount,
  validateChromiumRoleFontPayload
} from
  "../preload/chromiumRoleFontPayload";
import type {
  ChromiumRoleOverlayFrameIdentity,
  ChromiumRoleOverlayLifecycleEvent
} from "./chromiumRoleSurfaceRegistry";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const MAX_ENVELOPE_BYTES = 16 * 1024;
const RECENT_ID_CAPACITY = 512;

type CoordinatorState = "open" | "disposed";

export interface ChromiumRoleFontsIpcEventPort {
  readonly sender: unknown;
  readonly senderFrame: unknown;
}

export interface ChromiumRoleFontsIpcMainPort {
  handle: (
    channel: string,
    listener: (event: ChromiumRoleFontsIpcEventPort, envelope: unknown) => unknown
  ) => void;
  removeHandler: (channel: string) => void;
}

export interface ChromiumRoleFontsCorePort {
  browserFontRuntimePayload: () => Promise<BrowserFontRuntimePayloadRecord>;
}

export interface ChromiumRoleFontsSurfacePort {
  authorizeOverlayFrame: (
    sender: unknown,
    senderFrame: unknown,
    claimedFrameToken: unknown
  ) => ChromiumRoleOverlayFrameIdentity;
  currentOverlayFrame: (
    roleId: string,
    generation: number
  ) => ChromiumRoleOverlayFrameIdentity;
  currentRolePreloadFrame: (
    roleId: string,
    generation: number
  ) => ChromiumRoleOverlayFrameIdentity;
  listOverlayFrames: () => readonly ChromiumRoleOverlayFrameIdentity[];
  submitRoleFontsRefresh: (
    identity: ChromiumRoleOverlayFrameIdentity,
    control: ChromiumRoleFontsRefreshControl
  ) => Promise<ChromiumRoleFontsRefreshSubmissionReceipt>;
  subscribeOverlayLifecycle: (
    listener: (event: ChromiumRoleOverlayLifecycleEvent) => void
  ) => () => void;
}

export interface ChromiumRoleFontsAppliedReceipt {
  readonly applicationId: string;
  readonly evidence: ChromiumRoleFontsApplicationEvidence;
  readonly frameToken: string;
  readonly generation: number;
  readonly payloadRevision: number;
  readonly refreshId: string | null;
  readonly roleId: string;
  readonly status: "applied";
}

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly reject: (error: unknown) => void;
  readonly resolve: (value: Value) => void;
}

interface InstallWaiter {
  readonly completion: Deferred<void>;
  readonly expected: ChromiumRoleOverlayFrameIdentity;
}

interface FailedInstallation {
  readonly code: string;
  readonly identity: ChromiumRoleOverlayFrameIdentity;
}

interface ApplicationRecord {
  readonly applicationId: string;
  readonly expected: ChromiumRoleOverlayFrameIdentity;
  readonly payload: BrowserFontRuntimePayloadRecord;
  readonly payloadRevision: number;
  readonly refreshId: string | null;
}

interface RefreshWaiter {
  applicationId: string | null;
  readonly completion: Deferred<ChromiumRoleFontsAppliedReceipt>;
  readonly expected: ChromiumRoleOverlayFrameIdentity;
  readonly refreshId: string;
  receipt: ChromiumRoleFontsAppliedReceipt | null;
  submissionAccepted: boolean;
}

function deferred<Value>(): Deferred<Value> {
  let reject!: (error: unknown) => void;
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function fontError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function fail(code: string, message: string): never {
  throw fontError(code, message);
}

function validUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function validRoleId(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value &&
    ![...value].some((character) => character.codePointAt(0)! <= 0x1f);
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

function serializedSize(value: unknown): number {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    fail(
      "ELECTRON_ROLE_FONT_ENVELOPE_INVALID",
      "The Chromium browser-font envelope must be JSON serializable."
    );
  }
  if (serialized === undefined) {
    fail(
      "ELECTRON_ROLE_FONT_ENVELOPE_INVALID",
      "The Chromium browser-font envelope must be an object."
    );
  }
  return new TextEncoder().encode(serialized).byteLength;
}

function parseEnvelope(value: unknown): ChromiumRoleFontsEnvelope {
  if (serializedSize(value) > MAX_ENVELOPE_BYTES) {
    fail(
      "ELECTRON_ROLE_FONT_ENVELOPE_INVALID",
      "The Chromium browser-font envelope exceeds its byte bound."
    );
  }
  const record = exactRecord(
    value,
    ["frameToken", "method", "payload"],
    "ELECTRON_ROLE_FONT_ENVELOPE_INVALID",
    "The Chromium browser-font envelope contains unsupported fields."
  );
  if (
    typeof record.frameToken !== "string" ||
    !new Set(["payload", "receipt", "failure"]).has(String(record.method))
  ) {
    fail(
      "ELECTRON_ROLE_FONT_ENVELOPE_INVALID",
      "The Chromium browser-font envelope identity is invalid."
    );
  }
  return record as unknown as ChromiumRoleFontsEnvelope;
}

function parsePayloadRequest(value: unknown): ChromiumRoleFontsPayloadRequest {
  const record = exactRecord(
    value,
    ["refreshId"],
    "ELECTRON_ROLE_FONT_PAYLOAD_REQUEST_INVALID",
    "The Chromium browser-font payload request is malformed."
  );
  if (record.refreshId !== null && !validUuid(record.refreshId)) {
    fail(
      "ELECTRON_ROLE_FONT_PAYLOAD_REQUEST_INVALID",
      "The Chromium browser-font payload request identity is invalid."
    );
  }
  return Object.freeze({ refreshId: record.refreshId });
}

function parseFailure(value: unknown): ChromiumRoleFontsFailurePayload {
  const record = exactRecord(
    value,
    ["code", "refreshId", "status"],
    "ELECTRON_ROLE_FONT_FAILURE_INVALID",
    "The Chromium browser-font failure receipt is malformed."
  );
  if (
    typeof record.code !== "string" ||
    !/^[A-Z0-9_]{1,96}$/u.test(record.code) ||
    (record.refreshId !== null && !validUuid(record.refreshId)) ||
    record.status !== "failed"
  ) {
    fail(
      "ELECTRON_ROLE_FONT_FAILURE_INVALID",
      "The Chromium browser-font failure receipt is invalid."
    );
  }
  return Object.freeze({
    code: record.code,
    refreshId: record.refreshId,
    status: "failed"
  });
}

function parseEvidence(value: unknown): ChromiumRoleFontsApplicationEvidence {
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
    "ELECTRON_ROLE_FONT_RECEIPT_INVALID",
    "The Chromium browser-font application evidence is malformed."
  );
  const loadedCatalogIds = record.loadedCatalogIds;
  const fontMode = record.fontMode;
  if (
    typeof record.canvasFontsActive !== "boolean" ||
    typeof record.canvasTextQualityActive !== "boolean" ||
    !Number.isSafeInteger(record.failedFaceCount) ||
    (record.failedFaceCount as number) < 0 ||
    (fontMode !== "default" && fontMode !== "custom") ||
    typeof record.fontSmoothingEnabled !== "boolean" ||
    !Array.isArray(loadedCatalogIds) ||
    loadedCatalogIds.some(
      (id) => typeof id !== "string" || !/^[a-z0-9-]{1,64}$/u.test(id)
    ) ||
    new Set(loadedCatalogIds).size !== loadedCatalogIds.length ||
    [...loadedCatalogIds].sort()
      .some((id, index) => id !== loadedCatalogIds[index]) ||
    !Number.isSafeInteger(record.loadedFaceCount) ||
    (record.loadedFaceCount as number) < 0 ||
    record.runtimeVersion !== CHROMIUM_ROLE_FONTS_RUNTIME_VERSION ||
    !Number.isSafeInteger(record.sequence) ||
    (record.sequence as number) < 1 ||
    record.status !== "applied" ||
    typeof record.styleInstalled !== "boolean"
  ) {
    fail(
      "ELECTRON_ROLE_FONT_RECEIPT_INVALID",
      "The Chromium browser-font application evidence is invalid."
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

function parseReceipt(value: unknown): ChromiumRoleFontsReceiptPayload {
  const record = exactRecord(
    value,
    ["applicationId", "evidence", "payloadRevision", "refreshId", "status"],
    "ELECTRON_ROLE_FONT_RECEIPT_INVALID",
    "The Chromium browser-font application receipt is malformed."
  );
  if (
    !validUuid(record.applicationId) ||
    !Number.isSafeInteger(record.payloadRevision) ||
    (record.payloadRevision as number) < 1 ||
    (record.refreshId !== null && !validUuid(record.refreshId)) ||
    record.status !== "applied"
  ) {
    fail(
      "ELECTRON_ROLE_FONT_RECEIPT_INVALID",
      "The Chromium browser-font application receipt is invalid."
    );
  }
  return Object.freeze({
    applicationId: record.applicationId,
    evidence: parseEvidence(record.evidence),
    payloadRevision: record.payloadRevision as number,
    refreshId: record.refreshId,
    status: "applied"
  });
}

function sameFrame(
  left: ChromiumRoleOverlayFrameIdentity,
  right: ChromiumRoleOverlayFrameIdentity
): boolean {
  return left.roleId === right.roleId &&
    left.generation === right.generation &&
    left.frame === right.frame &&
    left.frameToken === right.frameToken;
}

function validateApplicationEvidence(
  payload: BrowserFontRuntimePayloadRecord,
  evidence: ChromiumRoleFontsApplicationEvidence
): void {
  const settings = payload.settings;
  const selectedGoogleCatalogs = new Set(
    Object.values(settings.slots)
      .filter((selection) => selection?.source === "google")
      .map((selection) => selection!.catalogId)
  );
  const catalogsWithFaces = new Set(payload.faces.map((face) => face.catalogId));
  const loadedCatalogs = new Set(evidence.loadedCatalogIds);
  const needsStyle = settings.mode === "custom" || settings.fontSmoothingEnabled;
  if (
    evidence.fontMode !== settings.mode ||
    evidence.fontSmoothingEnabled !== settings.fontSmoothingEnabled ||
    evidence.canvasFontsActive !== (settings.mode === "custom") ||
    evidence.canvasTextQualityActive !== settings.fontSmoothingEnabled ||
    evidence.failedFaceCount !== 0 ||
    evidence.styleInstalled !== needsStyle ||
    evidence.loadedFaceCount > chromiumRoleFontMaximumLoadedFaceCount(payload) ||
    evidence.loadedCatalogIds.some((catalogId) =>
      !selectedGoogleCatalogs.has(catalogId) || !catalogsWithFaces.has(catalogId)
    ) ||
    (settings.mode === "custom" && [...catalogsWithFaces].some(
      (catalogId) => !loadedCatalogs.has(catalogId)
    ))
  ) {
    fail(
      "ELECTRON_ROLE_FONT_APPLICATION_MISMATCH",
      "The main-world browser-font runtime did not apply the exact Core payload."
    );
  }
}

function validRefreshRoleSet(roleIds: readonly string[]): boolean {
  return new Set(roleIds).size === roleIds.length &&
    roleIds.every(validRoleId);
}

export class ChromiumRoleFontsCoordinator {
  readonly #applicationsById = new Map<string, ApplicationRecord>();
  readonly #core: ChromiumRoleFontsCorePort;
  readonly #createApplicationId: () => string;
  readonly #createRefreshId: () => string;
  readonly #failedByRole = new Map<string, FailedInstallation>();
  readonly #installWaitersByRole = new Map<string, InstallWaiter>();
  readonly #readyByRole = new Map<string, ChromiumRoleOverlayFrameIdentity>();
  readonly #refreshById = new Map<string, RefreshWaiter>();
  readonly #refreshTailByRole = new Map<
    string,
    Promise<ChromiumRoleFontsAppliedReceipt>
  >();
  readonly #surfaces: ChromiumRoleFontsSurfacePort;
  readonly #unsubscribeLifecycle: () => void;
  readonly #usedIdOrder: string[] = [];
  readonly #usedIds = new Set<string>();
  #ipcMain: ChromiumRoleFontsIpcMainPort | null = null;
  #payloadRevision = 0;
  #state: CoordinatorState = "open";

  constructor(input: Readonly<{
    core: ChromiumRoleFontsCorePort;
    surfaces: ChromiumRoleFontsSurfacePort;
    createApplicationId?: () => string;
    createRefreshId?: () => string;
  }>) {
    this.#core = input.core;
    this.#surfaces = input.surfaces;
    this.#createApplicationId = input.createApplicationId ?? randomUUID;
    this.#createRefreshId = input.createRefreshId ?? randomUUID;
    this.#unsubscribeLifecycle = this.#surfaces.subscribeOverlayLifecycle(
      this.#onSurfaceLifecycle
    );
  }

  register(ipcMain: ChromiumRoleFontsIpcMainPort): void {
    if (this.#state !== "open" || this.#ipcMain) {
      fail(
        "ELECTRON_ROLE_FONT_REGISTRATION_CONFLICT",
        "The Chromium browser-font IPC handler cannot be registered twice."
      );
    }
    ipcMain.handle(CHROMIUM_ROLE_FONTS_CHANNEL, (event, envelope) =>
      this.receive(event, envelope)
    );
    this.#ipcMain = ipcMain;
  }

  async receive(
    event: ChromiumRoleFontsIpcEventPort,
    rawEnvelope: unknown
  ): Promise<unknown> {
    if (this.#state !== "open") {
      fail(
        "ELECTRON_ROLE_FONT_DISPOSED",
        "The Chromium browser-font coordinator is disposed."
      );
    }
    const envelope = parseEnvelope(rawEnvelope);
    const identity = this.#surfaces.authorizeOverlayFrame(
      event.sender,
      event.senderFrame,
      envelope.frameToken
    );
    if (envelope.method === "payload") {
      return this.#payload(identity, parsePayloadRequest(envelope.payload));
    }
    if (envelope.method === "receipt") {
      return this.#receipt(identity, parseReceipt(envelope.payload));
    }
    return this.#failure(identity, parseFailure(envelope.payload));
  }

  install(
    roleIds: readonly string[],
    generationForRole: (roleId: string) => number
  ): Promise<void> {
    if (this.#state !== "open") {
      return Promise.reject(fontError(
        "ELECTRON_ROLE_FONT_DISPOSED",
        "The Chromium browser-font coordinator is disposed."
      ));
    }
    if (!validRefreshRoleSet(roleIds)) {
      return Promise.reject(fontError(
        "ELECTRON_ROLE_FONT_ROLE_SET_INVALID",
        "Core supplied invalid or duplicate browser-font role identities."
      ));
    }
    try {
      const operations = roleIds.map((roleId) => {
        const expected = this.#surfaces.currentOverlayFrame(
          roleId,
          generationForRole(roleId)
        );
        const ready = this.#readyByRole.get(roleId);
        if (ready && sameFrame(ready, expected)) return Promise.resolve();
        const failed = this.#failedByRole.get(roleId);
        if (failed && sameFrame(failed.identity, expected)) {
          return Promise.reject(fontError(
            failed.code,
            "The Chromium browser-font preload failed before installation completed."
          ));
        }
        const existing = this.#installWaitersByRole.get(roleId);
        if (existing && sameFrame(existing.expected, expected)) {
          return existing.completion.promise;
        }
        existing?.completion.reject(fontError(
          "ELECTRON_ROLE_FONT_DOCUMENT_SUPERSEDED",
          "A newer Chromium document superseded browser-font installation."
        ));
        const completion = deferred<void>();
        this.#installWaitersByRole.set(roleId, { completion, expected });
        return completion.promise;
      });
      return Promise.all(operations).then(() => undefined);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  refresh(
    roleIds: readonly string[]
  ): Promise<readonly ChromiumRoleFontsAppliedReceipt[]> {
    if (this.#state !== "open") {
      return Promise.reject(fontError(
        "ELECTRON_ROLE_FONT_DISPOSED",
        "The Chromium browser-font coordinator is disposed."
      ));
    }
    if (!validRefreshRoleSet(roleIds)) {
      return Promise.reject(fontError(
        "ELECTRON_ROLE_FONT_ROLE_SET_INVALID",
        "The browser-font refresh role set is invalid."
      ));
    }
    let selected: string[];
    try {
      selected = roleIds.length > 0
        ? [...roleIds]
        : this.#surfaces.listOverlayFrames()
          .map((identity) => identity.roleId);
    } catch (error) {
      return Promise.reject(error);
    }
    return Promise.all(selected.map((roleId) => this.#enqueueRefresh(roleId)))
      .then((receipts) => Object.freeze(receipts));
  }

  retire(roleId: string, generation: number): void {
    this.#retireExact(roleId, generation, "surface-retired");
  }

  dispose(): void {
    if (this.#state === "disposed") return;
    this.#state = "disposed";
    this.#ipcMain?.removeHandler(CHROMIUM_ROLE_FONTS_CHANNEL);
    this.#ipcMain = null;
    this.#unsubscribeLifecycle();
    for (const waiter of this.#installWaitersByRole.values()) {
      waiter.completion.reject(fontError(
        "ELECTRON_ROLE_FONT_DISPOSED",
        "The browser-font coordinator stopped before installation completed."
      ));
    }
    for (const waiter of this.#refreshById.values()) {
      waiter.completion.reject(fontError(
        "ELECTRON_ROLE_FONT_DISPOSED",
        "The browser-font coordinator stopped before refresh completed."
      ));
    }
    this.#installWaitersByRole.clear();
    this.#refreshById.clear();
    this.#refreshTailByRole.clear();
    this.#applicationsById.clear();
    this.#failedByRole.clear();
    this.#readyByRole.clear();
    this.#usedIdOrder.length = 0;
    this.#usedIds.clear();
  }

  async #payload(
    identity: ChromiumRoleOverlayFrameIdentity,
    request: ChromiumRoleFontsPayloadRequest
  ): Promise<ChromiumRoleFontsPayloadResponse> {
    let refresh: RefreshWaiter | null = null;
    if (request.refreshId !== null) {
      refresh = this.#refreshById.get(request.refreshId) ?? null;
      if (!refresh || !sameFrame(refresh.expected, identity) || refresh.applicationId) {
        fail(
          "ELECTRON_ROLE_FONT_PAYLOAD_REQUEST_UNAUTHORIZED",
          "The browser-font payload request does not own an active refresh."
        );
      }
    } else if ([...this.#applicationsById.values()].some(
      (application) =>
        application.refreshId === null && sameFrame(application.expected, identity)
    )) {
      fail(
        "ELECTRON_ROLE_FONT_APPLICATION_CONFLICT",
        "The live Chromium document already has a pending browser-font application."
      );
    }

    const payload = validateChromiumRoleFontPayload(
      await this.#core.browserFontRuntimePayload()
    );
    const current = this.#surfaces.currentRolePreloadFrame(
      identity.roleId,
      identity.generation
    );
    if (!sameFrame(current, identity)) {
      fail(
        "ELECTRON_ROLE_FONT_DOCUMENT_SUPERSEDED",
        "Navigation superseded the browser-font payload request."
      );
    }
    const applicationId = this.#uniqueId(this.#createApplicationId);
    if (this.#payloadRevision >= Number.MAX_SAFE_INTEGER) {
      fail(
        "ELECTRON_ROLE_FONT_REVISION_EXHAUSTED",
        "The browser-font payload revision space is exhausted."
      );
    }
    const payloadRevision = ++this.#payloadRevision;
    const application: ApplicationRecord = Object.freeze({
      applicationId,
      expected: identity,
      payload,
      payloadRevision,
      refreshId: request.refreshId
    });
    this.#applicationsById.set(applicationId, application);
    if (refresh) refresh.applicationId = applicationId;
    return Object.freeze({
      applicationId,
      frameToken: identity.frameToken,
      generation: identity.generation,
      payload,
      payloadRevision,
      refreshId: request.refreshId,
      roleId: identity.roleId
    });
  }

  #receipt(
    identity: ChromiumRoleOverlayFrameIdentity,
    receipt: ChromiumRoleFontsReceiptPayload
  ): Readonly<{ applicationId: string; status: "accepted" }> {
    const application = this.#applicationsById.get(receipt.applicationId);
    if (
      !application ||
      !sameFrame(application.expected, identity) ||
      application.payloadRevision !== receipt.payloadRevision ||
      application.refreshId !== receipt.refreshId
    ) {
      fail(
        "ELECTRON_ROLE_FONT_RECEIPT_UNAUTHORIZED",
        "The browser-font receipt does not own an active application."
      );
    }
    const current = this.#surfaces.currentRolePreloadFrame(
      identity.roleId,
      identity.generation
    );
    if (!sameFrame(current, identity)) {
      fail(
        "ELECTRON_ROLE_FONT_DOCUMENT_SUPERSEDED",
        "Navigation superseded the browser-font application receipt."
      );
    }
    validateApplicationEvidence(application.payload, receipt.evidence);
    this.#applicationsById.delete(receipt.applicationId);
    const applied = Object.freeze({
      applicationId: receipt.applicationId,
      evidence: receipt.evidence,
      frameToken: identity.frameToken,
      generation: identity.generation,
      payloadRevision: receipt.payloadRevision,
      refreshId: receipt.refreshId,
      roleId: identity.roleId,
      status: "applied" as const
    });
    if (receipt.refreshId === null) {
      this.#markReady(identity);
    } else {
      const refresh = this.#refreshById.get(receipt.refreshId);
      if (
        !refresh ||
        refresh.applicationId !== receipt.applicationId ||
        !sameFrame(refresh.expected, identity)
      ) {
        fail(
          "ELECTRON_ROLE_FONT_RECEIPT_UNAUTHORIZED",
          "The browser-font receipt no longer owns its exact refresh."
        );
      }
      refresh.receipt = applied;
      if (refresh.submissionAccepted) this.#resolveRefresh(refresh, applied);
    }
    return Object.freeze({
      applicationId: receipt.applicationId,
      status: "accepted"
    });
  }

  #failure(
    identity: ChromiumRoleOverlayFrameIdentity,
    failure: ChromiumRoleFontsFailurePayload
  ): Readonly<{ status: "accepted" }> {
    if (failure.refreshId === null) {
      this.#rejectApplications(identity, null);
      this.#failedByRole.set(identity.roleId, Object.freeze({
        code: failure.code,
        identity: Object.freeze({ ...identity })
      }));
      const waiter = this.#installWaitersByRole.get(identity.roleId);
      if (waiter && sameFrame(waiter.expected, identity)) {
        this.#installWaitersByRole.delete(identity.roleId);
        waiter.completion.reject(fontError(
          failure.code,
          "The Chromium browser-font preload reported an installation failure."
        ));
      }
      return Object.freeze({ status: "accepted" });
    }
    const refresh = this.#refreshById.get(failure.refreshId);
    if (!refresh || !sameFrame(refresh.expected, identity)) {
      fail(
        "ELECTRON_ROLE_FONT_FAILURE_UNAUTHORIZED",
        "The browser-font failure does not own an active refresh."
      );
    }
    this.#rejectApplications(identity, failure.refreshId);
    this.#rejectRefresh(
      refresh,
      failure.code,
      "The Chromium browser-font preload reported a refresh failure."
    );
    return Object.freeze({ status: "accepted" });
  }

  #enqueueRefresh(roleId: string): Promise<ChromiumRoleFontsAppliedReceipt> {
    const previous = this.#refreshTailByRole.get(roleId);
    const operation = (previous ? previous.catch(() => undefined) : Promise.resolve())
      .then(() => this.#beginRefresh(roleId));
    this.#refreshTailByRole.set(roleId, operation);
    const cleanup = (): void => {
      if (this.#refreshTailByRole.get(roleId) === operation) {
        this.#refreshTailByRole.delete(roleId);
      }
    };
    void operation.then(cleanup, cleanup);
    return operation;
  }

  #beginRefresh(roleId: string): Promise<ChromiumRoleFontsAppliedReceipt> {
    const ready = this.#readyByRole.get(roleId);
    if (!ready) {
      let expected: ChromiumRoleOverlayFrameIdentity | undefined;
      try {
        expected = this.#surfaces.listOverlayFrames()
          .find((identity) => identity.roleId === roleId);
      } catch (error) {
        return Promise.reject(error);
      }
      if (!expected) {
        return Promise.reject(fontError(
          "ELECTRON_ROLE_FONT_NOT_READY",
          "The Chromium role has no live document for browser-font refresh."
        ));
      }
      const failed = this.#failedByRole.get(roleId);
      if (failed && sameFrame(failed.identity, expected)) {
        return Promise.reject(fontError(
          failed.code,
          "The Chromium browser-font preload failed before refresh."
        ));
      }
      let install = this.#installWaitersByRole.get(roleId);
      if (install && !sameFrame(install.expected, expected)) {
        this.#installWaitersByRole.delete(roleId);
        install.completion.reject(fontError(
          "ELECTRON_ROLE_FONT_DOCUMENT_SUPERSEDED",
          "A newer Chromium document superseded browser-font installation."
        ));
        install = undefined;
      }
      if (!install) {
        install = { completion: deferred<void>(), expected };
        this.#installWaitersByRole.set(roleId, install);
      }
      return install.completion.promise.then(() => this.#beginRefresh(roleId));
    }
    let expected: ChromiumRoleOverlayFrameIdentity;
    try {
      expected = this.#surfaces.currentOverlayFrame(roleId, ready.generation);
    } catch (error) {
      return Promise.reject(error);
    }
    if (!sameFrame(ready, expected)) {
      this.#readyByRole.delete(roleId);
      return Promise.reject(fontError(
        "ELECTRON_ROLE_FONT_DOCUMENT_SUPERSEDED",
        "The ready browser-font runtime no longer owns the live document."
      ));
    }
    let refreshId: string;
    try {
      refreshId = this.#uniqueId(this.#createRefreshId);
    } catch (error) {
      return Promise.reject(error);
    }
    const completion = deferred<ChromiumRoleFontsAppliedReceipt>();
    const waiter: RefreshWaiter = {
      applicationId: null,
      completion,
      expected,
      receipt: null,
      refreshId,
      submissionAccepted: false
    };
    this.#refreshById.set(refreshId, waiter);
    const control: ChromiumRoleFontsRefreshControl = Object.freeze({
      frameToken: expected.frameToken,
      generation: expected.generation,
      refreshId,
      roleId: expected.roleId
    });
    let submission: Promise<ChromiumRoleFontsRefreshSubmissionReceipt>;
    try {
      submission = this.#surfaces.submitRoleFontsRefresh(expected, control);
    } catch {
      this.#rejectRefresh(
        waiter,
        "ELECTRON_ROLE_FONT_REFRESH_SUBMISSION_FAILED",
        "Chromium rejected browser-font refresh submission."
      );
      return completion.promise;
    }
    void Promise.resolve(submission).then(
      (receipt) => this.#acceptSubmission(waiter, receipt),
      () => this.#rejectRefresh(
        waiter,
        "ELECTRON_ROLE_FONT_REFRESH_SUBMISSION_FAILED",
        "Chromium rejected browser-font refresh submission."
      )
    );
    return completion.promise;
  }

  #acceptSubmission(
    waiter: RefreshWaiter,
    receipt: ChromiumRoleFontsRefreshSubmissionReceipt
  ): void {
    if (this.#refreshById.get(waiter.refreshId) !== waiter) return;
    if (
      receipt.frameToken !== waiter.expected.frameToken ||
      receipt.generation !== waiter.expected.generation ||
      receipt.refreshId !== waiter.refreshId ||
      receipt.roleId !== waiter.expected.roleId ||
      receipt.status !== "submitted"
    ) {
      this.#rejectRefresh(
        waiter,
        "ELECTRON_ROLE_FONT_REFRESH_SUBMISSION_FAILED",
        "Chromium returned a mismatched browser-font refresh submission receipt."
      );
      return;
    }
    let current: ChromiumRoleOverlayFrameIdentity;
    try {
      current = this.#surfaces.currentOverlayFrame(
        waiter.expected.roleId,
        waiter.expected.generation
      );
    } catch {
      this.#rejectRefresh(
        waiter,
        "ELECTRON_ROLE_FONT_DOCUMENT_SUPERSEDED",
        "Navigation superseded browser-font refresh submission."
      );
      return;
    }
    if (!sameFrame(current, waiter.expected)) {
      this.#rejectRefresh(
        waiter,
        "ELECTRON_ROLE_FONT_DOCUMENT_SUPERSEDED",
        "Navigation superseded browser-font refresh submission."
      );
      return;
    }
    waiter.submissionAccepted = true;
    if (waiter.receipt) this.#resolveRefresh(waiter, waiter.receipt);
  }

  #resolveRefresh(
    waiter: RefreshWaiter,
    receipt: ChromiumRoleFontsAppliedReceipt
  ): void {
    if (this.#refreshById.get(waiter.refreshId) !== waiter) return;
    this.#refreshById.delete(waiter.refreshId);
    waiter.completion.resolve(receipt);
  }

  #rejectRefresh(waiter: RefreshWaiter, code: string, message: string): void {
    if (this.#refreshById.get(waiter.refreshId) !== waiter) return;
    this.#refreshById.delete(waiter.refreshId);
    waiter.completion.reject(fontError(code, message));
  }

  #markReady(identity: ChromiumRoleOverlayFrameIdentity): void {
    this.#failedByRole.delete(identity.roleId);
    this.#readyByRole.set(identity.roleId, Object.freeze({ ...identity }));
    const waiter = this.#installWaitersByRole.get(identity.roleId);
    if (!waiter) return;
    if (!sameFrame(waiter.expected, identity)) {
      this.#installWaitersByRole.delete(identity.roleId);
      waiter.completion.reject(fontError(
        "ELECTRON_ROLE_FONT_DOCUMENT_SUPERSEDED",
        "A newer Chromium document superseded browser-font installation."
      ));
      return;
    }
    this.#installWaitersByRole.delete(identity.roleId);
    waiter.completion.resolve();
  }

  #uniqueId(create: () => string): string {
    let id: string;
    try {
      id = create();
    } catch {
      fail(
        "ELECTRON_ROLE_FONT_ID_INVALID",
        "Chromium could not create a browser-font operation identity."
      );
    }
    if (!validUuid(id) || this.#usedIds.has(id)) {
      fail(
        "ELECTRON_ROLE_FONT_ID_INVALID",
        "Chromium could not create a unique browser-font operation identity."
      );
    }
    this.#usedIds.add(id);
    this.#usedIdOrder.push(id);
    this.#evictTerminalIds();
    return id;
  }

  #evictTerminalIds(): void {
    let inspected = 0;
    while (
      this.#usedIds.size > RECENT_ID_CAPACITY &&
      inspected < this.#usedIdOrder.length
    ) {
      const oldest = this.#usedIdOrder.shift();
      if (!oldest) return;
      const active = this.#applicationsById.has(oldest) ||
        this.#refreshById.has(oldest) ||
        [...this.#refreshById.values()].some(
          (refresh) => refresh.applicationId === oldest
        );
      if (active) {
        this.#usedIdOrder.push(oldest);
        inspected += 1;
      } else {
        this.#usedIds.delete(oldest);
        inspected = 0;
      }
    }
  }

  #rejectApplications(
    identity: ChromiumRoleOverlayFrameIdentity,
    refreshId: string | null
  ): void {
    for (const [applicationId, application] of this.#applicationsById) {
      if (
        application.refreshId === refreshId &&
        sameFrame(application.expected, identity)
      ) {
        this.#applicationsById.delete(applicationId);
      }
    }
  }

  #retireExact(
    roleId: string,
    generation: number,
    reason: ChromiumRoleOverlayLifecycleEvent["reason"]
  ): void {
    const code = reason === "document-superseded"
      ? "ELECTRON_ROLE_FONT_DOCUMENT_SUPERSEDED"
      : "ELECTRON_ROLE_FONT_SURFACE_RETIRED";
    const ready = this.#readyByRole.get(roleId);
    if (ready?.generation === generation) this.#readyByRole.delete(roleId);
    const failed = this.#failedByRole.get(roleId);
    if (failed?.identity.generation === generation) this.#failedByRole.delete(roleId);
    const install = this.#installWaitersByRole.get(roleId);
    if (install?.expected.generation === generation) {
      this.#installWaitersByRole.delete(roleId);
      install.completion.reject(fontError(
        code,
        reason === "document-superseded"
          ? "Navigation superseded browser-font installation."
          : "The role surface retired before browser-font installation completed."
      ));
    }
    for (const [applicationId, application] of this.#applicationsById) {
      if (
        application.expected.roleId === roleId &&
        application.expected.generation === generation
      ) {
        this.#applicationsById.delete(applicationId);
      }
    }
    for (const refresh of [...this.#refreshById.values()]) {
      if (
        refresh.expected.roleId === roleId &&
        refresh.expected.generation === generation
      ) {
        this.#rejectRefresh(
          refresh,
          code,
          reason === "document-superseded"
            ? "Navigation superseded browser-font refresh."
            : "The role surface retired before browser-font refresh completed."
        );
      }
    }
  }

  readonly #onSurfaceLifecycle = (
    event: ChromiumRoleOverlayLifecycleEvent
  ): void => {
    this.#retireExact(event.roleId, event.generation, event.reason);
  };
}
