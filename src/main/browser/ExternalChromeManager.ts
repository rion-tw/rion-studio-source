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
import {
  BROWSER_BACKGROUND_FEATURES_TO_DISABLE,
  BROWSER_BASE_SWITCHES,
  getGraphicsModeSwitches
} from "../../shared/browserGraphics";
import type {
  BrowserGraphicsMode,
  NormalizedRect,
  PixelBounds,
  Role,
  RoleStatus,
  WorkspaceBrowserZoomMode,
  WorkspaceResourcePolicy
} from "../../shared/types";
import { normalizeWorkspaceRectEdges } from "../../shared/workspaceLayout";
import {
  connectExternalChromeAutomation,
  type ConnectExternalChromeAutomationOptions,
  type ExternalBrowserAutomationTarget
} from "./ExternalChromeAutomationTarget";
import type { ExternalChromeWindowBoundsAdapter } from "./WindowsExternalChromeWindowBoundsAdapter";
import type {
  BrowserWorkspaceRuntimeState,
  BrowserWorkspaceRuntimeStatus
} from "./BrowserManager";

export interface ExternalChromeManagerEvents {
  change: [RoleStatus[]];
}

export interface ExternalChromeLaunchItem {
  rect: NormalizedRect;
  role: Role;
}

export interface ExternalChromeLaunchOptions {
  notice?: string;
  workArea?: PixelBounds;
  zoomMode?: WorkspaceBrowserZoomMode;
  zoomFactor?: number;
}

export interface ExternalChromeManagerOptions {
  applyBrowserFonts?: (role: Role, browserUserDataDir: string) => Promise<void>;
  prepareCdnCompatibility?: (
    role: Role,
    browserUserDataDir: string
  ) => Promise<{ enabled: boolean; proxyServer?: string }>;
  findExecutable?: () => string;
  getLaunchWorkArea: () => PixelBounds;
  graphicsMode?: BrowserGraphicsMode;
  platform?: NodeJS.Platform;
  windowBoundsAdapter?: ExternalChromeWindowBoundsAdapter;
  spawnChrome?: (executablePath: string, args: string[]) => ChildProcess;
  connectAutomation?: (
    browserUserDataDir: string,
    launchUrl: string,
    options?: Pick<ConnectExternalChromeAutomationOptions, "cdnCompatibilityEnabled">
  ) => Promise<ExternalBrowserAutomationTarget>;
}

export type ExternalMacroOverlayInstaller = (
  role: Role,
  target: ExternalBrowserAutomationTarget
) => Promise<void>;

interface ExternalChromeSession {
  automationTarget?: ExternalBrowserAutomationTarget;
  cdnCompatibilityActive: boolean;
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

  hasWorkspace(workspaceId: string): boolean {
    return [...this.sessions.values()].some((session) => session.workspaceId === workspaceId);
  }

  listWorkspaceRuntimeStatuses(): BrowserWorkspaceRuntimeStatus[] {
    const stateByWorkspaceId = new Map<string, BrowserWorkspaceRuntimeState>();
    this.sessions.forEach((session) => {
      if (!session.workspaceId) {
        return;
      }

      const current = stateByWorkspaceId.get(session.workspaceId);
      if (session.state === "stopping" || current === undefined) {
        stateByWorkspaceId.set(session.workspaceId, session.state);
      } else if (session.state === "launching" && current === "running") {
        stateByWorkspaceId.set(session.workspaceId, "launching");
      }
    });

    return [...stateByWorkspaceId].map(([workspaceId, state]) => ({ workspaceId, state }));
  }

  async launch(role: Role, options: ExternalChromeLaunchOptions = {}): Promise<RoleStatus> {
    const existing = this.sessions.get(role.id);
    if (existing) {
      existing.role = role;
      existing.notice = options.notice ?? existing.notice;
      if (existing.automationTarget) {
        await this.applyZoom(
          existing,
          existing.automationTarget,
          options.zoomMode ?? "fixed",
          options.zoomFactor ?? 1
        );
      }
      return this.toStatus(role.id, existing);
    }

    const workArea = options.workArea ?? this.options.getLaunchWorkArea();
    const width = Math.min(role.windowWidth, workArea.width);
    const height = Math.min(role.windowHeight, workArea.height);
    const bounds = {
      x: workArea.x,
      y: workArea.y,
      width,
      height
    };
    const physicalBounds = this.toPhysicalBounds(bounds);
    const session = await this.launchSession(
      role,
      bounds,
      physicalBounds,
      undefined,
      options.notice,
      options.zoomMode ?? "fixed",
      options.zoomFactor ?? 1
    );
    return this.toStatus(role.id, session);
  }

  async launchWorkspace(
    workspace: { id: string; resourcePolicy?: WorkspaceResourcePolicy },
    items: ExternalChromeLaunchItem[],
    options: ExternalChromeLaunchOptions = {}
  ): Promise<RoleStatus[]> {
    const runningRoles = items.map((item) => item.role).filter((role) => this.sessions.has(role.id));
    if (runningRoles.length > 0) {
      throw new ExternalChromeRoleAlreadyRunningError(runningRoles);
    }

    const workArea = options.workArea ?? this.options.getLaunchWorkArea();
    const physicalWorkArea = this.toPhysicalBounds(workArea);
    // External Chrome always tiles the complete work area; appearance gaps apply only to embedded hosts.
    const normalizedRects = normalizeWorkspaceRectEdges(items.map((item) => item.rect));
    const dipBounds = createSeamlessWorkspaceBounds(
      normalizedRects.map((rect) => normalizedRectToPixelBounds(rect, workArea)),
      externalChromeSeamOverlap(this.options.platform ?? process.platform)
    );
    const physicalBounds = physicalWorkArea
      ? createSeamlessWorkspaceBounds(
          normalizedRects.map((rect) => normalizedRectToPixelBounds(rect, physicalWorkArea)),
          WINDOWS_PHYSICAL_SEAM_OVERLAP
        )
      : undefined;
    const sessions: Array<{ roleId: string; session: ExternalChromeSession }> = [];

    try {
      const primaryRoleId = workspace.resourcePolicy?.primaryRoleId ?? items[0]?.role.id;
      const launchIndexes = items.map((_item, index) => index).sort((left, right) => {
        if (items[left].role.id === primaryRoleId) return -1;
        if (items[right].role.id === primaryRoleId) return 1;
        return left - right;
      });
      for (const index of launchIndexes) {
        const item = items[index];
        const session = await this.launchSession(
          item.role,
          dipBounds[index],
          physicalBounds?.[index],
          workspace.id,
          options.notice,
          options.zoomMode ?? "fixed",
          options.zoomFactor ?? 1
        );
        sessions.push({ roleId: item.role.id, session });
      }

      const sessionByRoleId = new Map(sessions.map(({ roleId, session }) => [roleId, session]));
      return items.map(({ role }) => this.toStatus(role.id, sessionByRoleId.get(role.id)!));
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
    physicalBounds: PixelBounds | undefined,
    workspaceId: string | undefined,
    notice: string | undefined,
    zoomMode: WorkspaceBrowserZoomMode,
    zoomFactor: number
  ): Promise<ExternalChromeSession> {
    const executablePath = (this.options.findExecutable ?? findSystemChromeExecutable)();
    const browserUserDataDir = await this.roleStore.ensureBrowserUserDataDir(role.id);
    await removeStaleDevToolsPort(browserUserDataDir);
    await this.options.applyBrowserFonts?.(role, browserUserDataDir).catch((error) => {
      console.warn("Failed to apply browser font settings before opening external Chrome.", error);
    });
    let cdnCompatibilityRequested = false;
    let proxyServer: string | undefined;
    let sessionNotice = notice;
    try {
      const compatibility = await this.options.prepareCdnCompatibility?.(role, browserUserDataDir);
      cdnCompatibilityRequested = compatibility?.enabled ?? false;
      proxyServer = compatibility?.proxyServer;
    } catch (error) {
      console.warn("Failed to prepare CDN compatibility mode for external Chrome.", error);
      sessionNotice = appendNotice(sessionNotice, CDN_COMPATIBILITY_UNAVAILABLE_NOTICE);
    }
    const child = (this.options.spawnChrome ?? spawnChrome)(
      executablePath,
      buildExternalChromeArgs(role, browserUserDataDir, bounds, proxyServer, this.options.graphicsMode)
    );
    const session: ExternalChromeSession = {
      cdnCompatibilityActive: false,
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
        role.launchUrl,
        { cdnCompatibilityEnabled: cdnCompatibilityRequested }
      );
      if (this.sessions.get(role.id) !== session) {
        target.close();
        throw new Error("External Chrome closed before macro control connected.");
      }
      session.automationTarget = target;
      session.cdnCompatibilityActive = cdnCompatibilityRequested;
      if (session.cdnCompatibilityActive) {
        session.notice = appendNotice(session.notice, CDN_COMPATIBILITY_EXTERNAL_NOTICE);
      }
      target.onDisconnect(() => this.handleAutomationDisconnect(role.id, session, target));
      try {
        await target.setWindowBounds(bounds);
      } catch (error) {
        console.warn("Failed to align external Chrome window bounds.", error);
      }
      await this.applyZoom(session, target, zoomMode, zoomFactor);
      await this.macroOverlayInstaller?.(role, target).catch((error) => {
        console.warn("Failed to install the macro overlay in external Chrome.", error);
      });
    } catch (error) {
      if (this.sessions.get(role.id) !== session) {
        throw error;
      }
      console.warn("External Chrome macro automation is unavailable.", error);
      if (cdnCompatibilityRequested) {
        session.notice = appendNotice(session.notice, CDN_COMPATIBILITY_UNAVAILABLE_NOTICE);
      }
      session.notice = appendNotice(session.notice, EXTERNAL_AUTOMATION_UNAVAILABLE_NOTICE);
      if (zoomMode === "adaptive" || zoomFactor !== 1) {
        session.notice = appendNotice(session.notice, EXTERNAL_ZOOM_UNAVAILABLE_NOTICE);
      }
    }

    await this.alignVisibleWindow(child, physicalBounds);
    if (this.sessions.get(role.id) !== session) {
      throw new Error("External Chrome closed before window alignment completed.");
    }

    session.state = "running";
    session.launchedAt = new Date().toISOString();
    this.emitChange();
    return session;
  }

  private async applyZoom(
    session: ExternalChromeSession,
    target: ExternalBrowserAutomationTarget,
    zoomMode: WorkspaceBrowserZoomMode,
    zoomFactor: number
  ): Promise<void> {
    try {
      if (zoomMode === "adaptive") {
        await target.setAdaptiveZoom();
      } else {
        await target.setZoomFactor(zoomFactor);
      }
    } catch (error) {
      console.warn("Failed to apply workspace zoom in external Chrome.", error);
      session.notice = appendNotice(session.notice, EXTERNAL_ZOOM_UNAVAILABLE_NOTICE);
    }
  }

  private toPhysicalBounds(bounds: PixelBounds): PixelBounds | undefined {
    const adapter = this.options.windowBoundsAdapter;
    if (!adapter) {
      return undefined;
    }

    try {
      return adapter.dipToPhysicalBounds(bounds);
    } catch (error) {
      console.warn("Failed to convert external Chrome bounds to physical pixels.", error);
      return undefined;
    }
  }

  private async alignVisibleWindow(
    child: ChildProcess,
    physicalBounds: PixelBounds | undefined
  ): Promise<void> {
    const adapter = this.options.windowBoundsAdapter;
    if (!adapter || !physicalBounds) {
      return;
    }

    const browserProcessId = child.pid;
    if (!Number.isInteger(browserProcessId) || (browserProcessId ?? 0) <= 0) {
      console.warn("Failed to align external Chrome visible bounds because its process ID is unavailable.");
      return;
    }

    try {
      await adapter.alignVisibleBounds({
        browserProcessId: browserProcessId as number,
        physicalBounds
      });
    } catch (error) {
      console.warn("Failed to align external Chrome visible bounds.", error);
    }
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
    if (session.cdnCompatibilityActive) {
      session.cdnCompatibilityActive = false;
      session.notice = replaceNotice(
        session.notice,
        CDN_COMPATIBILITY_EXTERNAL_NOTICE,
        CDN_COMPATIBILITY_UNAVAILABLE_NOTICE
      );
    }
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
  proxyServer?: string,
  graphicsMode: BrowserGraphicsMode = "automatic"
): string[] {
  return [
    `--user-data-dir=${browserUserDataDir}`,
    `--app=${role.launchUrl}`,
    `--window-position=${bounds.x},${bounds.y}`,
    `--window-size=${bounds.width},${bounds.height}`,
    ...BROWSER_BASE_SWITCHES.map((name) => `--${name}`),
    `--disable-features=${BROWSER_BACKGROUND_FEATURES_TO_DISABLE.join(",")}`,
    ...getGraphicsModeSwitches(graphicsMode).map((name) => `--${name}`),
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    ...(proxyServer ? [`--proxy-server=${proxyServer}`] : [])
  ];
}

const EXTERNAL_AUTOMATION_UNAVAILABLE_NOTICE =
  "Macro control could not connect to compatibility mode. Restart this role to try again.";
export const EXTERNAL_ZOOM_UNAVAILABLE_NOTICE =
  "Workspace zoom could not be applied in external Chrome. Restart this role to try again.";

// Native Chrome windows retain OS-drawn corners and frame pixels even when their
// rectangles touch. A small internal overlap keeps the desktop from showing
// through those decorations. macOS needs enough overlap to cover its rounded
// window corners; Windows additionally squares and removes the DWM border in the
// native frame helper, so one physical pixel is sufficient as a fallback.
const MACOS_SEAM_OVERLAP = 12;
const WINDOWS_DIP_SEAM_OVERLAP = 1;
const WINDOWS_PHYSICAL_SEAM_OVERLAP = 1;

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

function replaceNotice(current: string | undefined, previous: string, next: string): string {
  const remaining = current?.replace(previous, "").trim();
  return appendNotice(remaining || undefined, next);
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

function externalChromeSeamOverlap(platform: NodeJS.Platform): number {
  if (platform === "darwin") {
    return MACOS_SEAM_OVERLAP;
  }
  return platform === "win32" ? WINDOWS_DIP_SEAM_OVERLAP : 0;
}

export function createSeamlessWorkspaceBounds(
  bounds: PixelBounds[],
  seamOverlap: number
): PixelBounds[] {
  if (seamOverlap <= 0 || bounds.length < 2) {
    return bounds.map((item) => ({ ...item }));
  }

  const result = bounds.map((item) => ({ ...item }));

  for (let leftIndex = 0; leftIndex < bounds.length; leftIndex += 1) {
    const left = bounds[leftIndex];
    const leftRight = left.x + left.width;
    const leftBottom = left.y + left.height;

    for (let rightIndex = leftIndex + 1; rightIndex < bounds.length; rightIndex += 1) {
      const right = bounds[rightIndex];
      const rightRight = right.x + right.width;
      const rightBottom = right.y + right.height;
      const verticalOverlap = Math.min(leftBottom, rightBottom) - Math.max(left.y, right.y);
      const horizontalOverlap = Math.min(leftRight, rightRight) - Math.max(left.x, right.x);

      // Expand only the earlier window across each seam. The resulting overlap
      // fills either window's transparent corner regardless of which one is in
      // front, while avoiding a double-width overlap.
      if (verticalOverlap > 0) {
        if (leftRight === right.x) {
          result[leftIndex].width += seamOverlap;
        } else if (rightRight === left.x) {
          result[leftIndex].x -= seamOverlap;
          result[leftIndex].width += seamOverlap;
        }
      }

      if (horizontalOverlap > 0) {
        if (leftBottom === right.y) {
          result[leftIndex].height += seamOverlap;
        } else if (rightBottom === left.y) {
          result[leftIndex].y -= seamOverlap;
          result[leftIndex].height += seamOverlap;
        }
      }
    }
  }

  return result;
}
