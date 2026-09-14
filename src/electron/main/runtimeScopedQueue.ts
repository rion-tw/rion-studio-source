import { RionBridgeError } from "../ipc/errors";

/** Exact overlapping admissions remain ordered; unrelated resources progress. */
export class RuntimeScopedQueue {
  readonly #tails = new Map<string, Promise<void>>();
  #pending = 0;
  constructor(private readonly capacity: number) {}
  run<T>(scopes: readonly string[], task: () => Promise<T>): Promise<T> {
    if (this.#pending >= this.capacity) return Promise.reject(new RionBridgeError({
      code: "ELECTRON_CHROMIUM_LAUNCH_QUEUE_FULL", message: "The scoped launch admission queue is full." }));
    this.#pending += 1;
    const result = Promise.all(scopes.map(scope => this.#tails.get(scope))).then(task);
    const terminal = result.then(() => undefined, () => undefined);
    for (const scope of scopes) this.#tails.set(scope, terminal);
    return result.finally(() => {
      this.#pending -= 1;
      for (const scope of scopes) if (this.#tails.get(scope) === terminal) this.#tails.delete(scope);
    });
  }
}
