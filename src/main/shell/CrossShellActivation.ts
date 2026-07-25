import { randomBytes, randomUUID } from "node:crypto";
import { chmod, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import { join } from "node:path";

const ACTIVATION_ENDPOINT_FILE = "rion-studio.activation.json";
const MAX_ACTIVATION_MESSAGE_BYTES = 16 * 1024;
const ACTIVATION_TIMEOUT_MS = 1_500;

interface ActivationEndpointRecord {
  host: "127.0.0.1";
  pid: number;
  port: number;
  token: string;
  version: 1;
}

export interface CrossShellActivationServer {
  close: () => Promise<void>;
}

function endpointPath(userDataDir: string): string {
  return join(userDataDir, ACTIVATION_ENDPOINT_FILE);
}

function isEndpointRecord(value: unknown): value is ActivationEndpointRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ActivationEndpointRecord>;
  return record.version === 1 &&
    record.host === "127.0.0.1" &&
    Number.isInteger(record.pid) &&
    Number.isInteger(record.port) &&
    (record.port ?? 0) > 0 &&
    (record.port ?? 0) <= 65_535 &&
    typeof record.token === "string" &&
    /^[a-f0-9]{64}$/.test(record.token);
}

export async function createCrossShellActivationServer(
  userDataDir: string,
  onActivate: () => void
): Promise<CrossShellActivationServer> {
  const token = randomBytes(32).toString("hex");
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.setTimeout(ACTIVATION_TIMEOUT_MS);
    let body = "";
    socket.on("data", (chunk: string) => {
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > MAX_ACTIVATION_MESSAGE_BYTES) {
        socket.destroy();
        return;
      }
      const newline = body.indexOf("\n");
      if (newline < 0) return;
      const raw = body.slice(0, newline);
      body = "";
      try {
        const request = JSON.parse(raw) as { operation?: unknown; token?: unknown };
        if (request.operation !== "activate" || request.token !== token) {
          socket.end('{"ok":false}\n');
          return;
        }
        onActivate();
        socket.end('{"ok":true}\n');
      } catch {
        socket.end('{"ok":false}\n');
      }
    });
  });
  await listenOnLoopback(server);
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Cross-shell activation server did not bind a TCP port.");
  }
  const record: ActivationEndpointRecord = {
    host: "127.0.0.1",
    pid: process.pid,
    port: address.port,
    token,
    version: 1
  };
  const path = endpointPath(userDataDir);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(record), { encoding: "utf8", mode: 0o600 });
  await chmod(temporaryPath, 0o600).catch(() => undefined);
  await rename(temporaryPath, path);

  let closed = false;
  return {
    close: async () => {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      const current = await readEndpoint(path).catch(() => undefined);
      if (current?.token === token) {
        await unlink(path).catch(() => undefined);
      }
    }
  };
}

export async function forwardActivationToRunningShell(
  userDataDir: string
): Promise<boolean> {
  const record = await readEndpoint(endpointPath(userDataDir)).catch(() => undefined);
  if (!record) return false;
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: record.host, port: record.port });
    let settled = false;
    let response = "";
    const finish = (forwarded: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(forwarded);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(ACTIVATION_TIMEOUT_MS);
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ operation: "activate", token: record.token })}\n`);
    });
    socket.on("data", (chunk: string) => {
      response += chunk;
      if (Buffer.byteLength(response, "utf8") > MAX_ACTIVATION_MESSAGE_BYTES) {
        finish(false);
        return;
      }
      const newline = response.indexOf("\n");
      if (newline < 0) return;
      try {
        finish(JSON.parse(response.slice(0, newline))?.ok === true);
      } catch {
        finish(false);
      }
    });
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
    socket.once("close", () => finish(false));
  });
}

function listenOnLoopback(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen({ exclusive: true, host: "127.0.0.1", port: 0 }, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

async function readEndpoint(path: string): Promise<ActivationEndpointRecord | undefined> {
  const raw = await readFile(path, "utf8");
  if (Buffer.byteLength(raw, "utf8") > MAX_ACTIVATION_MESSAGE_BYTES) return undefined;
  const parsed: unknown = JSON.parse(raw);
  return isEndpointRecord(parsed) ? parsed : undefined;
}
