import { randomUUID } from "node:crypto";

import type {
  QuickAccessPresentationRequest,
  QuickAccessRequestResolution
} from "../../shared/types";
import { RionBridgeError } from "../ipc/errors";

interface QuickAccessRequestEntry {
  readonly requestId: string;
  readonly tabId: string | null;
  consumed: boolean;
}

export interface ChromiumQuickAccessRequestControllerInput {
  readonly createRequestId?: () => string;
  readonly publishRequest: (request: QuickAccessPresentationRequest) => void;
  readonly presentMainWindow: (requestId: string) => Promise<void>;
}

export interface ChromiumQuickAccessRequestPort {
  consumePending: () => QuickAccessPresentationRequest | null;
  present: (requestId: string) => Promise<boolean>;
  resolve: (
    requestId: string,
    resolution: QuickAccessRequestResolution
  ) => Promise<string | null>;
}

function quickAccessError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function requireIdentifier(value: unknown): string {
  if (
    typeof value !== "string" || value.length === 0 || value.length > 256 ||
    value !== value.trim() || value.includes("/") || value.includes("\\") ||
    [...value].some((character) => character.codePointAt(0)! <= 0x1f)
  ) {
    throw quickAccessError(
      "ELECTRON_QUICK_ACCESS_REQUEST_ID_INVALID",
      "The Quick Access request identity is invalid."
    );
  }
  return value;
}

/** Latest-only event ledger for requests originating in a live Chromium tab. */
export class ChromiumQuickAccessRequestController
implements ChromiumQuickAccessRequestPort {
  readonly #input: ChromiumQuickAccessRequestControllerInput;
  #current: QuickAccessRequestEntry | null = null;
  #lane: Promise<void> = Promise.resolve();

  constructor(input: ChromiumQuickAccessRequestControllerInput) {
    this.#input = input;
  }

  beginRuntimeTabRequest(tabId: string): QuickAccessPresentationRequest {
    return this.#begin(requireIdentifier(tabId));
  }

  beginMainWindowRequest(): QuickAccessPresentationRequest {
    return this.#begin(null);
  }

  #begin(tabId: string | null): QuickAccessPresentationRequest {
    const request = Object.freeze({
      requestId: requireIdentifier((this.#input.createRequestId ?? randomUUID)())
    });
    this.#current = {
      requestId: request.requestId,
      tabId,
      consumed: false
    };
    this.#input.publishRequest(request);
    return request;
  }

  consumePending(): QuickAccessPresentationRequest | null {
    const current = this.#current;
    if (!current || current.consumed) return null;
    current.consumed = true;
    return Object.freeze({ requestId: current.requestId });
  }

  present(requestId: string): Promise<boolean> {
    const exactRequestId = requireIdentifier(requestId);
    return this.#enqueue(async () => {
      if (!this.#isPresentable(exactRequestId)) return false;
      await this.#input.presentMainWindow(exactRequestId);
      return this.#isPresentable(exactRequestId);
    });
  }

  resolve(
    requestId: string,
    resolution: QuickAccessRequestResolution
  ): Promise<string | null> {
    const exactRequestId = requireIdentifier(requestId);
    if (!(resolution === "cancel" || resolution === "complete" || resolution === "ignored")) {
      return Promise.reject(quickAccessError(
        "ELECTRON_QUICK_ACCESS_RESOLUTION_INVALID",
        "The Quick Access resolution is invalid."
      ));
    }
    return this.#enqueue(async () => {
      if (this.#current?.requestId !== exactRequestId) return null;
      const origin = this.#current;
      this.#current = null;
      return resolution === "cancel" ? origin.tabId : null;
    });
  }

  #isPresentable(requestId: string): boolean {
    return this.#current?.requestId === requestId && this.#current.consumed;
  }

  #enqueue<Result>(task: () => Promise<Result>): Promise<Result> {
    const result = this.#lane.then(task);
    this.#lane = result.then(() => undefined, () => undefined);
    return result;
  }
}
