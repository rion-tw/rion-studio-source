export function withUpdaterProbeCleanup<T>(
  probe: () => Promise<T>,
  cleanup: () => Promise<unknown>
): Promise<T>;
