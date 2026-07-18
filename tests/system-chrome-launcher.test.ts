import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";

import {
  buildSystemChromeArgs,
  CdpClient,
  closeDevToolsTarget,
  isExpectedPostLoginUrl,
  isLoginWindowLoginUrl,
  monitorLoginWindow,
  parseDevToolsActivePort,
  waitForDevToolsPort
} from "../src/main/system-browser/SystemChromeLauncher";
import type {
  CdpClientLike,
  CdpWebSocketConstructor,
  DevToolsResponse,
  DevToolsTarget
} from "../src/main/system-browser/SystemChromeLauncher";
import { isLoginStorageReady, type LoginStorageSnapshot } from "../src/main/auth/loginEvidence";
import type { Role } from "../src/shared/types";

const role: Role = {
  id: "role-1",
  gameId: "game-1",
  name: "Main",
  launchUrl: "https://example.com/play",
  windowWidth: 1280,
  windowHeight: 720,
  notes: "",
  authState: "login_required",
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z"
};

describe("SystemChromeLauncher", () => {
  it("builds a Google-safe human-login Chrome launch without automation flags", () => {
    const args = buildSystemChromeArgs(role, "/tmp/rion-studio/role-1/browser");

    expect(args).toEqual([
      "--user-data-dir=/tmp/rion-studio/role-1/browser",
      "--new-window",
      "https://example.com/play"
    ]);
    expect(args.some((arg) => arg.startsWith("--remote-debugging"))).toBe(false);
    expect(args.some((arg) => arg.startsWith("--app"))).toBe(false);
    expect(args.some((arg) => arg.startsWith("--disable"))).toBe(false);
  });

  it("parses the Chrome DevToolsActivePort file", () => {
    expect(parseDevToolsActivePort("49152\n/devtools/browser/test\n")).toBe(49152);
    expect(() => parseDevToolsActivePort("not-a-port\n/devtools/browser/test\n")).toThrow(
      "Chrome DevTools port file is invalid."
    );
  });

  it("detects login and post-login URLs", () => {
    expect(isLoginWindowLoginUrl("https://roles.google.com/signin/v2")).toBe(true);
    expect(isLoginWindowLoginUrl("https://www.facebook.com/dialog/oauth")).toBe(true);
    expect(isLoginWindowLoginUrl("https://example.com/play")).toBe(false);
    expect(isExpectedPostLoginUrl("https://example.com/play", role.launchUrl)).toBe(true);
    expect(isExpectedPostLoginUrl("https://roles.google.com/o/oauth2/v2/auth", role.launchUrl)).toBe(false);
    expect(isExpectedPostLoginUrl("https://other.example/play", role.launchUrl)).toBe(false);
  });

  it("waits for a DevTools port file", async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), "rion-devtools-port-test-"));
    await writeFile(join(userDataDir, "DevToolsActivePort"), "9222\n/devtools/browser/test\n");

    await expect(waitForDevToolsPort(userDataDir, { timeoutMs: 1_000 })).resolves.toEqual({
      state: "available",
      port: 9222
    });
  });

  it("returns unavailable when the DevTools port file never appears", async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), "rion-devtools-port-test-"));
    let now = 0;

    await expect(
      waitForDevToolsPort(userDataDir, {
        timeoutMs: 10,
        pollIntervalMs: 5,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        }
      })
    ).resolves.toMatchObject({
      state: "unavailable"
    });
  });

  it("matches CDP responses to requests", async () => {
    FakeWebSocket.reset();
    const client = new CdpClient("ws://devtools/page-1", {
      WebSocket: FakeWebSocket as unknown as CdpWebSocketConstructor,
      requestTimeoutMs: 50
    });
    const socket = FakeWebSocket.last();
    socket.open();

    const response = client.send<{ value: number }>("Runtime.evaluate", { expression: "1 + 1" });
    await vi.waitFor(() => {
      expect(socket.sent).toHaveLength(1);
    });
    const sent = JSON.parse(socket.sent[0]) as { id: number; method: string; params: unknown };
    socket.message({ id: sent.id, result: { value: 2 } });

    expect(sent).toMatchObject({
      method: "Runtime.evaluate",
      params: { expression: "1 + 1" }
    });
    await expect(response).resolves.toEqual({ value: 2 });
    client.close();
  });

  it("routes flattened CDP commands to an attached target session", async () => {
    FakeWebSocket.reset();
    const client = new CdpClient("ws://devtools/page-1", {
      WebSocket: FakeWebSocket as unknown as CdpWebSocketConstructor,
      requestTimeoutMs: 50
    });
    const socket = FakeWebSocket.last();
    socket.open();

    const response = client.send(
      "Emulation.setCPUThrottlingRate",
      { rate: 4 },
      undefined,
      "iframe-session"
    );
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    const sent = JSON.parse(socket.sent[0]) as { id: number; sessionId?: string };
    expect(sent.sessionId).toBe("iframe-session");
    socket.message({ id: sent.id, sessionId: "iframe-session", result: {} });

    await expect(response).resolves.toEqual({});
    client.close();
  });

  it("uses the bundled Node WebSocket transport when no global WebSocket exists", async () => {
    const host = "localhost";
    let server: WebSocketServer | undefined;

    try {
      server = new WebSocketServer({ host, port: 0 });
      await new Promise<void>((resolve, reject) => {
        server?.once("listening", resolve);
        server?.once("error", reject);
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        return;
      }
      throw error;
    }

    if (!server) {
      return;
    }

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Unable to determine the WebSocket test server port.");
    }

    server.on("connection", (socket) => {
      socket.once("message", (raw) => {
        const request = JSON.parse(raw.toString("utf8")) as { id: number };
        socket.send(JSON.stringify({ id: request.id, result: { value: 2 } }));
      });
    });

    vi.stubGlobal("WebSocket", undefined);
    const client = new CdpClient(`ws://${host}:${address.port}`, { requestTimeoutMs: 500 });
    const onDisconnect = vi.fn();
    client.onDisconnect(onDisconnect);

    try {
      await expect(client.send("Runtime.evaluate", { expression: "1 + 1" })).resolves.toEqual({ value: 2 });
      client.close();
      await vi.waitFor(() => expect(onDisconnect).toHaveBeenCalledTimes(1));
    } finally {
      client.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      vi.unstubAllGlobals();
    }
  });

  it("parses typed-array CDP messages without surrounding buffer bytes", async () => {
    FakeWebSocket.reset();
    const client = new CdpClient("ws://devtools/page-1", {
      WebSocket: FakeWebSocket as unknown as CdpWebSocketConstructor,
      requestTimeoutMs: 50
    });
    const socket = FakeWebSocket.last();
    socket.open();

    const response = client.send("Runtime.evaluate");
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    const request = JSON.parse(socket.sent[0]) as { id: number };
    const payload = JSON.stringify({ id: request.id, result: { value: "ok" } });
    const framedPayload = Buffer.from(`prefix${payload}suffix`);
    socket.messageData(
      new Uint8Array(framedPayload.buffer, framedPayload.byteOffset + "prefix".length, Buffer.byteLength(payload))
    );

    await expect(response).resolves.toEqual({ value: "ok" });
    client.close();
  });

  it("rejects pending CDP requests when the socket closes", async () => {
    FakeWebSocket.reset();
    const client = new CdpClient("ws://devtools/page-1", {
      WebSocket: FakeWebSocket as unknown as CdpWebSocketConstructor,
      requestTimeoutMs: 50
    });
    const socket = FakeWebSocket.last();
    socket.open();

    const response = client.send("Runtime.evaluate", { expression: "1 + 1" });
    await vi.waitFor(() => {
      expect(socket.sent).toHaveLength(1);
    });
    socket.close();

    await expect(response).rejects.toThrow("Chrome DevTools WebSocket closed.");
  });

  it("times out CDP requests without a response", async () => {
    FakeWebSocket.reset();
    const client = new CdpClient("ws://devtools/page-1", {
      WebSocket: FakeWebSocket as unknown as CdpWebSocketConstructor,
      requestTimeoutMs: 1
    });
    const socket = FakeWebSocket.last();
    socket.open();

    await expect(client.send("Runtime.evaluate", { expression: "1 + 1" })).rejects.toThrow(
      "Chrome DevTools request timed out: Runtime.evaluate"
    );
    client.close();
  });

  it("detects completed login only after localStorage writes an auth token", async () => {
    const userDataDir = await createUserDataDirWithDevToolsPort();
    let now = 0;
    const client = new SnapshotCdpClient([
      createStorageSnapshot(),
      createStorageSnapshot({ localStorage: { authToken: "token-1" } })
    ]);

    await expect(
      monitorLoginWindow(role, userDataDir, {
        fetch: createTargetFetch([
          [createTarget("https://www.facebook.com/dialog/oauth")],
          [createTarget(role.launchUrl)],
          [createTarget(role.launchUrl)]
        ]),
        createCdpClient: () => client,
        monitorTimeoutMs: 30,
        storageReadyTimeoutMs: 20,
        pollIntervalMs: 5,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        }
      })
    ).resolves.toEqual({
      state: "login_completed",
      port: 9222,
      targetId: "target-1",
      url: role.launchUrl
    });
    expect(client.closed).toBe(true);
  });

  it("does not complete after Facebook returns to the launch origin without storage changes", async () => {
    const userDataDir = await createUserDataDirWithDevToolsPort();
    let now = 0;

    await expect(
      monitorLoginWindow(role, userDataDir, {
        fetch: createTargetFetch([
          [createTarget("https://www.facebook.com/dialog/oauth")],
          [createTarget(role.launchUrl)]
        ]),
        createCdpClient: () => new SnapshotCdpClient([createStorageSnapshot()]),
        monitorTimeoutMs: 30,
        storageReadyTimeoutMs: 10,
        pollIntervalMs: 5,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        }
      })
    ).resolves.toMatchObject({
      state: "timed_out",
      message: "Timed out while waiting for login storage to be ready: storage_not_ready"
    });
  });

  it("does not turn the first post-login target snapshot into a baseline", async () => {
    const userDataDir = await createUserDataDirWithDevToolsPort();
    let now = 0;
    const client = new SnapshotCdpClient([createStorageSnapshot({ cookies: { app_state: "ready" } })]);

    await expect(
      monitorLoginWindow(role, userDataDir, {
        fetch: createTargetFetch([[createTarget("https://www.facebook.com/dialog/oauth")], [createTarget(role.launchUrl)]]),
        createCdpClient: () => client,
        monitorTimeoutMs: 30,
        storageReadyTimeoutMs: 10,
        pollIntervalMs: 5,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        }
      })
    ).resolves.toMatchObject({
      state: "login_completed"
    });
  });

  it("detects completed login after a session cookie is written", async () => {
    const userDataDir = await createUserDataDirWithDevToolsPort();
    let now = 0;
    const client = new SnapshotCdpClient([
      createStorageSnapshot(),
      createStorageSnapshot({ cookies: { sid: "session-1" } })
    ]);

    await expect(
      monitorLoginWindow(role, userDataDir, {
        fetch: createTargetFetch([
          [createTarget("https://roles.google.com/signin/v2")],
          [createTarget(role.launchUrl)],
          [createTarget(role.launchUrl)]
        ]),
        createCdpClient: () => client,
        monitorTimeoutMs: 30,
        storageReadyTimeoutMs: 20,
        pollIntervalMs: 5,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        }
      })
    ).resolves.toMatchObject({
      state: "login_completed"
    });
  });

  it("detects same-origin credential login after storage is ready", async () => {
    const userDataDir = await createUserDataDirWithDevToolsPort();
    let now = 0;
    const client = new SnapshotCdpClient([createStorageSnapshot({ localStorage: { authToken: "token-1" } })]);

    await expect(
      monitorLoginWindow(role, userDataDir, {
        fetch: createTargetFetch([[createTarget("https://example.com/login")], [createTarget(role.launchUrl)]]),
        createCdpClient: () => client,
        monitorTimeoutMs: 30,
        storageReadyTimeoutMs: 10,
        pollIntervalMs: 5,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        }
      })
    ).resolves.toMatchObject({
      state: "login_completed"
    });
  });

  it("detects external OAuth login after storage is ready", async () => {
    const userDataDir = await createUserDataDirWithDevToolsPort();
    let now = 0;
    const client = new SnapshotCdpClient([createStorageSnapshot({ localStorage: { authToken: "token-1" } })]);

    await expect(
      monitorLoginWindow(role, userDataDir, {
        fetch: createTargetFetch([[createTarget("https://login.example.com/oauth")], [createTarget(role.launchUrl)]]),
        createCdpClient: () => client,
        monitorTimeoutMs: 30,
        storageReadyTimeoutMs: 10,
        pollIntervalMs: 5,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        }
      })
    ).resolves.toMatchObject({
      state: "login_completed"
    });
  });

  it("detects completed login after IndexedDB changes", async () => {
    expect(
      isLoginStorageReady(
        createStorageSnapshot(),
        createStorageSnapshot({
          indexedDb: {
            app_state_fingerprint: "v1:ready:1:fingerprint"
          }
        })
      )
    ).toEqual({
      ready: true,
      reason: "non_tracking_storage_changed"
    });
  });

  it("ignores tracking-only storage changes", () => {
    expect(
      isLoginStorageReady(
        createStorageSnapshot(),
        createStorageSnapshot({
          cookies: { _ga: "GA1.1.test" },
          indexedDb: { _fbp: "tracking-fingerprint" }
        })
      )
    ).toEqual({
      ready: false,
      reason: "storage_not_ready"
    });
  });

  it("does not complete while login prompts are still visible", () => {
    expect(
      isLoginStorageReady(
        createStorageSnapshot(),
        createStorageSnapshot({
          localStorage: { authToken: "token-1" },
          bodyText: "Continue with Facebook"
        })
      )
    ).toEqual({
      ready: false,
      reason: "login_prompt_visible"
    });
  });

  it("closes a DevTools target through the Chrome close endpoint", async () => {
    const fetchDevTools = vi.fn().mockResolvedValue(jsonResponse("Target is closing"));

    await closeDevToolsTarget(9222, "target-1", fetchDevTools);

    expect(fetchDevTools).toHaveBeenCalledWith("http://127.0.0.1:9222/json/close/target-1");
  });
});

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  readonly sent: string[] = [];
  readyState = 0;
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  static reset(): void {
    FakeWebSocket.instances = [];
  }

  static last(): FakeWebSocket {
    const socket = FakeWebSocket.instances.at(-1);

    if (!socket) {
      throw new Error("No fake WebSocket was created.");
    }

    return socket;
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.dispatch("close", {});
  }

  open(): void {
    this.readyState = 1;
    this.dispatch("open", {});
  }

  message(payload: unknown): void {
    this.dispatch("message", { data: JSON.stringify(payload) });
  }

  messageData(data: unknown): void {
    this.dispatch("message", { data });
  }

  private dispatch(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

class SnapshotCdpClient implements CdpClientLike {
  closed = false;
  private readIndex = 0;
  private currentSnapshot: LoginStorageSnapshot | undefined;

  constructor(private readonly snapshots: LoginStorageSnapshot[]) {}

  async send<T>(method: string): Promise<T> {
    const snapshot = this.currentSnapshot ?? this.readNextSnapshot();
    this.currentSnapshot = snapshot;

    if (method === "Network.getCookies") {
      return {
        cookies: Object.entries(snapshot.cookies).map(([name, value]) => ({ name, value }))
      } as T;
    }

    if (method === "Runtime.evaluate") {
      this.currentSnapshot = undefined;
      return {
        result: {
          value: {
            localStorage: snapshot.localStorage,
            sessionStorage: snapshot.sessionStorage,
            indexedDb: snapshot.indexedDb,
            bodyText: snapshot.bodyText
          }
        }
      } as T;
    }

    throw new Error(`Unexpected CDP method: ${method}`);
  }

  close(): void {
    this.closed = true;
  }

  private readNextSnapshot(): LoginStorageSnapshot {
    const snapshot = this.snapshots[Math.min(this.readIndex, this.snapshots.length - 1)];
    this.readIndex += 1;
    return snapshot;
  }
}

async function createUserDataDirWithDevToolsPort(): Promise<string> {
  const userDataDir = await mkdtemp(join(tmpdir(), "rion-login-monitor-test-"));
  await writeFile(join(userDataDir, "DevToolsActivePort"), "9222\n/devtools/browser/test\n");
  return userDataDir;
}

function createTarget(url: string): DevToolsTarget {
  return {
    id: "target-1",
    type: "page",
    url,
    webSocketDebuggerUrl: "ws://devtools/page-1"
  };
}

function createTargetFetch(targetsByCall: DevToolsTarget[][]): (url: string) => Promise<DevToolsResponse> {
  let callIndex = 0;

  return vi.fn(async () => {
    const targets = targetsByCall[Math.min(callIndex, targetsByCall.length - 1)];
    callIndex += 1;
    return jsonResponse(targets);
  });
}

function createStorageSnapshot(overrides: Partial<LoginStorageSnapshot> = {}): LoginStorageSnapshot {
  return {
    cookies: {},
    localStorage: {},
    sessionStorage: {},
    indexedDb: {},
    bodyText: "",
    ...overrides
  };
}

function jsonResponse(payload: unknown, ok = true): DevToolsResponse {
  return {
    ok,
    json: async () => payload
  };
}
