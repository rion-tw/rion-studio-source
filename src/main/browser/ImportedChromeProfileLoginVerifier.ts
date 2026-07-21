import { spawn, type ChildProcess } from "node:child_process";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Session } from "electron";

import type { Role } from "../../shared/types";
import { createLoginStorageSnapshot, LOGIN_STORAGE_EXPRESSION } from "../auth/loginEvidence";
import { waitForSettledAuthSession } from "../auth/settledAuthSession";
import type { SettledAuthSessionResult } from "../auth/settledAuthSession";
import type { RoleStore } from "../roles/RoleStore";
import {
  CdpClient,
  findSystemChromeExecutable,
  isExpectedPostLoginUrl,
  listDevToolsTargets,
  waitForDevToolsPort,
  type CdpClientLike,
  type DevToolsTarget
} from "../system-browser/SystemChromeLauncher";
import { createRoleSessionPartition } from "./BrowserManager";
import {
  completeImportedChromeProfileVerification,
  hasPendingImportedChromeProfile
} from "./ImportedChromeProfileMarker";

const DEVTOOLS_PORT_TIMEOUT_MS = 10_000;
const LOGIN_MONITOR_TIMEOUT_MS = 15 * 60_000;
const LOGIN_MONITOR_INTERVAL_MS = 500;
const SESSION_SETTLE_TIMEOUT_MS = 20_000;
const CHROME_CLOSE_TIMEOUT_MS = 5_000;

type CookieSession = Pick<Session, "cookies" | "flushStorageData">;

export class ImportedChromeProfileLoginCancelledError extends Error {
  constructor() {
    super("Chrome login window was closed before login was confirmed.");
    this.name = "ImportedChromeProfileLoginCancelledError";
  }
}

export class ImportedChromeProfileLoginRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportedChromeProfileLoginRetryableError";
  }
}

export interface ImportedChromeProfileLoginVerifierOptions {
  findExecutable?: () => string;
  getSession: (partition: string) => CookieSession;
  now?: () => number;
  resetEmbeddedSession: (partition: string) => Promise<void>;
  sleep?: (milliseconds: number) => Promise<void>;
  spawnChrome?: (executable: string, args: string[]) => ChildProcess;
  createCdpClient?: (target: DevToolsTarget) => CdpClientLike;
  listDevToolsTargets?: typeof listDevToolsTargets;
  waitForSettledAuthSession?: (
    readSample: () => Promise<{ finalUrl: string; snapshot: ReturnType<typeof createLoginStorageSnapshot> }>,
    options: { timeoutMs: number }
  ) => Promise<SettledAuthSessionResult>;
  waitForDevToolsPort?: typeof waitForDevToolsPort;
  roleStore: Pick<RoleStore, "getRolePaths">;
}

export class ImportedChromeProfileLoginVerifier {
  constructor(private readonly options: ImportedChromeProfileLoginVerifierOptions) {}

  async hasPendingVerification(roleId: string): Promise<boolean> {
    const browserUserDataDir = this.options.roleStore.getRolePaths(roleId).browserUserDataDir;
    return hasPendingImportedChromeProfile(browserUserDataDir);
  }

  async verify(role: Role): Promise<void> {
    const browserUserDataDir = this.options.roleStore.getRolePaths(role.id).browserUserDataDir;
    let executablePath: string;
    try {
      executablePath = (this.options.findExecutable ?? findSystemChromeExecutable)();
      await unlink(join(browserUserDataDir, "DevToolsActivePort")).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    } catch (error) {
      throw new ImportedChromeProfileLoginRetryableError(toMessage(error));
    }

    let child: ChildProcess;
    try {
      child = (this.options.spawnChrome ?? defaultSpawnChrome)(
        executablePath,
        buildImportedChromeProfileLoginArgs(role, browserUserDataDir)
      );
    } catch (error) {
      throw new ImportedChromeProfileLoginRetryableError(toMessage(error));
    }
    const lifecycle = createChildLifecycle(child);
    let hasSpawned = false;

    try {
      await lifecycle.spawned;
      hasSpawned = true;
      const cookies = await this.waitForConfirmedCookies(role, browserUserDataDir, lifecycle);
      await closeChromeAfterVerification(child, lifecycle);
      await this.synchronizeCookies(role, cookies);
    } catch (error) {
      const wasClosedBeforeFailure = lifecycle.isClosed();
      if (hasSpawned && !wasClosedBeforeFailure) {
        await terminateChromeAfterFailedVerification(child, lifecycle);
      }
      if (wasClosedBeforeFailure) {
        throw new ImportedChromeProfileLoginCancelledError();
      }
      if (error instanceof ImportedChromeProfileLoginCancelledError ||
        error instanceof ImportedChromeProfileLoginRetryableError) {
        throw error;
      }
      throw new ImportedChromeProfileLoginRetryableError(toMessage(error));
    }
  }

  async complete(roleId: string): Promise<void> {
    const browserUserDataDir = this.options.roleStore.getRolePaths(roleId).browserUserDataDir;
    await completeImportedChromeProfileVerification(browserUserDataDir);
  }

  private async waitForConfirmedCookies(
    role: Role,
    browserUserDataDir: string,
    lifecycle: ChildLifecycle
  ): Promise<Array<Record<string, unknown>>> {
    const waitForPort = this.options.waitForDevToolsPort ?? waitForDevToolsPort;
    const portResult = await waitForPort(browserUserDataDir, {
      isClosed: lifecycle.isClosed,
      timeoutMs: DEVTOOLS_PORT_TIMEOUT_MS
    });
    if (portResult.state === "closed") {
      throw new ImportedChromeProfileLoginCancelledError();
    }
    if (portResult.state !== "available") {
      throw new ImportedChromeProfileLoginRetryableError(
        "Unable to connect to the external Chrome login window."
      );
    }

    const now = this.options.now ?? Date.now;
    const sleep = this.options.sleep ?? ((milliseconds: number) => delay(milliseconds));
    const startedAt = now();
    const clients = new Map<string, CdpClientLike>();
    const listTargets = this.options.listDevToolsTargets ?? listDevToolsTargets;
    const createClient = this.options.createCdpClient ?? createDefaultCdpClient;
    const waitForSettled = this.options.waitForSettledAuthSession ?? waitForSettledAuthSession;

    try {
      while (!lifecycle.isClosed() && now() - startedAt <= LOGIN_MONITOR_TIMEOUT_MS) {
        const targets = await listTargets(portResult.port);
        const target = targets.find((candidate) =>
          (candidate.type === undefined || candidate.type === "page") &&
          isExpectedPostLoginUrl(candidate.url ?? "", role.launchUrl)
        );
        if (target) {
          const client = getOrCreateClient(target, clients, createClient);
          const settled = await waitForSettled(
            () => readChromeAuthSample(client, target.url ?? role.launchUrl, role.launchUrl),
            { timeoutMs: SESSION_SETTLE_TIMEOUT_MS }
          );
          if (settled.authState === "authenticated") {
            const result = await client.send<{ cookies?: unknown[] }>("Network.getCookies", {
              urls: [...new Set([role.launchUrl, target.url ?? role.launchUrl])]
            });
            const cookies = Array.isArray(result.cookies)
              ? result.cookies.filter(isRecord)
              : [];
            await client.send("Browser.close").catch(() => undefined);
            return cookies;
          }
        }
        await sleep(LOGIN_MONITOR_INTERVAL_MS);
      }
    } catch (error) {
      if (lifecycle.isClosed()) {
        throw new ImportedChromeProfileLoginCancelledError();
      }
      throw error;
    } finally {
      clients.forEach((client) => client.close());
    }

    if (lifecycle.isClosed()) {
      throw new ImportedChromeProfileLoginCancelledError();
    }
    throw new ImportedChromeProfileLoginRetryableError(
      "Timed out while waiting for the external Chrome login to complete."
    );
  }

  private async synchronizeCookies(role: Role, cookies: Array<Record<string, unknown>>): Promise<void> {
    const partition = createRoleSessionPartition(role.id);
    await this.options.resetEmbeddedSession(partition);
    const session = this.options.getSession(partition);

    for (const cookie of cookies) {
      await session.cookies.set(normalizeElectronCookie(cookie, role.launchUrl));
    }
    await session.flushStorageData();
  }
}

export function buildImportedChromeProfileLoginArgs(role: Role, browserUserDataDir: string): string[] {
  return [
    `--user-data-dir=${browserUserDataDir}`,
    "--profile-directory=Default",
    "--new-window",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    role.launchUrl
  ];
}

interface ChildLifecycle {
  closed: Promise<void>;
  isClosed: () => boolean;
  spawned: Promise<void>;
}

function createChildLifecycle(child: ChildProcess): ChildLifecycle {
  let closed = child.exitCode !== null || child.signalCode !== null;
  const closedPromise = new Promise<void>((resolve) => {
    if (closed) {
      resolve();
      return;
    }
    const finish = (): void => {
      closed = true;
      resolve();
    };
    child.once("close", finish);
  });
  const spawned = new Promise<void>((resolve, reject) => {
    if (closed) {
      reject(new ImportedChromeProfileLoginCancelledError());
      return;
    }
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  return { closed: closedPromise, isClosed: () => closed, spawned };
}

async function closeChromeAfterVerification(child: ChildProcess, lifecycle: ChildLifecycle): Promise<void> {
  if (lifecycle.isClosed()) return;
  await Promise.race([lifecycle.closed, delay(CHROME_CLOSE_TIMEOUT_MS)]);
  if (!lifecycle.isClosed()) {
    child.kill();
    await Promise.race([lifecycle.closed, delay(CHROME_CLOSE_TIMEOUT_MS)]);
  }
}

async function terminateChromeAfterFailedVerification(
  child: ChildProcess,
  lifecycle: ChildLifecycle
): Promise<void> {
  if (lifecycle.isClosed()) return;
  child.kill();
  await Promise.race([lifecycle.closed, delay(CHROME_CLOSE_TIMEOUT_MS)]);
}

function defaultSpawnChrome(executable: string, args: string[]): ChildProcess {
  return spawn(executable, args, { stdio: "ignore" });
}

function createDefaultCdpClient(target: DevToolsTarget): CdpClient {
  if (!target.webSocketDebuggerUrl) {
    throw new ImportedChromeProfileLoginRetryableError(
      "The external Chrome login window did not expose a DevTools connection."
    );
  }
  return new CdpClient(target.webSocketDebuggerUrl);
}

function getOrCreateClient(
  target: DevToolsTarget,
  clients: Map<string, CdpClientLike>,
  createClient: (target: DevToolsTarget) => CdpClientLike
): CdpClientLike {
  const existing = clients.get(target.id);
  if (existing) return existing;
  const client = createClient(target);
  clients.set(target.id, client);
  return client;
}

async function readChromeAuthSample(
  client: CdpClientLike,
  finalUrl: string,
  launchUrl: string
) {
  const [cookieResult, runtimeResult] = await Promise.all([
    client.send<{ cookies?: unknown[] }>("Network.getCookies", { urls: [launchUrl] }),
    client.send<{ result?: { value?: unknown } }>("Runtime.evaluate", {
      expression: LOGIN_STORAGE_EXPRESSION,
      returnByValue: true,
      awaitPromise: true
    })
  ]);
  return {
    finalUrl,
    snapshot: createLoginStorageSnapshot(cookieResult.cookies, runtimeResult.result?.value)
  };
}

function normalizeElectronCookie(
  cookie: Record<string, unknown>,
  fallbackUrl: string
): Parameters<Session["cookies"]["set"]>[0] {
  const domain = typeof cookie.domain === "string" ? cookie.domain : undefined;
  const name = typeof cookie.name === "string" ? cookie.name : "";
  const secure = typeof cookie.secure === "boolean" ? cookie.secure : undefined;
  const sameSite = normalizeElectronSameSite(cookie.sameSite);
  const expirationDate = getElectronCookieExpirationDate(cookie);
  return {
    url: createElectronCookieUrl(domain, cookie.path, secure, fallbackUrl),
    name,
    value: typeof cookie.value === "string" ? cookie.value : "",
    ...(domain?.startsWith(".") && !name.startsWith("__Host-") ? { domain } : {}),
    ...(typeof cookie.path === "string" && cookie.path.startsWith("/") ? { path: cookie.path } : {}),
    ...(expirationDate !== undefined ? { expirationDate } : {}),
    ...(typeof cookie.httpOnly === "boolean" ? { httpOnly: cookie.httpOnly } : {}),
    ...(secure !== undefined ? { secure } : {}),
    ...(sameSite ? { sameSite } : {})
  } as Parameters<Session["cookies"]["set"]>[0];
}

function getElectronCookieExpirationDate(cookie: Record<string, unknown>): number | undefined {
  const candidate = typeof cookie.expires === "number"
    ? cookie.expires
    : typeof cookie.expirationDate === "number"
      ? cookie.expirationDate
      : undefined;
  return candidate !== undefined && candidate >= 0 ? candidate : undefined;
}

function createElectronCookieUrl(
  domain: string | undefined,
  cookiePath: unknown,
  secure: boolean | undefined,
  fallbackUrl: string
): string {
  if (!domain) return fallbackUrl;
  const fallback = new URL(fallbackUrl);
  const host = domain.replace(/^\.+/, "");
  const protocol = secure === true || fallback.protocol === "https:" ? "https:" : "http:";
  const path = typeof cookiePath === "string" && cookiePath.startsWith("/") ? cookiePath : "/";
  return `${protocol}//${host}${path}`;
}

function normalizeElectronSameSite(value: unknown): "strict" | "lax" | "no_restriction" | "unspecified" | undefined {
  if (typeof value !== "string") return undefined;
  switch (value.toLowerCase()) {
    case "strict": return "strict";
    case "lax": return "lax";
    case "none":
    case "no_restriction": return "no_restriction";
    case "unset":
    case "unspecified": return "unspecified";
    default: return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unable to verify the imported Chrome profile.";
}
