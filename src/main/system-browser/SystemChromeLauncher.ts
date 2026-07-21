import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import WebSocket from "ws";


export class SystemChromeLauncherError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "SystemChromeLauncherError";
  }
}

export type DevToolsFetch = (url: string) => Promise<DevToolsResponse>;
export interface DevToolsResponse {
  ok: boolean;
  json: () => Promise<unknown>;
  text?: () => Promise<string>;
}

export interface DevToolsTarget {
  id: string;
  type?: string;
  url?: string;
  title?: string;
  webSocketDebuggerUrl?: string;
}

export interface CdpClientLike {
  send: <T>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
    sessionId?: string
  ) => Promise<T>;
  close: () => void;
}

export interface CdpNotification {
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

export interface CdpEventClientLike extends CdpClientLike {
  onDisconnect: (listener: () => void) => () => void;
  onNotification: (listener: (notification: CdpNotification) => void) => () => void;
}

export interface CdpClientOptions {
  WebSocket?: CdpWebSocketConstructor;
  requestTimeoutMs?: number;
}

export interface CdpWebSocketConstructor {
  new (url: string): CdpWebSocketLike;
}

export interface CdpWebSocketLike {
  readyState: number;
  send: (data: string) => void;
  close: () => void;
  addEventListener: (type: string, listener: (event: unknown) => void) => void;
  removeEventListener: (type: string, listener: (event: unknown) => void) => void;
}

const DEFAULT_WEB_SOCKET_CONSTRUCTOR = WebSocket as unknown as CdpWebSocketConstructor;

const DEFAULT_ACTIVE_PORT_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const CDP_REQUEST_TIMEOUT_MS = 5_000;
const WEB_SOCKET_OPEN_STATE = 1;

export class CdpClient implements CdpEventClientLike {
  private readonly socket: CdpWebSocketLike;
  private readonly ready: Promise<void>;
  private readonly requestTimeoutMs: number;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeout: NodeJS.Timeout;
    }
  >();
  private nextId = 1;
  private readonly disconnectListeners = new Set<() => void>();
  private readonly notificationListeners = new Set<(notification: CdpNotification) => void>();
  private didDisconnect = false;

  constructor(url: string, options: CdpClientOptions = {}) {
    const WebSocketConstructor = options.WebSocket ?? DEFAULT_WEB_SOCKET_CONSTRUCTOR;

    this.requestTimeoutMs = options.requestTimeoutMs ?? CDP_REQUEST_TIMEOUT_MS;
    this.socket = new WebSocketConstructor(url);
    this.ready = new Promise<void>((resolve, reject) => {
      const handleOpen = (): void => {
        cleanup();
        resolve();
      };
      const handleError = (): void => {
        cleanup();
        reject(new SystemChromeLauncherError("DEVTOOLS_WEBSOCKET_ERROR", "Chrome DevTools WebSocket failed."));
      };
      const handleClose = (): void => {
        cleanup();
        reject(new SystemChromeLauncherError("DEVTOOLS_WEBSOCKET_CLOSED", "Chrome DevTools WebSocket closed."));
      };
      const cleanup = (): void => {
        this.socket.removeEventListener("open", handleOpen);
        this.socket.removeEventListener("error", handleError);
        this.socket.removeEventListener("close", handleClose);
      };

      this.socket.addEventListener("open", handleOpen);
      this.socket.addEventListener("error", handleError);
      this.socket.addEventListener("close", handleClose);
    });

    this.socket.addEventListener("message", (event) => {
      this.handleMessage(event);
    });
    this.socket.addEventListener("error", () => {
      this.rejectPending(new SystemChromeLauncherError("DEVTOOLS_WEBSOCKET_ERROR", "Chrome DevTools WebSocket failed."));
      this.emitDisconnect();
    });
    this.socket.addEventListener("close", () => {
      this.rejectPending(new SystemChromeLauncherError("DEVTOOLS_WEBSOCKET_CLOSED", "Chrome DevTools WebSocket closed."));
      this.emitDisconnect();
    });
  }

  onDisconnect(listener: () => void): () => void {
    if (this.didDisconnect) {
      queueMicrotask(listener);
      return () => undefined;
    }
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  onNotification(listener: (notification: CdpNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  async send<T>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = this.requestTimeoutMs,
    sessionId?: string
  ): Promise<T> {
    await this.ready;
    if (this.didDisconnect || this.socket.readyState !== WEB_SOCKET_OPEN_STATE) {
      throw createCdpDisconnectedError();
    }
    const id = this.nextId++;

    return new Promise<T>((resolve, reject) => {
      if (this.didDisconnect || this.socket.readyState !== WEB_SOCKET_OPEN_STATE) {
        reject(createCdpDisconnectedError());
        return;
      }
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new SystemChromeLauncherError("DEVTOOLS_REQUEST_TIMEOUT", `Chrome DevTools request timed out: ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => {
          resolve(value as T);
        },
        reject,
        timeout
      });

      try {
        this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error("Unable to send Chrome DevTools request."));
      }
    });
  }

  close(): void {
    this.rejectPending(createCdpDisconnectedError());
    this.emitDisconnect();
    this.socket.close();
  }

  private handleMessage(event: unknown): void {
    const payload = parseCdpMessage(event);

    if (!isCdpResponse(payload)) {
      if (isCdpNotification(payload)) {
        this.notificationListeners.forEach((listener) => listener(payload));
      }
      return;
    }

    const pendingRequest = this.pending.get(payload.id);

    if (!pendingRequest) {
      return;
    }

    clearTimeout(pendingRequest.timeout);
    this.pending.delete(payload.id);

    if (payload.error) {
      pendingRequest.reject(new Error(payload.error.message));
      return;
    }

    pendingRequest.resolve(payload.result);
  }

  private rejectPending(error: Error): void {
    for (const [id, pendingRequest] of this.pending) {
      clearTimeout(pendingRequest.timeout);
      this.pending.delete(id);
      pendingRequest.reject(error);
    }
  }

  private emitDisconnect(): void {
    if (this.didDisconnect) {
      return;
    }

    this.didDisconnect = true;
    this.disconnectListeners.forEach((listener) => listener());
  }
}

function createCdpDisconnectedError(): SystemChromeLauncherError {
  return new SystemChromeLauncherError(
    "DEVTOOLS_WEBSOCKET_CLOSED",
    "Chrome DevTools WebSocket closed."
  );
}

export async function waitForDevToolsPort(
  userDataDir: string,
  options: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    isClosed?: () => boolean;
  } = {}
): Promise<{ state: "available"; port: number } | { state: "closed" | "unavailable"; message: string }> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_ACTIVE_PORT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => delay(ms));
  const isClosed = options.isClosed ?? (() => false);
  const startedAt = now();
  const activePortPath = join(userDataDir, "DevToolsActivePort");
  let lastError: string | undefined;

  while (!isClosed() && now() - startedAt <= timeoutMs) {
    try {
      return {
        state: "available",
        port: parseDevToolsActivePort(await readFile(activePortPath, "utf8"))
      };
    } catch (error) {
      lastError = toMessage(error);
    }

    await sleep(pollIntervalMs);
  }

  if (isClosed()) {
    return {
      state: "closed",
      message: "Chrome DevTools became unavailable."
    };
  }

  return {
    state: "unavailable",
    message: lastError ?? "Unable to find Chrome DevTools port."
  };
}

export function parseDevToolsActivePort(value: string): number {
  const [portLine] = value.split(/\r?\n/);
  const port = Number(portLine);

  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
    throw new SystemChromeLauncherError("DEVTOOLS_PORT_INVALID", "Chrome DevTools port file is invalid.");
  }

  return port;
}

export async function closeDevToolsTarget(
  port: number,
  targetId: string,
  fetchDevTools: DevToolsFetch = fetchJson
): Promise<void> {
  const response = await fetchDevTools(`http://127.0.0.1:${port}/json/close/${encodeURIComponent(targetId)}`);

  if (!response.ok) {
    throw new SystemChromeLauncherError("DEVTOOLS_CLOSE_FAILED", "Chrome DevTools target could not be closed.");
  }
}

export async function listDevToolsTargets(port: number, fetchDevTools: DevToolsFetch = fetchJson): Promise<DevToolsTarget[]> {
  const response = await fetchDevTools(`http://127.0.0.1:${port}/json/list`);

  if (!response.ok) {
    throw new SystemChromeLauncherError("DEVTOOLS_LIST_FAILED", "Unable to inspect Chrome DevTools targets.");
  }

  const payload = await response.json();

  if (!Array.isArray(payload)) {
    return [];
  }

  return payload.filter(isDevToolsTarget);
}

function isCdpNotification(value: unknown): value is CdpNotification {
  return (
    typeof value === "object" &&
    value !== null &&
    "method" in value &&
    typeof (value as { method?: unknown }).method === "string"
  );
}

function isDevToolsTarget(value: unknown): value is DevToolsTarget {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof (value as { id?: unknown }).id === "string"
  );
}

function parseCdpMessage(event: unknown): unknown {
  const data = (event as { data?: unknown }).data;
  const raw =
    typeof data === "string"
      ? data
      : data instanceof ArrayBuffer
        ? Buffer.from(data).toString("utf8")
        : ArrayBuffer.isView(data)
          ? Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8")
          : String(data);

  return JSON.parse(raw);
}

function isCdpResponse(value: unknown): value is {
  id: number;
  result?: unknown;
  error?: {
    message: string;
  };
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof (value as { id?: unknown }).id === "number"
  );
}

async function fetchJson(url: string): Promise<DevToolsResponse> {
  return fetch(url);
}

function toMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unexpected Chrome DevTools error.";
}

export function findSystemChromeExecutable(): string {
  const overridePath = process.env.RION_STUDIO_CHROME_PATH ?? process.env.CHROME_PATH;

  if (overridePath && existsSync(overridePath)) {
    return overridePath;
  }

  const candidates = getChromeCandidates();
  const executablePath = candidates.find((candidate) => existsSync(candidate));

  if (!executablePath) {
    throw new SystemChromeLauncherError(
      "SYSTEM_CHROME_NOT_FOUND",
      "Google Chrome was not found. Install Chrome or set RION_STUDIO_CHROME_PATH to the Chrome executable."
    );
  }

  return executablePath;
}

function getChromeCandidates(): string[] {
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      join(homedir(), "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome")
    ];
  }

  if (process.platform === "win32") {
    return [
      join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
      join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
      join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe")
    ].filter(Boolean);
  }

  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser"
  ];
}
