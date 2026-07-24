import type { Debugger, WebContents } from "electron";

export interface ElectronDebuggerLease {
  release: () => void;
}

type DetachListener = (reason: string) => void;
type MessageListener = (method: string, params: unknown, sessionId: string) => void;

const sessions = new WeakMap<object, ElectronDebuggerSession>();

export function getElectronDebuggerSession(
  webContents: Pick<WebContents, "debugger"> &
    Partial<Pick<WebContents, "isDestroyed" | "once">>
): ElectronDebuggerSession {
  const existing = sessions.get(webContents);
  if (existing) return existing;

  const session = new ElectronDebuggerSession(webContents.debugger);
  sessions.set(webContents, session);
  webContents.once?.("destroyed", () => {
    session.dispose();
    sessions.delete(webContents);
  });
  return session;
}

export class ElectronDebuggerSession {
  private readonly detachListeners = new Set<DetachListener>();
  private readonly messageListeners = new Set<MessageListener>();
  private activeLeaseCount = 0;
  private disposed = false;
  private ownsAttachment = false;

  constructor(private readonly debuggerApi: Pick<Debugger, "attach" | "detach" | "isAttached" | "sendCommand" | "on" | "removeListener">) {
    this.debuggerApi.on("detach", this.handleDetach);
    this.debuggerApi.on("message", this.handleMessage);
  }

  isAttached(): boolean {
    return this.debuggerApi.isAttached();
  }

  async acquire(): Promise<ElectronDebuggerLease> {
    if (this.disposed) {
      throw new Error("Electron debugger session disposed.");
    }
    if (!this.debuggerApi.isAttached()) {
      try {
        this.debuggerApi.attach("1.3");
        this.ownsAttachment = true;
      } catch (error) {
        if (!this.debuggerApi.isAttached()) throw error;
      }
    }

    this.activeLeaseCount += 1;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.activeLeaseCount = Math.max(0, this.activeLeaseCount - 1);
        if (this.activeLeaseCount === 0 && this.ownsAttachment && this.debuggerApi.isAttached()) {
          this.debuggerApi.detach();
          this.ownsAttachment = false;
        }
      }
    };
  }

  onDetach(listener: DetachListener): () => void {
    this.detachListeners.add(listener);
    return () => this.detachListeners.delete(listener);
  }

  onMessage(listener: MessageListener): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  sendCommand<T = unknown>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new Error("Electron debugger session disposed."));
    }
    return (sessionId === undefined
      ? this.debuggerApi.sendCommand(method, params)
      : this.debuggerApi.sendCommand(method, params, sessionId)) as Promise<T>;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detachListeners.clear();
    this.messageListeners.clear();
    this.debuggerApi.removeListener("detach", this.handleDetach);
    this.debuggerApi.removeListener("message", this.handleMessage);
    if (this.ownsAttachment && this.debuggerApi.isAttached()) {
      try {
        this.debuggerApi.detach();
      } catch {
        // The WebContents destruction path may detach the debugger first.
      }
    }
    this.activeLeaseCount = 0;
    this.ownsAttachment = false;
  }

  private readonly handleDetach = (_event: unknown, reason: string): void => {
    this.ownsAttachment = false;
    this.detachListeners.forEach((listener) => listener(reason));
  };

  private readonly handleMessage = (
    _event: unknown,
    method: string,
    params: unknown,
    sessionId: string
  ): void => {
    this.messageListeners.forEach((listener) => listener(method, params, sessionId));
  };
}
