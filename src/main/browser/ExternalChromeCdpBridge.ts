/**
 * Electron-side view of the Rust-owned external Chrome CDP connection.
 * Implementations are created by the Node-API addon; this file intentionally
 * contains contracts only and no discovery, socket, retry, or timer logic.
 */
export interface CdpNotification {
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

export interface CdpEventClientLike {
  send: <T>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
    sessionId?: string
  ) => Promise<T>;
  close: () => void;
  onDisconnect: (listener: () => void) => () => void;
  onNotification: (listener: (notification: CdpNotification) => void) => () => void;
}
