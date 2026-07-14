import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { unlink } from "node:fs/promises";
import { join } from "node:path";

import type { RoleStore } from "../roles/RoleStore";
import {
  CDN_COMPATIBILITY_EXTERNAL_NOTICE,
  CDN_COMPATIBILITY_UNAVAILABLE_NOTICE
} from "../game-browser/CdnCompatibilityManager";
import { findSystemChromeExecutable } from "../system-browser/SystemChromeLauncher";
import type { NormalizedRect, PixelBounds, Role, RoleStatus } from "../../shared/types";
import {
  connectExternalChromeAutomation,
  type ExternalBrowserAutomationTarget
} from "./ExternalChromeAutomationTarget";

export interface ExternalChromeManagerEvents {
  change: [RoleStatus[]];
}

export interface ExternalChromeLaunchItem {
  rect: NormalizedRect;
  role: Role;
}

export interface ExternalChromeLaunchOptions {
  notice?: string;
}

export interface ExternalChromeManagerOptions {
  applyBrowserFonts?: (role: Role, browserUserDataDir: string) => Promise<void>;
  prepareCdnCompatibility?: (
    role: Role,
    browserUserDataDir: string
  ) => Promise<{ enabled: boolean; extensionPath?: string; proxyServer?: string }>;
  findExecutable?: () => string;
  getLaunchWorkArea: () => PixelBounds;
  spawnChrome?: (executablePath: string, args: string[]) => ChildProcess;
  connectAutomation?: (browserUserDataDir: string, launchUrl: string) => Promise<ExternalBrowserAutomationTarget>;
}

export type ExternalMacroOverlayInstaller = (
  role: Role,
  target: ExternalBrowserAutomationTarget
) => Promise<void>;

interface ExternalChromeSession {
  automationTarget?: ExternalBrowserAutomationTarget;
  child: ChildProcess;
  launchedAt?: string;
  notice?: string;
  role: Role;
  state: RoleStatus["state"];
  workspaceId?: string;
}

export class ExternalChromeRoleAlreadyRunningError extends Error {
  readonly code = "ROLE_ALREADY_RUNNING";

  constructor(roles: Role[]) {
    super(`Already running in another game window: ${roles.map((role) => role.name).join(", ")}.`);
    this.name = "ExternalChromeRoleAlreadyRunningError";
  }
}

export class ExternalChromeManager extends EventEmitter<ExternalChromeManagerEvents> {
  private readonly sessions = new Map<string, ExternalChromeSession>();
  private beforeRoleStop?: (roleId: string) => Promise<void>;
  private macroOverlayInstaller?: ExternalMacroOverlayInstaller;

  constructor(
    private readonly roleStore: Pick<RoleStore, "ensureBrowserUserDataDir">,
    private readonly options: ExternalChromeManagerOptions
  ) {
    super();
  }

  hasSession(roleId: string): boolean {
    return this.sessions.has(roleId);
  }

  setBeforeRoleStop(handler: (roleId: string) => Promise<void>): void {
    this.beforeRoleStop = handler;
  }

  setMacroOverlayInstaller(installer: ExternalMacroOverlayInstaller): void {
    this.macroOverlayInstaller = installer;
  }

  getAutomationSession(roleId: string): { role: Role; target: ExternalBrowserAutomationTarget } | undefined {
    const session = this.sessions.get(roleId);
    if (session?.state !== "running" || !session.automationTarget) {
      return undefined;
    }
    return { role: session.role, target: session.automationTarget };
  }

  listStatuses(): RoleStatus[] {
    return [...this.sessions.entries()].map(([roleId, session]) => this.toStatus(roleId, session));
  }

  async launch(role: Role, options: ExternalChromeLaunchOptions = {}): Promise<RoleStatus> {
    const existing = this.sessions.get(role.id);
    if (existing) {
      existing.role = role;
      existing.notice = options.notice ?? existing.notice;
      return this.toStatus(role.id, existing);
    }

    const workArea = this.options.getLaunchWorkArea();
    const width = Math.min(role.windowWidth, workArea.width);
    const height = Math.min(role.windowHeight, workArea.height);
    const bounds = {
      x: workArea.x,
      y: workArea.y,
      width,
      height
    };
    const session = await this.launchSession(role, bounds, undefined, options.notice);
    return this.toStatus(role.id, session);
  }

  async launchWorkspace(
    workspace: { id: string },
    items: ExternalChromeLaunchItem[],
    options: ExternalChromeLaunchOptions = {}
  ): Promise<RoleStatus[]> {
    const runningRoles = items.map((item) => item.role).filter((role) => this.sessions.has(role.id));
    if (runningRoles.length > 0) {
      throw new ExternalChromeRoleAlreadyRunningError(runningRoles);
    }

    const workArea = this.options.getLaunchWorkArea();
    const sessions: Array<{ roleId: string; session: ExternalChromeSession }> = [];

    try {
      for (const item of items) {
        const bounds = normalizedRectToPixelBounds(item.rect, workArea);
        const session = await this.launchSession(item.role, bounds, workspace.id, options.notice);
        sessions.push({ roleId: item.role.id, session });
      }

      return sessions.map(({ roleId, session }) => this.toStatus(roleId, session));
    } catch (error) {
      await Promise.all(sessions.map(({ roleId }) => this.stop(roleId)));
      throw error;
    }
  }

  async stop(roleId: string): Promise<void> {
    const session = this.sessions.get(roleId);
    if (!session) {
      return;
    }

    session.state = "stopping";
    this.emitChange();
    await this.beforeRoleStop?.(roleId);
    this.sessions.delete(roleId);
    const target = session.automationTarget;
    session.automationTarget = undefined;
    target?.close();
    terminateChild(session.child);
    this.emitChange();
  }

  async stopWorkspace(workspaceId: string): Promise<void> {
    const roleIds = [...this.sessions.entries()]
      .filter(([, session]) => session.workspaceId === workspaceId)
      .map(([roleId]) => roleId);
    await Promise.all(roleIds.map((roleId) => this.stop(roleId)));
  }

  private async launchSession(
    role: Role,
    bounds: PixelBounds,
    workspaceId: string | undefined,
    notice: string | undefined
  ): Promise<ExternalChromeSession> {
    const executablePath = (this.options.findExecutable ?? findSystemChromeExecutable)();
    const browserUserDataDir = await this.roleStore.ensureBrowserUserDataDir(role.id);
    await removeStaleDevToolsPort(browserUserDataDir);
    await this.options.applyBrowserFonts?.(role, browserUserDataDir).catch((error) => {
      console.warn("Failed to apply browser font settings before opening external Chrome.", error);
    });
    let extensionPath: string | undefined;
    let proxyServer: string | undefined;
    let sessionNotice = notice;
    try {
      const compatibility = await this.options.prepareCdnCompatibility?.(role, browserUserDataDir);
      extensionPath = compatibility?.extensionPath;
      proxyServer = compatibility?.proxyServer;
      if (compatibility?.enabled && !sessionNotice) {
        sessionNotice = CDN_COMPATIBILITY_EXTERNAL_NOTICE;
      }
    } catch (error) {
      console.warn("Failed to prepare CDN compatibility mode for external Chrome.", error);
      if (!sessionNotice) {
        sessionNotice = CDN_COMPATIBILITY_UNAVAILABLE_NOTICE;
      }
    }
    const child = (this.options.spawnChrome ?? spawnChrome)(
      executablePath,
      buildExternalChromeArgs(role, browserUserDataDir, bounds, extensionPath, proxyServer)
    );
    const session: ExternalChromeSession = {
      child,
      notice: sessionNotice,
      role,
      state: "launching",
      workspaceId
    };
    this.sessions.set(role.id, session);
    this.emitChange();

    try {
      await waitForSpawn(child);
    } catch (error) {
      this.sessions.delete(role.id);
      this.emitChange();
      throw error;
    }

    child.once("close", () => this.deleteSession(role.id, session));
    child.once("error", () => this.deleteSession(role.id, session));

    try {
      const target = await (this.options.connectAutomation ?? connectExternalChromeAutomation)(
        browserUserDataDir,
        role.launchUrl
      );
      if (this.sessions.get(role.id) !== session) {
        target.close();
        throw new Error("External Chrome closed before macro control connected.");
      }
      session.automationTarget = target;
      target.onDisconnect(() => this.handleAutomationDisconnect(role.id, session, target));
      await this.macroOverlayInstaller?.(role, target).catch((error) => {
        console.warn("Failed to install the macro overlay in external Chrome.", error);
      });
    } catch (error) {
      if (this.sessions.get(role.id) !== session) {
        throw error;
      }
      console.warn("External Chrome macro automation is unavailable.", error);
      session.notice = appendNotice(session.notice, EXTERNAL_AUTOMATION_UNAVAILABLE_NOTICE);
    }

    session.state = "running";
    session.launchedAt = new Date().toISOString();
    this.emitChange();
    return session;
  }

  private handleAutomationDisconnect(
    roleId: string,
    session: ExternalChromeSession,
    target: ExternalBrowserAutomationTarget
  ): void {
    if (this.sessions.get(roleId) !== session || session.automationTarget !== target) {
      return;
    }
    session.automationTarget = undefined;
    session.notice = appendNotice(session.notice, EXTERNAL_AUTOMATION_UNAVAILABLE_NOTICE);
    void this.beforeRoleStop?.(roleId);
    this.emitChange();
  }

  private deleteSession(roleId: string, session: ExternalChromeSession): void {
    if (this.sessions.get(roleId) !== session) {
      return;
    }

    this.sessions.delete(roleId);
    const target = session.automationTarget;
    session.automationTarget = undefined;
    target?.close();
    void this.beforeRoleStop?.(roleId);
    this.emitChange();
  }

  private emitChange(): void {
    this.emit("change", this.listStatuses());
  }

  private toStatus(roleId: string, session: ExternalChromeSession): RoleStatus {
    return {
      roleId,
      state: session.state,
      launchedAt: session.launchedAt,
      notice: session.notice,
      runtimeMode: "external",
      ...(session.state === "running"
        ? { automationState: session.automationTarget ? "ready" as const : "unavailable" as const }
        : {})
    };
  }
}

export function buildExternalChromeArgs(
  role: Role,
  browserUserDataDir: string,
  bounds: PixelBounds,
  extensionPath?: string,
  proxyServer?: string
): string[] {
  return [
    `--user-data-dir=${browserUserDataDir}`,
    `--app=${role.launchUrl}`,
    `--window-position=${bounds.x},${bounds.y}`,
    `--window-size=${bounds.width},${bounds.height}`,
    "--no-first-run",
    "--disable-default-apps",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    ...(proxyServer ? [`--proxy-server=${proxyServer}`] : []),
    ...(extensionPath ? [`--load-extension=${extensionPath}`] : [])
  ];
}

const EXTERNAL_AUTOMATION_UNAVAILABLE_NOTICE =
  "Macro control could not connect to compatibility mode. Restart this role to try again.";

async function removeStaleDevToolsPort(browserUserDataDir: string): Promise<void> {
  await unlink(join(browserUserDataDir, "DevToolsActivePort")).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") {
      throw error;
    }
  });
}

function appendNotice(current: string | undefined, next: string): string {
  if (!current) return next;
  if (current.includes(next)) return current;
  return `${current} ${next}`;
}

function spawnChrome(executablePath: string, args: string[]): ChildProcess {
  return spawn(executablePath, args, { stdio: "ignore" });
}

function waitForSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}

function terminateChild(child: ChildProcess): void {
  if (child.killed || child.exitCode !== null) {
    return;
  }

  child.kill();
}

function normalizedRectToPixelBounds(rect: NormalizedRect, contentBounds: PixelBounds): PixelBounds {
  const left = Math.round(rect.x * contentBounds.width);
  const top = Math.round(rect.y * contentBounds.height);
  const right = Math.round((rect.x + rect.width) * contentBounds.width);
  const bottom = Math.round((rect.y + rect.height) * contentBounds.height);

  return {
    x: contentBounds.x + left,
    y: contentBounds.y + top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top)
  };
}
