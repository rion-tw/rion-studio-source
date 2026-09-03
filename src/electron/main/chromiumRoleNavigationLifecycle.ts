import { randomUUID } from "node:crypto";

import { RionBridgeError } from "../ipc/errors";

interface ChromiumRoleNavigationLifecycleIdentity {
  readonly generation: number;
  readonly navigationSequence: number;
  readonly roleId: string;
  readonly tabId: string;
}

export type ChromiumRoleNavigationLifecycleEvent =
  | ChromiumRoleNavigationLifecycleIdentity & Readonly<{
      previousDocumentInstanceId: string;
      type: "document-started";
    }>
  | ChromiumRoleNavigationLifecycleIdentity & Readonly<{
      documentInstanceId: string;
      type: "page-finished";
      validatedUrl: string;
    }>
  | ChromiumRoleNavigationLifecycleIdentity & Readonly<{
      errorCode: number;
      type: "page-failed";
      validatedUrl?: string;
    }>
  | ChromiumRoleNavigationLifecycleIdentity & Readonly<{
      type: "surface-retired";
    }>;

export interface ChromiumRoleControlledReloadPreparation {
  readonly documentInstanceId: string;
  readonly navigationSequence: number;
  readonly roleId: string;
  readonly surfaceGeneration: number;
  readonly tabId: string;
}

type NavigationListener = (
  event: ChromiumRoleNavigationLifecycleEvent
) => boolean | void;

function navigationError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function validateOperationId(value: string): void {
  if (
    value.length === 0 || value.length > 256 || value !== value.trim() ||
    [...value].some((character) => character.codePointAt(0)! <= 0x1f)
  ) {
    throw navigationError(
      "ELECTRON_ROLE_RELOAD_OPERATION_INVALID",
      "The controlled reload requires an exact operation identity."
    );
  }
}

export class ChromiumRoleNavigationLifecycleHub {
  readonly #listeners = new Set<NavigationListener>();

  subscribe(listener: NavigationListener): () => void {
    this.#listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.#listeners.delete(listener);
    };
  }

  emit(event: ChromiumRoleNavigationLifecycleEvent): boolean {
    let claimed = false;
    for (const listener of this.#listeners) {
      try {
        claimed = listener(event) === true || claimed;
      } catch {
        // Navigation truth cannot be blocked by an observer failure.
      }
    }
    return claimed;
  }
}

/** Owns the permanent event-bound navigation identity for one WebContents. */
export class ChromiumRoleNavigationLifecycleOwner {
  readonly #generation: number;
  readonly #hub: ChromiumRoleNavigationLifecycleHub;
  readonly #reload: () => void;
  readonly #roleId: string;
  readonly #tabId: string;
  readonly #popupAdmissionFences = new Set<string>();
  #documentInstanceId = randomUUID();
  #navigationSequence = 0;
  #retired = false;

  constructor(input: Readonly<{
    generation: number;
    hub: ChromiumRoleNavigationLifecycleHub;
    reload: () => void;
    roleId: string;
    tabId: string;
  }>) {
    this.#generation = input.generation;
    this.#hub = input.hub;
    this.#reload = input.reload;
    this.#roleId = input.roleId;
    this.#tabId = input.tabId;
  }

  get documentInstanceId(): string {
    return this.#documentInstanceId;
  }

  get popupAdmissionFenced(): boolean {
    return this.#popupAdmissionFences.size > 0;
  }

  documentStarted(): void {
    if (this.#retired) return;
    const previousDocumentInstanceId = this.#documentInstanceId;
    this.#navigationSequence += 1;
    this.#documentInstanceId = randomUUID();
    this.#hub.emit(Object.freeze({
      generation: this.#generation,
      navigationSequence: this.#navigationSequence,
      previousDocumentInstanceId,
      roleId: this.#roleId,
      tabId: this.#tabId,
      type: "document-started" as const
    }));
  }

  pageFinished(validatedUrl: string): void {
    if (this.#retired) return;
    this.#hub.emit(Object.freeze({
      documentInstanceId: this.#documentInstanceId,
      generation: this.#generation,
      navigationSequence: this.#navigationSequence,
      roleId: this.#roleId,
      tabId: this.#tabId,
      type: "page-finished" as const,
      validatedUrl
    }));
  }

  pageFailed(errorCode: number, validatedUrl?: string): boolean {
    if (this.#retired) return false;
    return this.#hub.emit(Object.freeze({
      errorCode,
      generation: this.#generation,
      navigationSequence: this.#navigationSequence,
      roleId: this.#roleId,
      tabId: this.#tabId,
      type: "page-failed" as const,
      ...(validatedUrl === undefined ? {} : { validatedUrl })
    }));
  }

  preflight(): ChromiumRoleControlledReloadPreparation {
    if (this.#retired) {
      throw navigationError(
        "ELECTRON_ROLE_RELOAD_SURFACE_STALE",
        "The controlled reload role surface is no longer active."
      );
    }
    return Object.freeze({
      documentInstanceId: this.#documentInstanceId,
      navigationSequence: this.#navigationSequence,
      roleId: this.#roleId,
      surfaceGeneration: this.#generation,
      tabId: this.#tabId
    });
  }

  acquire(
    preparation: ChromiumRoleControlledReloadPreparation,
    operationId: string
  ): ChromiumRoleControlledReloadPreparation {
    validateOperationId(operationId);
    if (
      this.#retired || preparation.roleId !== this.#roleId ||
      preparation.tabId !== this.#tabId ||
      preparation.surfaceGeneration !== this.#generation ||
      preparation.navigationSequence !== this.#navigationSequence ||
      preparation.documentInstanceId !== this.#documentInstanceId
    ) {
      throw navigationError(
        "ELECTRON_ROLE_RELOAD_PREPARATION_STALE",
        "The controlled reload lost its exact role document preflight."
      );
    }
    this.#popupAdmissionFences.add(operationId);
    return preparation;
  }

  prepare(operationId: string): ChromiumRoleControlledReloadPreparation {
    return this.acquire(this.preflight(), operationId);
  }

  submit(
    preparation: ChromiumRoleControlledReloadPreparation,
    operationId: string
  ): void {
    validateOperationId(operationId);
    if (
      this.#retired || preparation.roleId !== this.#roleId ||
      preparation.tabId !== this.#tabId ||
      preparation.surfaceGeneration !== this.#generation ||
      preparation.navigationSequence !== this.#navigationSequence ||
      preparation.documentInstanceId !== this.#documentInstanceId ||
      !this.#popupAdmissionFences.has(operationId)
    ) {
      throw navigationError(
        "ELECTRON_ROLE_RELOAD_PREPARATION_STALE",
        "The controlled reload lost its exact role document preparation."
      );
    }
    // EventBound: only permanent WebContents lifecycle events terminalize this.
    this.#reload();
  }

  release(
    operationId: string,
    expectedDocumentInstanceId?: string
  ): boolean {
    validateOperationId(operationId);
    if (
      this.#retired || !this.#popupAdmissionFences.has(operationId) ||
      (expectedDocumentInstanceId !== undefined &&
        expectedDocumentInstanceId !== this.#documentInstanceId)
    ) return false;
    this.#popupAdmissionFences.delete(operationId);
    return true;
  }

  retire(): void {
    if (this.#retired) return;
    this.#retired = true;
    this.#hub.emit(Object.freeze({
      generation: this.#generation,
      navigationSequence: this.#navigationSequence,
      roleId: this.#roleId,
      tabId: this.#tabId,
      type: "surface-retired" as const
    }));
    this.#popupAdmissionFences.clear();
  }
}
