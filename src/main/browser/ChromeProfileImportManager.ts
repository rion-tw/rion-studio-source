import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, copyFile, lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Session } from "electron";

import type {
  ChromeProfileEntry,
  ChromeProfileImportInput,
  ChromeProfileImportPreview,
  ChromeProfileImportResult,
  ChromeProfileImportRoleVerification,
  ChromeProfileImportRuntimeVerification,
  ChromeProfileImportWarning,
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
  "Bookmarks",
  "Bookmarks.bak",
  "Cookies",
  "Network/Cookies",
  "Local Storage",
  "Session Storage",
  "IndexedDB",
  "Service Worker",
  "Preferences",
  "Secure Preferences"
] as const;
const LOCK_FILES = ["SingletonCookie", "SingletonLock", "SingletonSocket"] as const;
const CHROME_LOGIN_DATA_EXPRESSION = `(async () => {
  const readStorage = (name) => {
    const values = {};
    try {
      const storage = window[name];
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key !== null) values[key] = storage.getItem(key) ?? "";
      }
    } catch {
      return values;
    }
    return values;
  };
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
    localStorage: readStorage("localStorage"),
    origin: window.location.origin,
    readyState: document.readyState,
    sessionStorage: readStorage("sessionStorage")
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
  externalVerification?: ChromeProfileImportRuntimeVerification;
  localStorageByOrigin: Record<string, Record<string, string>>;
}

export interface ChromeProfileImportLoginDataTransferSummary {
  failedItemCount: number;
  failedStorageOriginCount: number;
  readbackFailed: boolean;
  readFailed: boolean;
  resetFailed: boolean;
  sourceItemCount: number;
  sourceStorageKeyCount: number;
  sourceStorageOriginCount: number;
  visibleItemCount: number;
  writtenItemCount: number;
  writtenStorageKeyCount: number;
  writtenStorageOriginCount: number;
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
  getSession?: (partition: string) => Pick<Session, "cookies">;
  homeDirectory?: string;
  injectEmbeddedStorage?: (
    partition: string,
    url: string,
    values: Record<string, string>
  ) => Promise<void>;
  lstat?: typeof lstat;
  onLoginDataTransfer?: (summary: ChromeProfileImportLoginDataTransferSummary) => void;
  platform?: NodeJS.Platform;
  resetEmbeddedSession?: (partition: string) => Promise<void>;
  readChromeLoginData?: (
    userDataDir: string,
    role: Pick<Role, "launchUrl">,
    loginDataUrls: readonly string[]
  ) => Promise<ChromeLoginDataSnapshot>;
  verifyEmbeddedSession?: (
    partition: string,
    role: Pick<Role, "launchUrl">
  ) => Promise<ChromeProfileImportRuntimeVerification>;
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

  async applyImport(input: ChromeProfileImportInput): Promise<ChromeProfileImportResult> {
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
    const verifications: ChromeProfileImportRoleVerification[] = [];
    const warnings: ChromeProfileImportWarning[] = [{ code: "passwords_excluded" }];
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

        const runtimeVerification = await this.seedImportedLoginData(
          targetBrowserDir,
          role,
          createLoginDataUrls(role, game.loginUrl),
          Boolean(assignment.existing)
        );
        verifications.push({
          embedded: runtimeVerification.embedded,
          external: runtimeVerification.external,
          profileId: assignment.profile.id,
          profileName: assignment.profile.name,
          roleId: role.id
        });
        for (const verification of [runtimeVerification.external, runtimeVerification.embedded]) {
          if (verification.state === "authenticated") continue;
          warnings.push({
            code: verification.state === "auth_failed"
              ? "login_verification_failed"
              : "login_not_preserved",
            mode: verification.mode,
            profileId: assignment.profile.id,
            profileName: assignment.profile.name
          });
        }
        await this.options.roleStore.updateAuthState(
          role.id,
          combineRuntimeAuthStates(runtimeVerification.external, runtimeVerification.embedded)
        );
      }

      await writeJsonFileAtomically(journalPath, { ...journal, phase: "committed" });
      journal.phase = "committed";
      const roles = await this.options.roleStore.listRoles();
      this.pending.delete(input.importId);
      await removeStagingDirectory(this.options.userDataDir, input.importId);
      await rm(journalPath, { force: true });
      const affectedRoleIds = new Set([...overwrittenRoleIds, ...createdRoleIds]);
      return {
        roles: roles.filter((role) => affectedRoleIds.has(role.id)),
        verifications,
        warnings
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

  private async seedImportedLoginData(
    browserUserDataDir: string,
    role: Role,
    loginDataUrls: readonly string[],
    resetExistingSession: boolean
  ): Promise<{
    embedded: ChromeProfileImportRuntimeVerification;
    external: ChromeProfileImportRuntimeVerification;
  }> {
    const summary: ChromeProfileImportLoginDataTransferSummary = {
      failedItemCount: 0,
      failedStorageOriginCount: 0,
      readbackFailed: false,
      readFailed: false,
      resetFailed: false,
      sourceItemCount: 0,
      sourceStorageKeyCount: 0,
      sourceStorageOriginCount: 0,
      visibleItemCount: 0,
      writtenItemCount: 0,
      writtenStorageKeyCount: 0,
      writtenStorageOriginCount: 0,
      roleId: role.id
    };

    const reportSummary = (): void => {
      try {
        this.options.onLoginDataTransfer?.(summary);
      } catch {
        // Diagnostics must never affect the import transaction.
      }
    };

    if (!this.options.readChromeLoginData || !this.options.getSession || !this.options.injectEmbeddedStorage) {
      reportSummary();
      return createUnavailableRuntimeVerifications("Chrome login data transfer is unavailable.");
    }

    let snapshot: ChromeLoginDataSnapshot;
    try {
      snapshot = await this.options.readChromeLoginData(browserUserDataDir, role, loginDataUrls);
    } catch (error) {
      summary.readFailed = true;
      reportSummary();
      return createUnavailableRuntimeVerifications(
        error instanceof Error ? error.message : "Unable to read Chrome login data."
      );
    }

    const external = snapshot.externalVerification ?? createRuntimeVerification("external", "authenticated");

    summary.sourceItemCount = snapshot.cookies.length;
    summary.sourceStorageOriginCount = Object.keys(snapshot.localStorageByOrigin).length;
    summary.sourceStorageKeyCount = Object.values(snapshot.localStorageByOrigin)
      .reduce((count, values) => count + Object.keys(values).length, 0);
    const partition = `persist:rion-role-${role.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

    if (resetExistingSession && this.options.resetEmbeddedSession) {
      try {
        await this.options.resetEmbeddedSession(partition);
      } catch {
        summary.resetFailed = true;
      }
    }

    let session: Pick<Session, "cookies"> | undefined;
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

    for (const [origin, values] of Object.entries(snapshot.localStorageByOrigin)) {
      const url = loginDataUrls.find((candidate) => getUrlOrigin(candidate) === origin);
      if (!url || Object.keys(values).length === 0) {
        continue;
      }
      try {
        await this.options.injectEmbeddedStorage(partition, url, values);
        summary.writtenStorageOriginCount += 1;
        summary.writtenStorageKeyCount += Object.keys(values).length;
      } catch {
        summary.failedStorageOriginCount += 1;
      }
    }

    reportSummary();
    let embedded: ChromeProfileImportRuntimeVerification;
    if (!this.options.verifyEmbeddedSession) {
      embedded = createRuntimeVerification("embedded", "authenticated");
    } else {
      try {
        embedded = await this.options.verifyEmbeddedSession(partition, role);
      } catch (error) {
        embedded = createRuntimeVerification(
          "embedded",
          "auth_failed",
          error instanceof Error ? error.message : "Unable to verify the embedded login session."
        );
      }
    }

    return { embedded, external };
  }
}

function createRuntimeVerification(
  mode: ChromeProfileImportRuntimeVerification["mode"],
  state: ChromeProfileImportRuntimeVerification["state"],
  message?: string,
  durationMs?: number
): ChromeProfileImportRuntimeVerification {
  return {
    mode,
    state,
    ...(message ? { message } : {}),
    ...(durationMs === undefined ? {} : { durationMs })
  };
}

function createUnavailableRuntimeVerifications(message: string): {
  embedded: ChromeProfileImportRuntimeVerification;
  external: ChromeProfileImportRuntimeVerification;
} {
  return {
    embedded: createRuntimeVerification("embedded", "auth_failed", message),
    external: createRuntimeVerification("external", "auth_failed", message)
  };
}

function combineRuntimeAuthStates(
  external: ChromeProfileImportRuntimeVerification,
  embedded: ChromeProfileImportRuntimeVerification
): Role["authState"] {
  if (external.state === "authenticated" && embedded.state === "authenticated") {
    return "authenticated";
  }
  if (external.state === "auth_failed" || embedded.state === "auth_failed") {
    return "auth_failed";
  }
  return "login_required";
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
    await copyPathIfPresent(join(sourceProfile, relativePath), join(destinationProfile, relativePath), lstatFn);
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

async function copyPathIfPresent(source: string, destination: string, lstatFn: typeof lstat): Promise<void> {
  try {
    const stats = await lstatFn(source);
    if (stats.isSymbolicLink()) {
      throw new ChromeProfileImportError("PROFILE_INVALID", "Chrome profile contains an unsupported symbolic link.");
    }
    if (stats.isDirectory()) {
      await copyDirectory(source, destination);
    } else if (stats.isFile()) {
      await copyFileIfPresent(source, destination, lstatFn);
    }
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
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
  options: {
    findExecutable?: () => string;
    spawnChrome?: (executable: string, args: string[]) => ChildProcess;
    timeoutMs?: number;
  } = {}
): Promise<ChromeLoginDataSnapshot> {
  const urls = normalizeLoginDataUrls(role, loginDataUrls);
  const requestedOrigins = new Set(urls.map((url) => getUrlOrigin(url)).filter((origin): origin is string => Boolean(origin)));
  const initialUrl = urls[0] ?? role.launchUrl;
  const executable = (options.findExecutable ?? findSystemChromeExecutable)();
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
        client.send("Network.enable").catch(() => undefined)
      ]);
      const localStorageByOrigin: Record<string, Record<string, string>> = {};
      let externalVerification = createRuntimeVerification(
        "external",
        "auth_failed",
        "Unable to verify the imported Chrome login session."
      );
      for (const [index, url] of urls.entries()) {
        if (index > 0) {
          await navigateChromePage(client, url, options.timeoutMs ?? 10_000);
          lastNetworkActivityAt = Date.now();
        }
        const settled = await waitForSettledAuthSession(
          () => readChromeAuthSample(client!, url),
          {
            isIdle: () => Date.now() - lastNetworkActivityAt >= 1_500,
            timeoutMs: options.timeoutMs ?? 20_000
          }
        );
        const origin = getUrlOrigin(settled.finalUrl ?? url);
        if (origin && requestedOrigins.has(origin) && settled.snapshot) {
          localStorageByOrigin[origin] = settled.snapshot.localStorage;
        }
        if (index === 0) {
          externalVerification = createRuntimeVerification(
            "external",
            settled.authState,
            settled.message,
            settled.durationMs
          );
        }
      }

      if (urls.length > 1) {
        await navigateChromePage(client, initialUrl, options.timeoutMs ?? 10_000);
        lastNetworkActivityAt = Date.now();
        const settled = await waitForSettledAuthSession(
          () => readChromeAuthSample(client!, initialUrl),
          {
            isIdle: () => Date.now() - lastNetworkActivityAt >= 1_500,
            timeoutMs: options.timeoutMs ?? 20_000
          }
        );
        externalVerification = createRuntimeVerification(
          "external",
          settled.authState,
          settled.message,
          settled.durationMs
        );
      }

      const cookieResult = await client.send<{ cookies?: unknown[] }>("Network.getAllCookies");
      return {
        cookies: Array.isArray(cookieResult.cookies)
          ? cookieResult.cookies.filter(isRecord)
          : [],
        externalVerification,
        localStorageByOrigin
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
    `--app=${initialUrl}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0"
  ];
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
