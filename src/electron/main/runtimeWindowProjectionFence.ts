export interface RuntimeWindowProjectionProgress {
  /** Preserves the first failed receipt even after it leaves the pending set. */
  readSequence(): number;
  dispose(): void;
}

interface WindowProgressObserver {
  sequence: number;
  failure?: { reason: unknown };
}

/** Pending native topology acknowledgements, scoped to the exact affected window. */
export class RuntimeWindowProjectionFence {
  readonly #pending = new Map<string, Set<Promise<void>>>();
  readonly #observers = new Map<string, Set<WindowProgressObserver>>();

  /** Retains progress only while a caller is observing this exact window. */
  observe(windowId: string): RuntimeWindowProjectionProgress {
    const scope = `window:${windowId}`;
    const observer: WindowProgressObserver = { sequence: 0 };
    const observers = this.#observers.get(scope) ?? new Set();
    observers.add(observer);
    this.#observers.set(scope, observers);
    let disposed = false;
    return Object.freeze({
      readSequence: () => {
        if (observer.failure) throw observer.failure.reason;
        return observer.sequence;
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        observers.delete(observer);
        if (observers.size === 0 && this.#observers.get(scope) === observers) {
          this.#observers.delete(scope);
        }
      }
    });
  }

  #advance(scope: string, failure?: { reason: unknown }): void {
    for (const observer of this.#observers.get(scope) ?? []) {
      observer.sequence += 1;
      observer.failure ??= failure;
    }
  }

  retain(scopes: readonly string[], terminal: Promise<void>): void {
    for (const scope of new Set(scopes)) {
      if (!scope.startsWith("window:")) continue;
      const pending = this.#pending.get(scope) ?? new Set<Promise<void>>();
      if (pending.has(terminal)) continue;
      pending.add(terminal);
      this.#pending.set(scope, pending);
      this.#advance(scope);
      const release = (failure?: { reason: unknown }) => {
        pending.delete(terminal);
        this.#advance(scope, failure);
        if (pending.size === 0 && this.#pending.get(scope) === pending) this.#pending.delete(scope);
      };
      void terminal.then(() => release(), reason => release({ reason }));
    }
  }
  async settle(windowId: string, signal?: AbortSignal): Promise<boolean> {
    const pending = [...this.#pending.get(`window:${windowId}`) ?? []];
    if (signal?.aborted) throw signal.reason;
    if (signal && pending.length > 0) {
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        void Promise.all(pending).then(() => resolve(), reject).finally(() =>
          signal.removeEventListener("abort", abort));
      });
    } else await Promise.all(pending);
    return pending.length > 0;
  }
}
