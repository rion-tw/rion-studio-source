/** Pending native topology acknowledgements, scoped to the exact affected window. */
export class RuntimeWindowProjectionFence {
  readonly #pending = new Map<string, Set<Promise<void>>>();
  retain(scopes: readonly string[], terminal: Promise<void>): void {
    for (const scope of new Set(scopes)) {
      if (!scope.startsWith("window:")) continue;
      const pending = this.#pending.get(scope) ?? new Set<Promise<void>>();
      pending.add(terminal);
      this.#pending.set(scope, pending);
      const release = () => {
        pending.delete(terminal);
        if (pending.size === 0 && this.#pending.get(scope) === pending) this.#pending.delete(scope);
      };
      void terminal.then(release, release);
    }
  }
  async settle(windowId: string): Promise<boolean> {
    const pending = [...this.#pending.get(`window:${windowId}`) ?? []];
    await Promise.all(pending);
    return pending.length > 0;
  }
}
