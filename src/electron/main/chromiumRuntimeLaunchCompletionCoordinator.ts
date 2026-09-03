import type { CoreEvent } from "../../shared/generated";
import { normalizeRionBridgeError, RionBridgeError } from "../ipc/errors";
import type { ElectronCoreEventSource } from "./coreRendererEventBridge";
import type { ChromiumRuntimeLaunchCompletionPort } from
  "./chromiumRuntimeLaunchCoordinator";

const MAX_RETAINED_COMPLETIONS = 4_096;
const MAX_PENDING_COMPLETIONS = 128;

type ExpectedCompletion = Parameters<
  ChromiumRuntimeLaunchCompletionPort["awaitExact"]
>[0];
type LaunchCompletion = Awaited<ReturnType<
  ChromiumRuntimeLaunchCompletionPort["awaitExact"]
>>;

interface PendingCompletion {
  readonly expected: ExpectedCompletion;
  readonly resolve: (completion: LaunchCompletion) => void;
  readonly reject: (error: unknown) => void;
}

export interface ChromiumRuntimeLaunchCompletionCoordinatorInput {
  readonly core: ElectronCoreEventSource;
  readonly onError: (error: ReturnType<typeof normalizeRionBridgeError>) => void;
}

function completionError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function validIdentifier(value: string): boolean {
  return value.length > 0 && value.length <= 128 && value === value.trim() &&
    ![...value].some((character) => character.codePointAt(0)! <= 0x1f);
}

function validateExpected(expected: ExpectedCompletion): void {
  if (
    !validIdentifier(expected.operationId) ||
    !validIdentifier(expected.tabId) ||
    !validIdentifier(expected.sourceId) ||
    !(["role", "workspace"] as const).includes(expected.sourceType)
  ) {
    throw completionError(
      "ELECTRON_CHROMIUM_LAUNCH_COMPLETION_EXPECTATION_INVALID",
      "A Chromium launch completion expectation has an invalid identity."
    );
  }
}

function completionFromEvent(
  event: Extract<CoreEvent, { type: "browserLaunchCompleted" }>
): LaunchCompletion {
  if (
    !validIdentifier(event.operationId) ||
    !validIdentifier(event.tabId) ||
    !validIdentifier(event.sourceId) ||
    !(["role", "workspace"] as const).includes(event.sourceType) ||
    (event.errorCode !== undefined && !validIdentifier(event.errorCode)) ||
    event.ok === (event.errorCode !== undefined)
  ) {
    throw completionError(
      "ELECTRON_CHROMIUM_LAUNCH_COMPLETION_EVENT_INVALID",
      "Core emitted an invalid Chromium launch completion event."
    );
  }
  return Object.freeze({
    operationId: event.operationId,
    tabId: event.tabId,
    sourceId: event.sourceId,
    sourceType: event.sourceType,
    ok: event.ok,
    ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode })
  });
}

function exactCompletion(
  expected: ExpectedCompletion,
  completion: LaunchCompletion
): boolean {
  return completion.operationId === expected.operationId &&
    completion.tabId === expected.tabId &&
    completion.sourceId === expected.sourceId &&
    completion.sourceType === expected.sourceType;
}

/** Retains Core-owned launch terminal events without polling or deadlines. */
export class ChromiumRuntimeLaunchCompletionCoordinator
implements ChromiumRuntimeLaunchCompletionPort {
  readonly #input: ChromiumRuntimeLaunchCompletionCoordinatorInput;
  readonly #completed = new Map<string, LaunchCompletion>();
  readonly #completionOrder: string[] = [];
  readonly #pending = new Map<string, PendingCompletion>();
  #unsubscribe: (() => void) | null = null;
  #disposed = false;

  constructor(input: ChromiumRuntimeLaunchCompletionCoordinatorInput) {
    this.#input = input;
  }

  start(): void {
    if (this.#disposed) {
      throw completionError(
        "ELECTRON_CHROMIUM_LAUNCH_COMPLETION_DISPOSED",
        "The Chromium launch completion stream is disposed."
      );
    }
    if (this.#unsubscribe) return;
    this.#unsubscribe = this.#input.core.subscribeCoreEvents(this.#onCoreEvent);
  }

  awaitExact(expected: ExpectedCompletion): Promise<LaunchCompletion> {
    try {
      validateExpected(expected);
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.#disposed || !this.#unsubscribe) {
      return Promise.reject(completionError(
        "ELECTRON_CHROMIUM_LAUNCH_COMPLETION_UNAVAILABLE",
        "The authoritative Chromium launch completion stream is unavailable."
      ));
    }
    const completed = this.#completed.get(expected.operationId);
    if (completed) return this.#validateExact(expected, completed);
    if (this.#pending.has(expected.operationId)) {
      return Promise.reject(completionError(
        "ELECTRON_CHROMIUM_LAUNCH_COMPLETION_WAIT_DUPLICATE",
        "A Chromium launch operation already has an exact completion waiter."
      ));
    }
    if (this.#pending.size >= MAX_PENDING_COMPLETIONS) {
      return Promise.reject(completionError(
        "ELECTRON_CHROMIUM_LAUNCH_COMPLETION_CAPACITY",
        "The Chromium launch completion waiter capacity is exhausted."
      ));
    }
    return new Promise<LaunchCompletion>((resolve, reject) => {
      this.#pending.set(expected.operationId, {
        expected: { ...expected },
        resolve,
        reject
      });
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    const error = completionError(
      "ELECTRON_CHROMIUM_LAUNCH_COMPLETION_DISPOSED",
      "The Chromium launch completion stream stopped before Core terminalized the launch."
    );
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.#completed.clear();
    this.#completionOrder.length = 0;
  }

  readonly #onCoreEvent = (event: CoreEvent): void => {
    if (this.#disposed) return;
    if (event.type === "shutdown") {
      this.dispose();
      return;
    }
    if (event.type !== "browserLaunchCompleted") return;
    let completion: LaunchCompletion;
    try {
      completion = completionFromEvent(event);
    } catch (error) {
      this.#input.onError(normalizeRionBridgeError(
        error,
        "ELECTRON_CHROMIUM_LAUNCH_COMPLETION_EVENT_INVALID"
      ));
      return;
    }
    const retained = this.#completed.get(completion.operationId);
    if (retained && JSON.stringify(retained) !== JSON.stringify(completion)) {
      const error = completionError(
        "ELECTRON_CHROMIUM_LAUNCH_COMPLETION_DIVERGED",
        "Core reused a Chromium launch operation identity for a different terminal event."
      );
      this.#pending.get(completion.operationId)?.reject(error);
      this.#pending.delete(completion.operationId);
      this.#input.onError(normalizeRionBridgeError(
        error,
        "ELECTRON_CHROMIUM_LAUNCH_COMPLETION_DIVERGED"
      ));
      return;
    }
    if (!retained) {
      this.#completed.set(completion.operationId, completion);
      this.#completionOrder.push(completion.operationId);
      this.#prune();
    }
    const pending = this.#pending.get(completion.operationId);
    if (!pending) return;
    this.#pending.delete(completion.operationId);
    void this.#validateExact(pending.expected, completion).then(
      pending.resolve,
      pending.reject
    );
  };

  #validateExact(
    expected: ExpectedCompletion,
    completion: LaunchCompletion
  ): Promise<LaunchCompletion> {
    return exactCompletion(expected, completion)
      ? Promise.resolve(completion)
      : Promise.reject(completionError(
          "ELECTRON_CHROMIUM_LAUNCH_COMPLETION_IDENTITY_MISMATCH",
          "Core terminalized a different Chromium launch identity than the restore expected."
        ));
  }

  #prune(): void {
    while (this.#completed.size > MAX_RETAINED_COMPLETIONS) {
      const operationId = this.#completionOrder.shift();
      if (!operationId) return;
      this.#completed.delete(operationId);
    }
  }
}
