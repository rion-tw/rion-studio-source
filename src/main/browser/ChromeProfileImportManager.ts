import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, copyFile, lstat, mkdir, readFile, readdir, rm, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Session } from "electron";

import type {
  ChromeProfileEntry,
  ChromeProfileImportInput,
  ChromeProfileImportProgress,
  ChromeProfileImportPreview,
  ChromeProfileImportResult,
  Role
} from "../../shared/types";
import { createLoginStorageSnapshot } from "../auth/loginEvidence";
import { waitForSettledAuthSession } from "../auth/settledAuthSession";
import type { GameStore } from "../games/GameStore";
import {
  CdpClient,
  findSystemChromeExecutable,
  listDevToolsTargets,
  waitForDevToolsPort,
  type DevToolsTarget
} from "../system-browser/SystemChromeLauncher";
import { writeJsonFileAtomically } from "../persistence/atomicJsonFile";
import type { RoleStore } from "../roles/RoleStore";

const PROFILE_DIRECTORY_PATTERN = /^(Default|Profile \d+)$/;
const IMPORT_DIRECTORY = ".chrome-profile-import";
const IMPORT_JOURNAL = "chrome-profile-import-transaction.json";
const IMPORT_COPY_FILES = [
  "Cookies",
  "Network/Cookies"
] as const;
const LOCK_FILES = ["SingletonCookie", "SingletonLock", "SingletonSocket"] as const;
const PROFILE_IMPORT_COOKIE_READ_CONCURRENCY = 3;
const CHROME_LOGIN_DATA_EXPRESSION = `(async () => {
  try {
    if (document.readyState === "loading") {
      await new Promise((resolve) => document.addEventListener("DOMContentLoaded", resolve, { once: true }));
    }
  } catch {
    // Best effort only; the cookie snapshot remains available.
  }
  return {
    bodyText: document.body?.innerText ?? "",
    href: window.location.href,
    origin: window.location.origin,
    readyState: document.readyState
  };
})()`;

interface OpenDirectoryDialogOptions {
  properties: Array<"openDirectory">;
  title: string;
  defaultPath?: string;
}

interface OpenDirectoryDialogResult {
  canceled: boolean;
  filePaths: string[];
}

interface ChromeLoginDataSnapshot {
  cookies: Array<Record<string, unknown>>;
}

export interface ChromeProfileImportLoginDataTransferSummary {
  failedItemCount: number;
  flushFailed: boolean;
  readbackFailed: boolean;
  readFailed: boolean;
  resetFailed: boolean;
  sourceItemCount: number;
  visibleItemCount: number;
  writtenItemCount: number;
  roleId: string;
}

interface PendingImport {
  importId: string;
  sourceUserDataDir: string;
  profiles: Map<string, ChromeProfileEntry>;
}

interface ChromeImportJournal {
  createdRoleIds?: string[];
  importId: string;
  overwrittenRoleIds?: string[];
  originalRoles?: Role[];
  phase?: "committed" | "prepared";
  roleIds?: string[];
}

interface ChromeProfileImportManagerOptions {
  closeChrome?: () => Promise<void>;
  createImportId?: () => string;
  getSession?: (partition: string) => Pick<Session, "cookies" | "flushStorageData">;
  homeDirectory?: string;
  lstat?: typeof lstat;
  onLoginDataTransfer?: (summary: ChromeProfileImportLoginDataTransferSummary) => void;
  platform?: NodeJS.Platform;
  resetEmbeddedSession?: (partition: string) => Promise<void>;
  readChromeLoginData?: (
    userDataDir: string,
    role: Pick<Role, "launchUrl">,
    loginDataUrls: readonly string[]
  ) => Promise<ChromeLoginDataSnapshot>;
  roleStore: Pick<
    RoleStore,
    | "createRole"
    | "deleteRole"
    | "getRolePaths"
    | "listRoles"
    | "replaceRolesForImport"
    | "updateAuthState"
    | "updateRole"
  >;
  showOpenDialog: (options: OpenDirectoryDialogOptions) => Promise<OpenDirectoryDialogResult>;
  userDataDir: string;
  gameStore: Pick<GameStore, "getGame">;
}

export class ChromeProfileImportError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ChromeProfileImportError";
  }
}

export class ChromeProfileImportManager {
  private readonly createImportId: () => string;
  private readonly lstat: typeof lstat;
  private readonly platform: NodeJS.Platform;
  private readonly pending = new Map<string, PendingImport>();

  constructor(private readonly options: ChromeProfileImportManagerOptions) {
    this.createImportId = options.createImportId ?? randomUUID;
    this.lstat = options.lstat ?? lstat;
    this.platform = options.platform ?? process.platform;
  }

  async closeChrome(): Promise<void> {
    if (!this.options.closeChrome) {
      throw new ChromeProfileImportError(
        "CHROME_CLOSE_UNAVAILABLE",
        "Chrome profile import is not available."
      );
    }

    try {
      await this.options.closeChrome();
    } catch (error) {
      if (error instanceof ChromeProfileImportError) {
        throw error;
      }

      throw new ChromeProfileImportError(
        "CHROME_CLOSE_FAILED",
        "Unable to ask Google Chrome to close. Close Chrome manually and try again."
      );
    }
  }

  async previewImport(): Promise<ChromeProfileImportPreview | null> {
    const platform = this.platform;
    if (platform !== "darwin" && platform !== "win32") {
      throw new ChromeProfileImportError(
        "PLATFORM_UNSUPPORTED",
        "Chrome profile import is supported on macOS and Windows only."
      );
    }

    const defaultPath = getDefaultChromeUserDataDirectory(platform, this.options.homeDirectory ?? homedir());
    const result = await this.options.showOpenDialog({
      defaultPath,
      properties: ["openDirectory"],
      title: "Choose Chrome User Data folder"
    });
    if (result.canceled || !result.filePaths[0]) {
      return null;
    }

    const sourceUserDataDir = result.filePaths[0];
    await ensureDirectory(sourceUserDataDir, this.lstat);
    if (await hasChromeLock(sourceUserDataDir)) {
      throw new ChromeProfileImportError(
        "CHROME_RUNNING",
        "Chrome is still using the selected profile. Quit Chrome and try again."
      );
    }

    const profiles = await readChromeProfiles(sourceUserDataDir);
    const importId = this.createImportId();
    this.pending.set(importId, {
      importId,
      profiles: new Map(profiles.map((profile) => [profile.id, profile])),
      sourceUserDataDir
    });

    return {
      importId,
      sourceLabel: basename(sourceUserDataDir) || "Chrome User Data",
      profiles,
      warnings: [{ code: "passwords_excluded" }]
    };
  }

  async applyImport(
    input: ChromeProfileImportInput,
    onProgress?: (progress: ChromeProfileImportProgress) => void
  ): Promise<ChromeProfileImportResult> {
    if (!input || !isSafeImportId(input.importId) || !input.consentAccepted) {
      throw new ChromeProfileImportError(
        "CONSENT_REQUIRED",
        "Consent is required before importing Chrome profile data."
      );
    }

    const pending = this.pending.get(input.importId);
    if (!pending) {
      throw new ChromeProfileImportError(
        "IMPORT_EXPIRED",
        "Chrome profile import preview expired. Choose the folder again."
      );
    }

    const selectedProfiles = [...new Set(input.profileIds)]
      .map((profileId) => pending.profiles.get(profileId))
      .filter((profile): profile is ChromeProfileEntry => Boolean(profile));
    if (selectedProfiles.length === 0) {
      throw new ChromeProfileImportError(
        "PROFILE_SELECTION_EMPTY",
        "Select at least one Chrome profile to import."
      );
    }

    let completedProfileCount = 0;
    const reportProgress = (
      phase: ChromeProfileImportProgress["phase"],
      profile?: ChromeProfileEntry
    ): void => {
      try {
        onProgress?.({
          completedProfileCount,
          ...(profile ? { currentProfileId: profile.id, currentProfileName: profile.name } : {}),
          importId: input.importId,
          phase,
          totalProfileCount: selectedProfiles.length
        });
      } catch {
        // Renderer progress reporting must never affect the import transaction.
      }
    };
    reportProgress("preparing");

    const game = await this.options.gameStore.getGame(input.gameId);
    const existingRoles = await this.options.roleStore.listRoles();
    const existingRolesByIdentity = new Map<string, Role[]>();
    for (const role of existingRoles) {
      const key = createRoleIdentityKey(role.gameId, role.name);
      const matches = existingRolesByIdentity.get(key) ?? [];
      matches.push(role);
      existingRolesByIdentity.set(key, matches);
    }
    const seenSourceIdentities = new Set<string>();
    const assignments = selectedProfiles.map((profile) => {
      const roleName = normalizeImportedRoleName(profile);
      const identityKey = createRoleIdentityKey(game.id, roleName);
      if (seenSourceIdentities.has(identityKey)) {
        throw createRoleNameConflictError();
      }
      seenSourceIdentities.add(identityKey);
      const matches = existingRolesByIdentity.get(identityKey) ?? [];
      if (matches.length > 1) {
        throw createRoleNameConflictError();
      }
      return { existing: matches[0], profile, roleName };
    });
    const stageRoot = join(this.options.userDataDir, IMPORT_DIRECTORY, input.importId);
    const journalPath = join(this.options.userDataDir, IMPORT_JOURNAL);
    const createdRoleIds: string[] = [];
    const overwrittenRoleIds = assignments.flatMap((assignment) =>
      assignment.existing ? [assignment.existing.id] : []
    );
    const journal: ChromeImportJournal = {
      createdRoleIds,
      importId: input.importId,
      originalRoles: structuredClone(existingRoles),
      overwrittenRoleIds,
      phase: "prepared"
    };

    await rm(stageRoot, { force: true, recursive: true });
    await mkdir(stageRoot, { recursive: true });

    try {
      for (const assignment of assignments) {
        const stageBrowserDir = join(stageRoot, "profiles", assignment.profile.id);
        await copyChromeProfile(
          pending.sourceUserDataDir,
          assignment.profile.directoryName,
          stageBrowserDir,
          this.lstat
        );
      }
      for (const roleId of overwrittenRoleIds) {
        const sourceBrowserDir = this.options.roleStore.getRolePaths(roleId).browserUserDataDir;
        const backupBrowserDir = join(stageRoot, "backups", roleId);
        if (await pathExists(sourceBrowserDir)) {
          await copyDirectory(sourceBrowserDir, backupBrowserDir);
        } else {
          await mkdir(backupBrowserDir, { recursive: true });
        }
      }
      await writeJsonFileAtomically(journalPath, journal);

      const preparedImports: Array<{
        profile: ChromeProfileEntry;
        resetExistingSession: boolean;
        role: Role;
        targetBrowserDir: string;
      }> = [];
      for (const assignment of assignments) {
        const role = assignment.existing
          ? await this.options.roleStore.updateRole(assignment.existing.id, {
              gameId: game.id,
              launchUrl: game.defaultLaunchUrl,
              name: assignment.roleName,
              notes: "Imported from a local Chrome profile."
            })
          : await this.options.roleStore.createRole({
              gameId: game.id,
              launchUrl: game.defaultLaunchUrl,
              name: assignment.roleName,
              notes: "Imported from a local Chrome profile."
            });
        if (!assignment.existing) {
          createdRoleIds.push(role.id);
          await writeJsonFileAtomically(journalPath, journal);
        }

        const stageBrowserDir = join(stageRoot, "profiles", assignment.profile.id);
        const targetBrowserDir = this.options.roleStore.getRolePaths(role.id).browserUserDataDir;
        await rm(targetBrowserDir, { force: true, recursive: true });
        await copyDirectory(stageBrowserDir, targetBrowserDir);

        preparedImports.push({
          profile: assignment.profile,
          resetExistingSession: Boolean(assignment.existing),
          role,
          targetBrowserDir
        });
      }

      await runWithConcurrency(
        preparedImports,
        PROFILE_IMPORT_COOKIE_READ_CONCURRENCY,
        async ({ profile, resetExistingSession, role, targetBrowserDir }) => {
          reportProgress("importing", profile);
          await this.transferImportedCookies(
            targetBrowserDir,
            role,
            createLoginDataUrls(role, game.loginUrl),
            resetExistingSession
          );
          await this.options.roleStore.updateAuthState(role.id, "authenticated");
          completedProfileCount += 1;
          reportProgress("importing", profile);
        }
      );

      await writeJsonFileAtomically(journalPath, { ...journal, phase: "committed" });
      journal.phase = "committed";
      const roles = await this.options.roleStore.listRoles();
      this.pending.delete(input.importId);
      await removeStagingDirectory(this.options.userDataDir, input.importId);
      await rm(journalPath, { force: true });
      reportProgress("completed");
      const affectedRoleIds = new Set([...overwrittenRoleIds, ...createdRoleIds]);
      return {
        roles: roles.filter((role) => affectedRoleIds.has(role.id))
      };
    } catch (error) {
      if (journal.phase !== "committed") {
        try {
          await restoreChromeImportTransaction(this.options.userDataDir, journal, this.options.roleStore);
          await removeStagingDirectory(this.options.userDataDir, input.importId);
          await rm(journalPath, { force: true });
        } catch {
          // Keep the journal and staged backups for startup recovery.
        }
      } else {
        try {
          await removeStagingDirectory(this.options.userDataDir, input.importId);
          await rm(journalPath, { force: true });
        } catch {
          // Keep the committed journal so startup recovery can finish cleanup.
        }
      }
      throw error;
    } finally {
      this.pending.delete(input.importId);
    }
  }

  async discardImport(importId: string): Promise<void> {
    if (!isSafeImportId(importId)) {
      throw new ChromeProfileImportError("IMPORT_INVALID", "Chrome profile import id is invalid.");
    }
    this.pending.delete(importId);
    await removeStagingDirectory(this.options.userDataDir, importId);
  }

  private async transferImportedCookies(
    browserUserDataDir: string,
    role: Role,
    loginDataUrls: readonly string[],
    resetExistingSession: boolean
  ): Promise<void> {
    const summary: ChromeProfileImportLoginDataTransferSummary = {
      failedItemCount: 0,
      flushFailed: false,
      readbackFailed: false,
      readFailed: false,
      resetFailed: false,
      sourceItemCount: 0,
      visibleItemCount: 0,
      writtenItemCount: 0,
      roleId: role.id
    };

    const reportSummary = (): void => {
      try {
        this.options.onLoginDataTransfer?.(summary);
      } catch {
        // Diagnostics must never affect the import transaction.
      }
    };

    if (!this.options.readChromeLoginData) {
      reportSummary();
      return;
    }

    let snapshot: ChromeLoginDataSnapshot;
    try {
      snapshot = await this.options.readChromeLoginData(browserUserDataDir, role, loginDataUrls);
    } catch {
      summary.readFailed = true;
      reportSummary();
      return;
    }

    summary.sourceItemCount = snapshot.cookies.length;
    const partition = `persist:rion-role-${role.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

    if (resetExistingSession && this.options.resetEmbeddedSession) {
      try {
        await this.options.resetEmbeddedSession(partition);
      } catch {
        summary.resetFailed = true;
      }
    }

    if (!this.options.getSession) {
      reportSummary();
      return;
    }

    let session: Pick<Session, "cookies" | "flushStorageData"> | undefined;
    try {
      session = this.options.getSession(partition);
    } catch {
      summary.failedItemCount = snapshot.cookies.length;
    }
    if (session) {
      for (const cookie of snapshot.cookies) {
        try {
          await session.cookies.set(normalizeElectronCookie(cookie, role.launchUrl));
          summary.writtenItemCount += 1;
        } catch {
          summary.failedItemCount += 1;
        }
      }

      try {
        const visibleCookies = new Set<string>();
        for (const url of loginDataUrls) {
          const cookies = await session.cookies.get({ url });
          cookies.forEach((cookie) => {
            visibleCookies.add(`${cookie.domain ?? ""}\u0000${cookie.name}\u0000${cookie.path ?? ""}`);
          });
        }
        summary.visibleItemCount = visibleCookies.size;
      } catch {
        summary.readbackFailed = true;
      }
    }

    if (session) {
      try {
        await session.flushStorageData();
      } catch {
        summary.flushFailed = true;
      }
    }

    reportSummary();
  }
}

function createRoleIdentityKey(gameId: string, name: string): string {
  return `${gameId}\u0000${normalizeNameKey(name)}`;
}

function normalizeImportedRoleName(profile: ChromeProfileEntry): string {
  return (profile.name.trim() || profile.directoryName || "Chrome Profile").slice(0, 80);
}

function createRoleNameConflictError(): ChromeProfileImportError {
  return new ChromeProfileImportError(
    "ROLE_NAME_CONFLICT",
    "Multiple Chrome profiles or roles share a name in the selected game. Rename or remove duplicates before importing."
  );
}

async function restoreChromeImportTransaction(
  userDataDir: string,
  journal: Partial<ChromeImportJournal>,
  roleStore: Pick<RoleStore, "deleteRole" | "getRolePaths" | "listRoles" | "replaceRolesForImport">
): Promise<void> {
  const journalCreatedRoleIds = [
    ...(Array.isArray(journal.createdRoleIds) ? journal.createdRoleIds : []),
    ...(Array.isArray(journal.roleIds) ? journal.roleIds : [])
  ].filter((roleId, index, roleIds): roleId is string =>
    typeof roleId === "string" && roleIds.indexOf(roleId) === index
  );
  const currentRoles = Array.isArray(journal.originalRoles) ? await roleStore.listRoles() : [];
  const originalRoleIds = new Set(
    Array.isArray(journal.originalRoles) ? journal.originalRoles.map((role) => role.id) : []
  );
  const createdRoleIds = [
    ...journalCreatedRoleIds,
    ...currentRoles
      .filter((role) => !originalRoleIds.has(role.id))
      .map((role) => role.id)
  ].filter((roleId, index, roleIds): roleId is string =>
    roleIds.indexOf(roleId) === index
  );
  for (const roleId of createdRoleIds) {
    try {
      await roleStore.deleteRole(roleId);
    } catch (error) {
      const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
      if (code !== "ROLE_NOT_FOUND") {
        throw error;
      }
    }
  }

  if (Array.isArray(journal.originalRoles)) {
    await roleStore.replaceRolesForImport(journal.originalRoles, true, false);
  }

  const overwrittenRoleIds = Array.isArray(journal.overwrittenRoleIds)
    ? journal.overwrittenRoleIds.filter((roleId): roleId is string => typeof roleId === "string")
    : [];
  for (const roleId of overwrittenRoleIds) {
    const targetBrowserDir = roleStore.getRolePaths(roleId).browserUserDataDir;
    const backupBrowserDir = join(userDataDir, IMPORT_DIRECTORY, journal.importId ?? "", "backups", roleId);
    await rm(targetBrowserDir, { force: true, recursive: true });
    if (await pathExists(backupBrowserDir)) {
      await copyDirectory(backupBrowserDir, targetBrowserDir);
    } else {
      await mkdir(targetBrowserDir, { recursive: true });
    }
  }
}

export async function recoverChromeProfileImport(
  userDataDir: string,
  roleStore?: Pick<
    RoleStore,
    "deleteRole" | "getRolePaths" | "listRoles" | "replaceRolesForImport"
  >
): Promise<void> {
  const journalPath = join(userDataDir, IMPORT_JOURNAL);
  let journal: Partial<ChromeImportJournal> | undefined;
  try {
    journal = JSON.parse(await readFile(journalPath, "utf8")) as Partial<ChromeImportJournal>;
  } catch {
    // A missing or malformed journal is recovered by removing the staging directory.
  }

  if (journal?.phase === "committed") {
    await rm(join(userDataDir, IMPORT_DIRECTORY), { force: true, recursive: true });
    await rm(journalPath, { force: true });
    return;
  }

  if (roleStore && journal) {
    try {
      await restoreChromeImportTransaction(userDataDir, journal, roleStore);
      await rm(join(userDataDir, IMPORT_DIRECTORY), { force: true, recursive: true });
      await rm(journalPath, { force: true });
      return;
    } catch {
      // Leave the journal and backups in place so the next startup can retry recovery.
      return;
    }
  }

  await rm(join(userDataDir, IMPORT_DIRECTORY), { force: true, recursive: true });
  await rm(journalPath, { force: true });
}

export function getDefaultChromeUserDataDirectory(
  platform: NodeJS.Platform,
  homeDirectory: string,
  localAppDataDirectory = process.env.LOCALAPPDATA
): string | undefined {
  if (platform === "darwin") {
    return join(homeDirectory, "Library", "Application Support", "Google", "Chrome");
  }
  if (platform === "win32" && localAppDataDirectory) {
    return join(localAppDataDirectory, "Google", "Chrome", "User Data");
  }
  return undefined;
}

async function readChromeProfiles(sourceUserDataDir: string): Promise<ChromeProfileEntry[]> {
  let localState: Record<string, unknown> = {};
  try {
    localState = JSON.parse(await readFile(join(sourceUserDataDir, "Local State"), "utf8")) as Record<string, unknown>;
  } catch {
    // Profile directories remain discoverable without Local State.
  }

  const profileState = isRecord(localState.profile) ? localState.profile : undefined;
  const infoCache = isRecord(profileState?.info_cache)
    ? profileState.info_cache as Record<string, unknown>
    : {};
  const directoryNames = (await readdir(sourceUserDataDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && PROFILE_DIRECTORY_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  if (directoryNames.length === 0) {
    throw new ChromeProfileImportError("PROFILE_INVALID", "No Chrome profiles were found in the selected folder.");
  }

  return directoryNames.map((directoryName) => {
    const metadata = isRecord(infoCache[directoryName]) ? infoCache[directoryName] as Record<string, unknown> : {};
    const name = typeof metadata.name === "string" && metadata.name.trim()
      ? metadata.name.trim()
      : directoryName === "Default"
        ? "Default"
        : directoryName;
    return { directoryName, id: directoryName, name: name.slice(0, 80) };
  });
}

async function copyChromeProfile(
  sourceUserDataDir: string,
  directoryName: string,
  destination: string,
  lstatFn: typeof lstat
): Promise<void> {
  await mkdir(destination, { recursive: true });
  await copyFileIfPresent(join(sourceUserDataDir, "Local State"), join(destination, "Local State"), lstatFn);
  const sourceProfile = join(sourceUserDataDir, directoryName);
  const destinationProfile = join(destination, "Default");
  await mkdir(destinationProfile, { recursive: true });
  for (const relativePath of IMPORT_COPY_FILES) {
    await copyFileIfPresent(join(sourceProfile, relativePath), join(destinationProfile, relativePath), lstatFn);
  }
}

async function copyDirectory(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new ChromeProfileImportError("PROFILE_INVALID", "Chrome profile contains an unsupported symbolic link.");
    }
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(sourcePath, destinationPath);
    } else if (entry.isFile()) {
      await mkdir(dirname(destinationPath), { recursive: true });
      await copyFile(sourcePath, destinationPath);
    }
  }
}

async function copyFileIfPresent(source: string, destination: string, lstatFn: typeof lstat): Promise<void> {
  try {
    const stats = await lstatFn(source);
    if (stats.isSymbolicLink()) {
      throw new ChromeProfileImportError("PROFILE_INVALID", "Chrome profile contains an unsupported symbolic link.");
    }
    if (!stats.isFile()) return;
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
}

async function ensureDirectory(path: string, lstatFn: typeof lstat): Promise<void> {
  try {
    const stats = await lstatFn(path);
    if (!stats.isDirectory()) throw new ChromeProfileImportError("SOURCE_INVALID", "Selected Chrome data path is not a folder.");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new ChromeProfileImportError("SOURCE_INVALID", "Selected Chrome data folder does not exist.");
    }
    throw error;
  }
}

async function removeStagingDirectory(userDataDir: string, importId: string): Promise<void> {
  const stagingRoot = join(userDataDir, IMPORT_DIRECTORY);
  await rm(join(stagingRoot, importId), { force: true, recursive: true });
  try {
    if ((await readdir(stagingRoot)).length === 0) {
      await rm(stagingRoot, { force: true, recursive: true });
    }
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
}

async function hasChromeLock(sourceUserDataDir: string): Promise<boolean> {
  for (const lockFile of LOCK_FILES) {
    try {
      await access(join(sourceUserDataDir, lockFile));
      return true;
    } catch {
      // Continue checking the remaining lock markers.
    }
  }
  return false;
}

function normalizeNameKey(value: string): string {
  return value.trim().toLocaleLowerCase();
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function isSafeImportId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}

function normalizeElectronCookie(cookie: Record<string, unknown>, fallbackUrl: string): Parameters<Session["cookies"]["set"]>[0] {
  const domain = typeof cookie.domain === "string" ? cookie.domain : undefined;
  const name = typeof cookie.name === "string" ? cookie.name : "";
  const secure = typeof cookie.secure === "boolean" ? cookie.secure : undefined;
  const cookieUrl = createElectronCookieUrl(domain, cookie.path, secure, fallbackUrl);
  const sameSite = normalizeElectronSameSite(cookie.sameSite);
  return {
    url: cookieUrl,
    name,
    value: typeof cookie.value === "string" ? cookie.value : "",
    ...(domain?.startsWith(".") && !name.startsWith("__Host-") ? { domain } : {}),
    ...(typeof cookie.path === "string" && cookie.path.startsWith("/") ? { path: cookie.path } : {}),
    ...(typeof cookie.expirationDate === "number" ? { expirationDate: cookie.expirationDate } : {}),
    ...(typeof cookie.httpOnly === "boolean" ? { httpOnly: cookie.httpOnly } : {}),
    ...(secure !== undefined ? { secure } : {}),
    ...(sameSite ? { sameSite } : {})
  } as Parameters<Session["cookies"]["set"]>[0];
}

function createElectronCookieUrl(
  domain: string | undefined,
  cookiePath: unknown,
  secure: boolean | undefined,
  fallbackUrl: string
): string {
  if (!domain) {
    return fallbackUrl;
  }

  const fallback = new URL(fallbackUrl);
  const host = domain.replace(/^\.+/, "");
  const protocol = secure === true || fallback.protocol === "https:" ? "https:" : "http:";
  const path = typeof cookiePath === "string" && cookiePath.startsWith("/") ? cookiePath : "/";
  return `${protocol}//${host}${path}`;
}

function normalizeElectronSameSite(value: unknown): "strict" | "lax" | "no_restriction" | "unspecified" | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  switch (value.toLowerCase()) {
    case "strict":
      return "strict";
    case "lax":
      return "lax";
    case "none":
    case "no_restriction":
      return "no_restriction";
    case "unset":
    case "unspecified":
      return "unspecified";
    default:
      return undefined;
  }
}

function createLoginDataUrls(role: Pick<Role, "launchUrl">, loginUrl?: string): string[] {
  return normalizeLoginDataUrls(role, loginUrl ? [loginUrl] : []);
}

function normalizeLoginDataUrls(role: Pick<Role, "launchUrl">, extraUrls: readonly string[]): string[] {
  const urls = [role.launchUrl, ...extraUrls].filter((value): value is string => Boolean(value));
  const seenOrigins = new Set<string>();
  return urls.filter((url) => {
    const origin = getUrlOrigin(url);
    if (!origin || seenOrigins.has(origin)) {
      return false;
    }
    seenOrigins.add(origin);
    return true;
  });
}

function getUrlOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export async function readChromeLoginDataWithCdp(
  userDataDir: string,
  role: Pick<Role, "launchUrl">,
  loginDataUrls: readonly string[] = [role.launchUrl],
  options: ReadChromeLoginDataOptions = {}
): Promise<ChromeLoginDataSnapshot> {
  const readOnce = options.readOnce ?? ((nextUserDataDir, nextRole, nextUrls) =>
    readChromeLoginDataOnceWithCdp(nextUserDataDir, nextRole, nextUrls, options));
  return readOnce(userDataDir, role, loginDataUrls);
}

interface ReadChromeLoginDataOptions {
  findExecutable?: () => string;
  readOnce?: (
    userDataDir: string,
    role: Pick<Role, "launchUrl">,
    loginDataUrls: readonly string[]
  ) => Promise<ChromeLoginDataSnapshot>;
  spawnChrome?: (executable: string, args: string[]) => ChildProcess;
  timeoutMs?: number;
}

async function readChromeLoginDataOnceWithCdp(
  userDataDir: string,
  role: Pick<Role, "launchUrl">,
  loginDataUrls: readonly string[],
  options: ReadChromeLoginDataOptions
): Promise<ChromeLoginDataSnapshot> {
  const urls = normalizeLoginDataUrls(role, loginDataUrls);
  const initialUrl = urls[0] ?? role.launchUrl;
  const executable = (options.findExecutable ?? findSystemChromeExecutable)();
  await unlink(join(userDataDir, "DevToolsActivePort")).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  const child = (options.spawnChrome ?? ((path, args) => spawn(path, args, { stdio: "ignore" })))(
    executable,
    buildChromeProfileImportChromeArgs(userDataDir, initialUrl)
  );
  let client: CdpClient | undefined;

  try {
    await waitForChildSpawn(child);
    const port = await waitForDevToolsPort(userDataDir, { timeoutMs: options.timeoutMs ?? 10_000 });
    if (port.state !== "available") {
      throw new ChromeProfileImportError("LOGIN_DATA_READ_FAILED", "Unable to read imported Chrome login data.");
    }
    const target = await waitForPageTarget(port.port, initialUrl, options.timeoutMs ?? 10_000);
    if (!target?.webSocketDebuggerUrl) {
      throw new ChromeProfileImportError("LOGIN_DATA_TARGET_MISSING", "Imported Chrome profile did not expose a login data page.");
    }
    client = new CdpClient(target.webSocketDebuggerUrl);
    let lastNetworkActivityAt = Date.now();
    const removeNetworkListener = client.onNotification((notification) => {
      if (notification.method.startsWith("Network.") || notification.method.startsWith("Page.")) {
        lastNetworkActivityAt = Date.now();
      }
    });
    try {
      await Promise.all([
        client.send("Page.enable").catch(() => undefined),
        client.send("Network.enable").catch(() => undefined),
        client.send("Runtime.enable").catch(() => undefined)
      ]);
      const waitForSettledPage = async (url: string): Promise<void> => {
        await waitForSettledAuthSession(
          () => readChromeAuthSample(client!, url),
          {
            isIdle: () => Date.now() - lastNetworkActivityAt >= 1_500,
            timeoutMs: options.timeoutMs ?? 20_000
          }
        );
      };

      for (const [index, url] of urls.entries()) {
        if (index > 0) {
          await navigateChromePage(client, url, options.timeoutMs ?? 10_000);
          lastNetworkActivityAt = Date.now();
        }
        await waitForSettledPage(url);
      }

      if (urls.length > 1) {
        await navigateChromePage(client, initialUrl, options.timeoutMs ?? 10_000);
        lastNetworkActivityAt = Date.now();
        await waitForSettledPage(initialUrl);
      }

      const cookieResult = await client.send<{ cookies?: unknown[] }>("Network.getAllCookies");
      return {
        cookies: Array.isArray(cookieResult.cookies)
          ? cookieResult.cookies.filter(isRecord)
          : []
      };
    } finally {
      removeNetworkListener();
    }
  } finally {
    if (client) {
      await closeChromeGracefully(child, client);
      client.close();
    } else {
      await terminateChrome(child);
    }
  }
}

async function readChromeAuthSample(client: CdpClient, fallbackUrl: string) {
  const [cookieResult, runtimeResult] = await Promise.all([
    client.send<{ cookies?: unknown[] }>("Network.getCookies", { urls: [fallbackUrl] }),
    client.send<{ result?: { value?: unknown } }>("Runtime.evaluate", {
      expression: CHROME_LOGIN_DATA_EXPRESSION,
      returnByValue: true,
      awaitPromise: true
    })
  ]);
  const runtimeValue = runtimeResult.result?.value;
  return {
    finalUrl: readRuntimeHref(runtimeValue) ?? fallbackUrl,
    snapshot: createLoginStorageSnapshot(cookieResult.cookies, runtimeValue)
  };
}

async function closeChromeGracefully(child: ChildProcess, client: CdpClient): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = waitForChildClose(child, 2_000);
  await client.send("Browser.close", undefined, 1_000).catch(() => undefined);
  if (await closed) return;
  await terminateChrome(child);
}

async function waitForChildClose(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => resolve(false), timeoutMs);
    child.once("close", () => {
      clearTimeout(timeout);
      resolve(true);
    });
  });
}

export function buildChromeProfileImportChromeArgs(userDataDir: string, initialUrl: string): string[] {
  return [
    `--user-data-dir=${userDataDir}`,
    "--profile-directory=Default",
    "--headless",
    `--app=${initialUrl}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0"
  ];
}

async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  task: (item: T) => Promise<void>
): Promise<void> {
  let failed = false;
  let firstError: unknown;
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (!failed) {
      const index = nextIndex;
      if (index >= items.length) return;
      nextIndex += 1;

      try {
        await task(items[index]);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
      }
    }
  });

  await Promise.all(workers);
  if (failed) throw firstError;
}

async function navigateChromePage(client: CdpClient, url: string, timeoutMs: number): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let removeListener: (() => void) | undefined;
  const pageLoaded = new Promise<void>((resolve) => {
    const finish = (): void => {
      if (timeout) clearTimeout(timeout);
      resolve();
    };
    removeListener = client.onNotification((notification) => {
      if (notification.method === "Page.loadEventFired") finish();
    });
    timeout = setTimeout(finish, Math.min(timeoutMs, 2_000));
  });

  try {
    await client.send("Page.navigate", { url });
    await pageLoaded;
  } finally {
    removeListener?.();
    if (timeout) clearTimeout(timeout);
  }
}

function readRuntimeHref(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.href !== "string") {
    return undefined;
  }
  return value.href;
}

async function waitForPageTarget(port: number, launchUrl: string, timeoutMs: number): Promise<DevToolsTarget | undefined> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const target = (await listDevToolsTargets(port)).find((item) => {
      try {
        return item.type === "page" && item.url && new URL(item.url).origin === new URL(launchUrl).origin;
      } catch {
        return false;
      }
    });
    if (target) return target;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return undefined;
}

async function waitForChildSpawn(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", reject);
  });
}

async function terminateChrome(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 2_000);
    child.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}
