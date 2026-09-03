import { randomUUID } from "node:crypto";

import type {
  MacroCoordinateContextRecord,
  MacroOverlayViewModelRecord
} from "../../shared/generated";
import { RionBridgeError } from "../ipc/errors";
import {
  CHROMIUM_ROLE_OVERLAY_CHANNEL,
  CHROMIUM_ROLE_OVERLAY_METHODS,
  CHROMIUM_ROLE_OVERLAY_WORLD_ID,
  type ChromiumRoleOverlayEnvelope,
  type ChromiumRoleOverlayMethod
} from "../ipc/chromiumRoleOverlayProtocol";
import type {
  ChromiumRoleOverlayFrameIdentity,
  ChromiumRoleOverlayLifecycleEvent,
  ChromiumRoleOverlayRefreshSubmissionReceipt
} from "./chromiumRoleSurfaceRegistry";

const MAX_OVERLAY_ENVELOPE_BYTES = 64 * 1024;
const OVERLAY_METHOD_SET = new Set<string>(CHROMIUM_ROLE_OVERLAY_METHODS);

type CoordinatorState = "open" | "disposed";

export interface ChromiumRoleOverlayIpcEventPort {
  readonly sender: unknown;
  readonly senderFrame: unknown;
}

export interface ChromiumRoleOverlayIpcMainPort {
  handle: (
    channel: string,
    listener: (event: ChromiumRoleOverlayIpcEventPort, envelope: unknown) => unknown
  ) => void;
  removeHandler: (channel: string) => void;
}

export interface ChromiumRoleOverlayCorePort {
  overlayRequest: (input: Readonly<{
    roleId: string;
    requestJson: string;
  }>) => Promise<MacroOverlayViewModelRecord>;
}

export interface ChromiumRoleOverlaySurfacePort {
  authorizeOverlayFrame: (
    sender: unknown,
    senderFrame: unknown,
    claimedFrameToken: unknown
  ) => ChromiumRoleOverlayFrameIdentity;
  isSupersededOverlayFrame?: (
    sender: unknown,
    senderFrame: unknown,
    claimedFrameToken: unknown
  ) => boolean;
  currentOverlayFrame: (
    roleId: string,
    generation: number
  ) => ChromiumRoleOverlayFrameIdentity;
  executeOverlayRefresh: (
    identity: ChromiumRoleOverlayFrameIdentity,
    refreshId: string
  ) => Promise<ChromiumRoleOverlayRefreshSubmissionReceipt>;
  listOverlayFrames: () => readonly ChromiumRoleOverlayFrameIdentity[];
  subscribeOverlayLifecycle: (
    listener: (event: ChromiumRoleOverlayLifecycleEvent) => void
  ) => () => void;
}

export interface ChromiumRoleOverlayRefreshReceipt {
  readonly roleId: string;
  readonly generation: number;
  readonly frameToken: string;
  readonly documentInstanceId: string;
  readonly inputContext: Readonly<{
    readonly documentInstanceId: string;
    readonly revision: number;
    readonly target: "document" | "embedded-frame" | "game";
  }>;
  readonly refreshId: string;
  readonly requestVersion: number;
  readonly status: "applied";
  readonly worldId: 1004;
}

export interface ChromiumRoleOverlayRuntimePort {
  activate?: (identity: ChromiumRoleOverlayFrameIdentity) => void | Promise<void>;
  coordinateContext: (
    identity: ChromiumRoleOverlayFrameIdentity
  ) => MacroCoordinateContextRecord;
  observeGameInputContext?: (
    identity: ChromiumRoleOverlayFrameIdentity,
    payload: unknown
  ) => unknown | Promise<unknown>;
  macroKeyObserved?: (
    identity: ChromiumRoleOverlayFrameIdentity,
    payload: unknown
  ) => unknown;
  managedShortcutKeyPhase?: (
    identity: ChromiumRoleOverlayFrameIdentity,
    payload: unknown
  ) => unknown;
  inputContextLost?: (
    identity: ChromiumRoleOverlayFrameIdentity,
    payload: unknown
  ) => unknown;
  macroBadgeTiming?: (
    identity: ChromiumRoleOverlayFrameIdentity,
    payload: unknown
  ) => unknown;
}

type OverlayReadyRecord = ChromiumRoleOverlayFrameIdentity;

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
  readonly reject: (error: unknown) => void;
}

interface OverlayReadyWaiter {
  readonly expected: ChromiumRoleOverlayFrameIdentity;
  readonly completion: Deferred<void>;
}

interface OverlayRefreshWaiter {
  readonly expected: ChromiumRoleOverlayFrameIdentity;
  readonly refreshId: string;
  readonly completion: Deferred<ChromiumRoleOverlayRefreshReceipt>;
  submissionAccepted: boolean;
  receipt: ChromiumRoleOverlayRefreshReceipt | null;
}

type RefreshReceiptPayload =
  | Readonly<{ refreshId: string; status: "failed" }>
  | Readonly<{
    refreshId: string;
    inputContext: Readonly<{
      documentInstanceId: string;
      revision: number;
      target: "document" | "embedded-frame" | "game";
    }>;
    requestVersion: number;
    status: "applied";
  }>;

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function overlayError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function fail(code: string, message: string): never {
  throw overlayError(code, message);
}

function serializedSize(value: unknown): number {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    fail(
      "ELECTRON_ROLE_OVERLAY_ENVELOPE_INVALID",
      "The Chromium overlay request must be JSON serializable."
    );
  }
  if (serialized === undefined) {
    fail(
      "ELECTRON_ROLE_OVERLAY_ENVELOPE_INVALID",
      "The Chromium overlay request must be a JSON object."
    );
  }
  return new TextEncoder().encode(serialized).byteLength;
}

function parseEnvelope(value: unknown): ChromiumRoleOverlayEnvelope {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    serializedSize(value) > MAX_OVERLAY_ENVELOPE_BYTES
  ) {
    fail(
      "ELECTRON_ROLE_OVERLAY_ENVELOPE_INVALID",
      "The Chromium overlay request envelope is invalid or too large."
    );
  }
  const record = value as Record<string, unknown>;
  const method = record.method;
  const hasPayload = Object.hasOwn(record, "payload");
  const expectedKeys = hasPayload
    ? ["frameToken", "method", "payload"]
    : ["frameToken", "method"];
  const keys = Object.keys(record).sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index]) ||
    typeof record.frameToken !== "string" ||
    !OVERLAY_METHOD_SET.has(String(method)) ||
    (method === "ready") === hasPayload
  ) {
    fail(
      "ELECTRON_ROLE_OVERLAY_ENVELOPE_INVALID",
      "The Chromium overlay request envelope contains unsupported fields."
    );
  }
  return record as unknown as ChromiumRoleOverlayEnvelope;
}

function requestType(payload: unknown): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    fail(
      "ELECTRON_ROLE_OVERLAY_REQUEST_INVALID",
      "The Chromium overlay request payload must be an object."
    );
  }
  const type = (payload as Record<string, unknown>).type;
  if (
    typeof type !== "string" ||
    type.length === 0 ||
    type.length > 64 ||
    type !== type.trim()
  ) {
    fail(
      "ELECTRON_ROLE_OVERLAY_REQUEST_INVALID",
      "The Chromium overlay request type is invalid."
    );
  }
  return type;
}

function parseRefreshReceipt(payload: unknown): RefreshReceiptPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    fail(
      "ELECTRON_ROLE_OVERLAY_REFRESH_RECEIPT_INVALID",
      "The Chromium overlay refresh receipt must be an exact object."
    );
  }
  const record = payload as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const applied = record.status === "applied";
  const expectedKeys = applied
    ? ["inputContext", "refreshId", "requestVersion", "status"]
    : ["refreshId", "status"];
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index]) ||
    typeof record.refreshId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
      .test(record.refreshId) ||
    (applied
      ? !Number.isSafeInteger(record.requestVersion) ||
        (record.requestVersion as number) < 1 ||
        !record.inputContext || typeof record.inputContext !== "object" ||
        Array.isArray(record.inputContext) ||
        !exactInputContext(record.inputContext as Record<string, unknown>)
      : record.status !== "failed")
  ) {
    fail(
      "ELECTRON_ROLE_OVERLAY_REFRESH_RECEIPT_INVALID",
      "The Chromium overlay refresh receipt is malformed."
    );
  }
  return Object.freeze({ ...record }) as RefreshReceiptPayload;
}

function exactInputContext(record: Record<string, unknown>): boolean {
  const keys = Object.keys(record).sort();
  return keys.length === 3 && keys[0] === "documentInstanceId" &&
    keys[1] === "revision" && keys[2] === "target" &&
    typeof record.documentInstanceId === "string" &&
    record.documentInstanceId.length > 0 &&
    record.documentInstanceId.length <= 128 &&
    record.documentInstanceId === record.documentInstanceId.trim() &&
    Number.isSafeInteger(record.revision) && (record.revision as number) >= 1 &&
    (record.target === "document" || record.target === "embedded-frame" ||
      record.target === "game");
}

function validRefreshRoleId(roleId: string): boolean {
  return typeof roleId === "string" &&
    roleId.length > 0 &&
    roleId === roleId.trim() &&
    ![...roleId].some((character) => character.codePointAt(0)! <= 0x1f);
}

function validRefreshId(refreshId: unknown): refreshId is string {
  return typeof refreshId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
      .test(refreshId);
}

function sameFrame(
  left: ChromiumRoleOverlayFrameIdentity,
  right: ChromiumRoleOverlayFrameIdentity
): boolean {
  return left.roleId === right.roleId &&
    left.generation === right.generation &&
    left.frame === right.frame &&
    left.frameToken === right.frameToken &&
    left.documentInstanceId === right.documentInstanceId;
}

function unsupported(method: ChromiumRoleOverlayMethod): never {
  fail(
    "ELECTRON_ROLE_OVERLAY_NATIVE_METHOD_UNAVAILABLE",
    `The Chromium runtime has not enabled overlay method ${method}.`
  );
}

export class ChromiumRoleOverlayCoordinator {
  readonly #core: ChromiumRoleOverlayCorePort;
  readonly #surfaces: ChromiumRoleOverlaySurfacePort;
  readonly #runtime: ChromiumRoleOverlayRuntimePort;
  readonly #readyByRole = new Map<string, OverlayReadyRecord>();
  readonly #waitersByRole = new Map<string, OverlayReadyWaiter>();
  readonly #refreshById = new Map<string, OverlayRefreshWaiter>();
  readonly #usedRefreshIds = new Set<string>();
  readonly #refreshTailByRole = new Map<
    string,
    Promise<ChromiumRoleOverlayRefreshReceipt>
  >();
  readonly #createRefreshId: () => string;
  readonly #unsubscribeSurfaceLifecycle: () => void;
  #ipcMain: ChromiumRoleOverlayIpcMainPort | null = null;
  #state: CoordinatorState = "open";

  constructor(input: Readonly<{
    core: ChromiumRoleOverlayCorePort;
    surfaces: ChromiumRoleOverlaySurfacePort;
    runtime: ChromiumRoleOverlayRuntimePort;
    createRefreshId?: () => string;
  }>) {
    this.#core = input.core;
    this.#surfaces = input.surfaces;
    this.#runtime = input.runtime;
    this.#createRefreshId = input.createRefreshId ?? randomUUID;
    this.#unsubscribeSurfaceLifecycle = this.#surfaces.subscribeOverlayLifecycle(
      this.#onSurfaceLifecycle
    );
  }

  register(ipcMain: ChromiumRoleOverlayIpcMainPort): void {
    if (this.#state !== "open" || this.#ipcMain) {
      fail(
        "ELECTRON_ROLE_OVERLAY_REGISTRATION_CONFLICT",
        "The Chromium role-overlay IPC handler cannot be registered twice."
      );
    }
    ipcMain.handle(CHROMIUM_ROLE_OVERLAY_CHANNEL, (event, envelope) =>
      this.receive(event, envelope)
    );
    this.#ipcMain = ipcMain;
  }

  async receive(
    event: ChromiumRoleOverlayIpcEventPort,
    rawEnvelope: unknown
  ): Promise<unknown> {
    if (this.#state !== "open") {
      fail(
        "ELECTRON_ROLE_OVERLAY_DISPOSED",
        "The Chromium role-overlay coordinator is disposed."
      );
    }
    const envelope = parseEnvelope(rawEnvelope);
    let identity: ChromiumRoleOverlayFrameIdentity;
    try {
      identity = this.#surfaces.authorizeOverlayFrame(
        event.sender,
        event.senderFrame,
        envelope.frameToken
      );
    } catch (error) {
      const payload = envelope.method === "request" &&
        envelope.payload && typeof envelope.payload === "object"
        ? envelope.payload as Record<string, unknown>
        : null;
      if (error instanceof RionBridgeError &&
        error.code === "ELECTRON_ROLE_OVERLAY_FRAME_UNAUTHORIZED" &&
        this.#surfaces.isSupersededOverlayFrame?.(
          event.sender,
          event.senderFrame,
          envelope.frameToken
        )) {
        return Object.freeze({
          ...(payload?.type === "game-input-context"
            ? { documentInstanceId: payload.documentInstanceId }
            : {}),
          status: "superseded" as const
        });
      }
      throw error;
    }
    if (envelope.method === "ready") {
      this.#markReady(identity);
      return Object.freeze({
        frameToken: identity.frameToken,
        generation: identity.generation,
        status: "ready" as const
      });
    }
    if (envelope.method === "request") {
      return this.#handleRequest(identity, envelope.payload);
    }
    if (envelope.method === "refreshReceipt") {
      return this.#acceptRefreshReceipt(
        identity,
        parseRefreshReceipt(envelope.payload)
      );
    }
    const handler = this.#runtime[envelope.method];
    if (typeof handler !== "function") unsupported(envelope.method);
    return handler.call(this.#runtime, identity, envelope.payload);
  }

  install(roleIds: readonly string[], generationForRole: (roleId: string) => number): Promise<void> {
    if (this.#state !== "open") {
      return Promise.reject(overlayError(
        "ELECTRON_ROLE_OVERLAY_DISPOSED",
        "The Chromium role-overlay coordinator is disposed."
      ));
    }
    if (new Set(roleIds).size !== roleIds.length) {
      return Promise.reject(overlayError(
        "ELECTRON_ROLE_OVERLAY_ROLE_SET_INVALID",
        "Core supplied duplicate overlay role identities."
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
        const existing = this.#waitersByRole.get(roleId);
        if (existing && sameFrame(existing.expected, expected)) {
          return existing.completion.promise;
        }
        if (existing) {
          existing.completion.reject(overlayError(
            "ELECTRON_ROLE_OVERLAY_DOCUMENT_SUPERSEDED",
            "A newer Chromium role document superseded overlay installation."
          ));
        }
        const completion = deferred<void>();
        this.#waitersByRole.set(roleId, { expected, completion });
        return completion.promise;
      });
      return Promise.all(operations).then(() => undefined);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  refresh(
    roleIds: readonly string[]
  ): Promise<readonly ChromiumRoleOverlayRefreshReceipt[]> {
    if (this.#state !== "open") {
      return Promise.reject(overlayError(
        "ELECTRON_ROLE_OVERLAY_DISPOSED",
        "The Chromium role-overlay coordinator is disposed."
      ));
    }
    if (
      new Set(roleIds).size !== roleIds.length ||
      roleIds.some((roleId) => !validRefreshRoleId(roleId))
    ) {
      return Promise.reject(overlayError(
        "ELECTRON_ROLE_OVERLAY_ROLE_SET_INVALID",
        "Core supplied invalid or duplicate overlay refresh roles."
      ));
    }
    let selectedRoleIds: string[];
    let liveFrames: readonly ChromiumRoleOverlayFrameIdentity[];
    try {
      liveFrames = this.#surfaces.listOverlayFrames();
      selectedRoleIds = roleIds.length > 0
        ? roleIds.filter((roleId) =>
            liveFrames.some((identity) => identity.roleId === roleId))
        : liveFrames
          .filter((identity) => {
            const ready = this.#readyByRole.get(identity.roleId);
            return ready !== undefined && sameFrame(ready, identity);
          })
          .map((identity) => identity.roleId);
    } catch (error) {
      return Promise.reject(error);
    }
    return Promise.all(selectedRoleIds.map(async (roleId) => {
      if (roleIds.length > 0) {
        const matchingFrames = liveFrames.filter((identity) =>
          identity.roleId === roleId);
        if (matchingFrames.length !== 1) {
          throw overlayError(
            "ELECTRON_ROLE_OVERLAY_ROLE_SET_INVALID",
            "The Chromium overlay refresh role has ambiguous live surfaces."
          );
        }
        const ready = this.#readyByRole.get(roleId);
        if (!ready || !sameFrame(ready, matchingFrames[0]!)) {
          await this.install([roleId], () => matchingFrames[0]!.generation);
        }
      }
      return this.#enqueueRefresh(roleId);
    })).then((receipts) => Object.freeze(receipts));
  }

  retire(roleId: string, generation: number): void {
    const ready = this.#readyByRole.get(roleId);
    if (ready?.generation === generation) this.#readyByRole.delete(roleId);
    const waiter = this.#waitersByRole.get(roleId);
    if (waiter?.expected.generation === generation) {
      this.#waitersByRole.delete(roleId);
      waiter.completion.reject(overlayError(
        "ELECTRON_ROLE_OVERLAY_SURFACE_RETIRED",
        "The Chromium role surface retired before its overlay became ready."
      ));
    }
    this.#rejectRoleRefreshes(
      roleId,
      generation,
      "ELECTRON_ROLE_OVERLAY_SURFACE_RETIRED",
      "The Chromium role surface retired before overlay refresh completed."
    );
  }

  dispose(): void {
    if (this.#state === "disposed") return;
    this.#state = "disposed";
    this.#ipcMain?.removeHandler(CHROMIUM_ROLE_OVERLAY_CHANNEL);
    this.#ipcMain = null;
    this.#unsubscribeSurfaceLifecycle();
    for (const waiter of this.#waitersByRole.values()) {
      waiter.completion.reject(overlayError(
        "ELECTRON_ROLE_OVERLAY_DISPOSED",
        "The Chromium role-overlay coordinator stopped before readiness."
      ));
    }
    this.#waitersByRole.clear();
    this.#readyByRole.clear();
    for (const waiter of this.#refreshById.values()) {
      waiter.completion.reject(overlayError(
        "ELECTRON_ROLE_OVERLAY_DISPOSED",
        "The Chromium overlay coordinator stopped before refresh completed."
      ));
    }
    this.#refreshById.clear();
    this.#usedRefreshIds.clear();
    this.#refreshTailByRole.clear();
  }

  #enqueueRefresh(
    roleId: string
  ): Promise<ChromiumRoleOverlayRefreshReceipt> {
    const previous = this.#refreshTailByRole.get(roleId);
    const operation = (previous
      ? previous.catch(() => undefined)
      : Promise.resolve())
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

  #beginRefresh(roleId: string): Promise<ChromiumRoleOverlayRefreshReceipt> {
    if (this.#state !== "open") {
      return Promise.reject(overlayError(
        "ELECTRON_ROLE_OVERLAY_DISPOSED",
        "The Chromium role-overlay coordinator is disposed."
      ));
    }
    const ready = this.#readyByRole.get(roleId);
    if (!ready) {
      return Promise.reject(overlayError(
        "ELECTRON_ROLE_OVERLAY_NOT_READY",
        "The Chromium role overlay is not ready for an exact refresh."
      ));
    }
    let expected: ChromiumRoleOverlayFrameIdentity;
    try {
      expected = this.#surfaces.currentOverlayFrame(roleId, ready.generation);
    } catch (error) {
      return Promise.reject(error);
    }
    if (!sameFrame(ready, expected)) {
      this.#readyByRole.delete(roleId);
      return Promise.reject(overlayError(
        "ELECTRON_ROLE_OVERLAY_DOCUMENT_SUPERSEDED",
        "The ready Chromium overlay no longer owns the live main frame."
      ));
    }

    let refreshId: string;
    try {
      refreshId = this.#createRefreshId();
    } catch {
      return Promise.reject(overlayError(
        "ELECTRON_ROLE_OVERLAY_REFRESH_ID_INVALID",
        "Chromium could not create an overlay refresh identity."
      ));
    }
    if (!validRefreshId(refreshId) || this.#usedRefreshIds.has(refreshId)) {
      return Promise.reject(overlayError(
        "ELECTRON_ROLE_OVERLAY_REFRESH_ID_INVALID",
        "Chromium could not create a unique canonical overlay refresh identity."
      ));
    }
    this.#usedRefreshIds.add(refreshId);

    const completion = deferred<ChromiumRoleOverlayRefreshReceipt>();
    const waiter: OverlayRefreshWaiter = {
      expected,
      refreshId,
      completion,
      submissionAccepted: false,
      receipt: null
    };
    this.#refreshById.set(refreshId, waiter);
    let submission: Promise<ChromiumRoleOverlayRefreshSubmissionReceipt>;
    try {
      submission = this.#surfaces.executeOverlayRefresh(expected, refreshId);
    } catch {
      this.#rejectRefresh(
        waiter,
        "ELECTRON_ROLE_OVERLAY_REFRESH_SUBMISSION_FAILED",
        "Chromium rejected the isolated-world overlay refresh submission."
      );
      return completion.promise;
    }
    void Promise.resolve(submission).then(
      (receipt) => this.#acceptRefreshSubmission(waiter, receipt),
      () => this.#rejectRefresh(
        waiter,
        "ELECTRON_ROLE_OVERLAY_REFRESH_SUBMISSION_FAILED",
        "Chromium rejected the isolated-world overlay refresh submission."
      )
    );
    return completion.promise;
  }

  #acceptRefreshSubmission(
    waiter: OverlayRefreshWaiter,
    receipt: ChromiumRoleOverlayRefreshSubmissionReceipt
  ): void {
    if (this.#refreshById.get(waiter.refreshId) !== waiter) return;
    if (
      receipt.roleId !== waiter.expected.roleId ||
      receipt.generation !== waiter.expected.generation ||
      receipt.frameToken !== waiter.expected.frameToken ||
      receipt.refreshId !== waiter.refreshId ||
      receipt.status !== "submitted" ||
      receipt.worldId !== CHROMIUM_ROLE_OVERLAY_WORLD_ID
    ) {
      this.#rejectRefresh(
        waiter,
        "ELECTRON_ROLE_OVERLAY_REFRESH_SUBMISSION_FAILED",
        "Chromium returned a mismatched overlay refresh submission receipt."
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
        "ELECTRON_ROLE_OVERLAY_DOCUMENT_SUPERSEDED",
        "The Chromium overlay document changed during refresh submission."
      );
      return;
    }
    if (!sameFrame(current, waiter.expected)) {
      this.#rejectRefresh(
        waiter,
        "ELECTRON_ROLE_OVERLAY_DOCUMENT_SUPERSEDED",
        "The Chromium overlay document changed during refresh submission."
      );
      return;
    }
    waiter.submissionAccepted = true;
    if (waiter.receipt) this.#resolveRefresh(waiter, waiter.receipt);
  }

  #acceptRefreshReceipt(
    identity: ChromiumRoleOverlayFrameIdentity,
    payload: RefreshReceiptPayload
  ): Readonly<{ refreshId: string; status: "accepted" }> {
    const waiter = this.#refreshById.get(payload.refreshId);
    if (!waiter || !sameFrame(waiter.expected, identity)) {
      fail(
        "ELECTRON_ROLE_OVERLAY_REFRESH_RECEIPT_UNAUTHORIZED",
        "The Chromium overlay refresh receipt does not own an active request."
      );
    }
    if (payload.status === "failed") {
      this.#rejectRefresh(
        waiter,
        "ELECTRON_ROLE_OVERLAY_REFRESH_FAILED",
        "The isolated Chromium overlay failed to apply its exact refresh."
      );
      return Object.freeze({ refreshId: payload.refreshId, status: "accepted" });
    }
    const receipt = Object.freeze({
      roleId: identity.roleId,
      generation: identity.generation,
      frameToken: identity.frameToken,
      documentInstanceId: identity.documentInstanceId,
      inputContext: Object.freeze({ ...payload.inputContext }),
      refreshId: payload.refreshId,
      requestVersion: payload.requestVersion,
      status: "applied" as const,
      worldId: CHROMIUM_ROLE_OVERLAY_WORLD_ID
    });
    waiter.receipt = receipt;
    if (waiter.submissionAccepted) this.#resolveRefresh(waiter, receipt);
    return Object.freeze({ refreshId: payload.refreshId, status: "accepted" });
  }

  #resolveRefresh(
    waiter: OverlayRefreshWaiter,
    receipt: ChromiumRoleOverlayRefreshReceipt
  ): void {
    if (this.#refreshById.get(waiter.refreshId) !== waiter) return;
    this.#refreshById.delete(waiter.refreshId);
    waiter.completion.resolve(receipt);
  }

  #rejectRefresh(
    waiter: OverlayRefreshWaiter,
    code: string,
    message: string
  ): void {
    if (this.#refreshById.get(waiter.refreshId) !== waiter) return;
    this.#refreshById.delete(waiter.refreshId);
    waiter.completion.reject(overlayError(code, message));
  }

  #rejectRoleRefreshes(
    roleId: string,
    generation: number,
    code: string,
    message: string
  ): void {
    for (const waiter of [...this.#refreshById.values()]) {
      if (
        waiter.expected.roleId === roleId &&
        waiter.expected.generation === generation
      ) {
        this.#rejectRefresh(waiter, code, message);
      }
    }
  }

  readonly #onSurfaceLifecycle = (
    event: ChromiumRoleOverlayLifecycleEvent
  ): void => {
    const ready = this.#readyByRole.get(event.roleId);
    if (ready?.generation === event.generation) {
      this.#readyByRole.delete(event.roleId);
    }
    const waiter = this.#waitersByRole.get(event.roleId);
    if (waiter?.expected.generation === event.generation) {
      this.#waitersByRole.delete(event.roleId);
      waiter.completion.reject(overlayError(
        event.reason === "document-superseded"
          ? "ELECTRON_ROLE_OVERLAY_DOCUMENT_SUPERSEDED"
          : "ELECTRON_ROLE_OVERLAY_SURFACE_RETIRED",
        event.reason === "document-superseded"
          ? "Navigation superseded the document before overlay readiness."
          : "The Chromium role surface retired before overlay readiness."
      ));
    }
    this.#rejectRoleRefreshes(
      event.roleId,
      event.generation,
      event.reason === "document-superseded"
        ? "ELECTRON_ROLE_OVERLAY_DOCUMENT_SUPERSEDED"
        : "ELECTRON_ROLE_OVERLAY_SURFACE_RETIRED",
      event.reason === "document-superseded"
        ? "Navigation superseded the document before overlay refresh completed."
        : "The Chromium role surface retired before overlay refresh completed."
    );
  };

  async #handleRequest(
    identity: ChromiumRoleOverlayFrameIdentity,
    payload: unknown
  ): Promise<unknown> {
    const type = requestType(payload);
    if (type === "coordinate-context") {
      if (Object.keys(payload as object).length !== 1) {
        fail(
          "ELECTRON_ROLE_OVERLAY_REQUEST_INVALID",
          "The coordinate-context request contains unsupported fields."
        );
      }
      return this.#runtime.coordinateContext(identity);
    }
    if (type === "activate") {
      if (!this.#runtime.activate) unsupported("request");
      await this.#runtime.activate(identity);
    }
    if (type === "game-input-context") {
      if (!this.#runtime.observeGameInputContext) unsupported("request");
      await this.#runtime.observeGameInputContext(identity, payload);
    }
    if (type === "runtime-tab-shortcut" || type === "flyff-caret-diagnostic") {
      fail(
        "ELECTRON_ROLE_OVERLAY_REQUEST_UNAVAILABLE",
        `The Chromium runtime has not enabled overlay request ${type}.`
      );
    }
    const requestJson = JSON.stringify(payload);
    return this.#core.overlayRequest({
      roleId: identity.roleId,
      requestJson
    });
  }

  #markReady(identity: ChromiumRoleOverlayFrameIdentity): void {
    const previous = this.#readyByRole.get(identity.roleId);
    if (previous && !sameFrame(previous, identity)) {
      this.#rejectRoleRefreshes(
        previous.roleId,
        previous.generation,
        "ELECTRON_ROLE_OVERLAY_DOCUMENT_SUPERSEDED",
        "A newer Chromium role document superseded overlay refresh."
      );
    }
    this.#readyByRole.set(identity.roleId, Object.freeze({ ...identity }));
    const waiter = this.#waitersByRole.get(identity.roleId);
    if (!waiter) return;
    if (!sameFrame(waiter.expected, identity)) {
      if (!previous || !sameFrame(previous, identity)) {
        this.#waitersByRole.delete(identity.roleId);
        waiter.completion.reject(overlayError(
          "ELECTRON_ROLE_OVERLAY_DOCUMENT_SUPERSEDED",
          "A newer Chromium role document superseded overlay installation."
        ));
      }
      return;
    }
    this.#waitersByRole.delete(identity.roleId);
    waiter.completion.resolve();
  }
}
