import { RionBridgeError } from "../ipc/errors";

/** Owns admission and the exact Promises returned by native control callbacks. */
export class ChromiumNativeActionIngress {
  #accepting = true;
  readonly #pending = new Set<Promise<unknown>>();
  #drain: Promise<void> | null = null;

  requireOpen(): void {
    if (!this.#accepting) {
      throw new RionBridgeError({
        code: "ELECTRON_CHROMIUM_NATIVE_ACTION_DRAINING",
        message: "The Chromium runtime rejects native actions while preparing to exit."
      });
    }
  }

  run<Value>(action: () => Promise<Value>): Promise<Value> {
    this.requireOpen();
    // Start in the authoritative native callback turn; do not defer admission.
    let resolve!: (value: Value | PromiseLike<Value>) => void;
    let reject!: (reason: unknown) => void;
    const result = new Promise<Value>((accept, fail) => { resolve = accept; reject = fail; });
    this.#pending.add(result);
    void result.then(
      () => { this.#pending.delete(result); },
      () => { this.#pending.delete(result); }
    );
    try { resolve(action()); } catch (error) { reject(error); }
    return result;
  }

  close(): void {
    this.#accepting = false;
  }

  closeAndDrain(): Promise<void> {
    this.close();
    // Exact accepted operation terminals, while their effect executor is live.
    // Neither elapsed time nor a renderer projection can release these leases.
    this.#drain ??= Promise.allSettled([...this.#pending]).then((results) => {
      const failed = results.find((result) => result.status === "rejected");
      if (failed) throw failed.reason;
    });
    return this.#drain;
  }
}
