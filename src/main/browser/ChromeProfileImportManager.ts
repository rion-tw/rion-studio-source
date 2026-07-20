import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, copyFile, lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Session } from "electron";

import type {
  AuthState,
  ChromeProfileEntry,
  ChromeProfileImportInput,
  ChromeProfileImportPreview,
  ChromeProfileImportResult,
  ChromeProfileImportRoleResult,
  ChromeProfileImportRuntimeState,
  ChromeProfileImportWarning,
  Role
} from "../../shared/types";
import {
  createLoginStorageSnapshot,
  isPersistedLoginStorageReady,
  LOGIN_STORAGE_EXPRESSION
} from "../auth/loginEvidence";
import { classifyAuthSession } from "../auth/authSessionClassification";
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

interface OpenDirectoryDialogOptions {
  properties: Array<"openDirectory">;
  title: string;
  defaultPath?: string;
}

interface OpenDirectoryDialogResult {
  canceled: boolean;
  filePaths: string[];
}

interface ChromeSessionSnapshot {
  authState: Exclude<AuthState, "unknown">;
  cookies: Array<Record<string, unknown>>;
  indexedDb?: Record<string, string>;
  localStorage: Record<string, string>;
}

interface PendingImport {
  importId: string;
  sourceUserDataDir: string;
  profiles: Map<string, ChromeProfileEntry>;
}

interface ChromeImportJournal {
  importId: string;
  roleIds: string[];
}

interface ChromeProfileImportManagerOptions {
  createImportId?: () => string;
  getSession?: (partition: string) => Pick<Session, "cookies">;
  homeDirectory?: string;
  injectEmbeddedStorage?: (
    partition: string,
    url: string,
    values: Record<string, string>
  ) => Promise<void>;
  lstat?: typeof lstat;
  platform?: NodeJS.Platform;
  readChromeSession?: (
    userDataDir: string,
    role: Pick<Role, "launchUrl">,
    verificationUrl?: string
  ) => Promise<ChromeSessionSnapshot>;
  roleStore: Pick<
    RoleStore,
    "createRole" | "deleteRole" | "getRolePaths" | "listRoles" | "updateAuthState" | "updateRole"
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
    const usedNames = new Set(
      existingRoles
        .filter((role) => role.gameId === game.id)
        .map((role) => normalizeNameKey(role.name))
    );
    const stageRoot = join(this.options.userDataDir, IMPORT_DIRECTORY, input.importId);
    const journalPath = join(this.options.userDataDir, IMPORT_JOURNAL);
    const createdRoleIds: string[] = [];
    const results: ChromeProfileImportRoleResult[] = [];
    const warnings: ChromeProfileImportWarning[] = [{ code: "passwords_excluded" }];

    await rm(stageRoot, { force: true, recursive: true });
    await mkdir(stageRoot, { recursive: true });
    await writeJsonFileAtomically(journalPath, { importId: input.importId, roleIds: [] } satisfies ChromeImportJournal);

    try {
      for (const profile of selectedProfiles) {
        const roleName = reserveRoleName(profile.name || profile.directoryName, usedNames);
        if (roleName !== profile.name) {
          warnings.push({
            code: "name_renamed",
            profileId: profile.id,
            profileName: profile.name,
            replacementName: roleName
          });
        }

        const stageBrowserDir = join(stageRoot, profile.id);
        await copyChromeProfile(pending.sourceUserDataDir, profile.directoryName, stageBrowserDir, this.lstat);
        const role = await this.options.roleStore.createRole({
          gameId: game.id,
          launchUrl: game.defaultLaunchUrl,
          name: roleName,
          notes: "Imported from a local Chrome profile."
        });
        createdRoleIds.push(role.id);
        await writeJsonFileAtomically(journalPath, { importId: input.importId, roleIds: createdRoleIds } satisfies ChromeImportJournal);

        const targetBrowserDir = this.options.roleStore.getRolePaths(role.id).browserUserDataDir;
        await rm(targetBrowserDir, { force: true, recursive: true });
        await copyDirectory(stageBrowserDir, targetBrowserDir);

        const runtime = await this.verifyAndSeedRuntime(targetBrowserDir, role, game.loginUrl ?? role.launchUrl);
        if (runtime.embedded === "unavailable") {
          warnings.push({ code: "embedded_unavailable", profileId: profile.id, profileName: profile.name });
        }
        if (runtime.external === "unavailable") {
          warnings.push({ code: "external_unavailable", profileId: profile.id, profileName: profile.name });
        }
        if (runtime.embedded === "login_required" && runtime.external === "login_required") {
          warnings.push({ code: "login_not_detected", profileId: profile.id, profileName: profile.name });
        }
        let updatedRole = role;
        if (runtime.authState === "authenticated") {
          updatedRole = await this.options.roleStore.updateAuthState(role.id, "authenticated");
        }
        if (runtime.preferredBrowserLaunchMode) {
          updatedRole = await this.options.roleStore.updateRole(role.id, {
            preferredBrowserLaunchMode: runtime.preferredBrowserLaunchMode
          });
        }

        results.push({
          authState: updatedRole.authState,
          embedded: runtime.embedded,
          external: runtime.external,
          profileId: profile.id,
          profileName: profile.name,
          roleId: updatedRole.id,
          roleName: updatedRole.name
        });
      }

      const roles = await this.options.roleStore.listRoles();
      this.pending.delete(input.importId);
      await removeStagingDirectory(this.options.userDataDir, input.importId);
      await rm(journalPath, { force: true });
      return {
        roles: roles.filter((role) => createdRoleIds.includes(role.id)),
        results,
        warnings
      };
    } catch (error) {
      const deletionResults = await Promise.all(createdRoleIds.map(async (roleId) => {
        try {
          await this.options.roleStore.deleteRole(roleId);
          return true;
        } catch {
          return false;
        }
      }));
      await removeStagingDirectory(this.options.userDataDir, input.importId);
      if (deletionResults.every(Boolean)) {
        await rm(journalPath, { force: true });
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

  private async verifyAndSeedRuntime(
    browserUserDataDir: string,
    role: Role,
    verificationUrl: string
  ): Promise<{
    embedded: ChromeProfileImportRuntimeState;
    external: ChromeProfileImportRuntimeState;
    preferredBrowserLaunchMode?: "embedded" | "external";
    authState: AuthState;
  }> {
    if (!this.options.readChromeSession) {
      return {
        authState: "login_required",
        embedded: "not_checked",
        external: "not_checked"
      };
    }

    let snapshot: ChromeSessionSnapshot;
    try {
      snapshot = await this.options.readChromeSession(browserUserDataDir, role, verificationUrl);
    } catch {
      return {
        authState: "login_required",
        embedded: "unavailable",
        external: "unavailable"
      };
    }

    const external = snapshot.authState === "authenticated" ? "authenticated" : "login_required";
    let embedded: ChromeProfileImportRuntimeState = "unavailable";
    if (this.options.getSession && this.options.injectEmbeddedStorage) {
      try {
        const session = this.options.getSession(`persist:rion-role-${role.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`);
        for (const cookie of snapshot.cookies) {
          await session.cookies.set(normalizeElectronCookie(cookie, verificationUrl));
        }
        await this.options.injectEmbeddedStorage(
          `persist:rion-role-${role.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`,
          verificationUrl,
          snapshot.localStorage
        );
        embedded = Object.keys(snapshot.indexedDb ?? {}).length > 0
          ? "unavailable"
          : snapshot.authState === "authenticated"
            ? "authenticated"
            : "login_required";
      } catch {
        embedded = "unavailable";
      }
    }

    const authState: AuthState = embedded === "authenticated" || external === "authenticated"
      ? "authenticated"
      : "login_required";
    const preferredBrowserLaunchMode = embedded === "authenticated"
      ? "embedded"
      : external === "authenticated"
        ? "external"
        : undefined;

    return { authState, embedded, external, preferredBrowserLaunchMode };
  }
}

export async function recoverChromeProfileImport(
  userDataDir: string,
  roleStore?: Pick<RoleStore, "deleteRole">
): Promise<void> {
  const journalPath = join(userDataDir, IMPORT_JOURNAL);
  let canRemoveJournal = true;
  try {
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as Partial<ChromeImportJournal>;
    if (roleStore && Array.isArray(journal.roleIds)) {
      for (const id of journal.roleIds.filter((value): value is string => typeof value === "string")) {
        try {
          await roleStore.deleteRole(id);
        } catch (error) {
          const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
          if (code !== "ROLE_NOT_FOUND") {
            canRemoveJournal = false;
          }
        }
      }
    }
  } catch {
    // A missing or malformed journal is recovered by removing the staging directory.
  }
  await rm(join(userDataDir, IMPORT_DIRECTORY), { force: true, recursive: true });
  if (canRemoveJournal) {
    await rm(journalPath, { force: true });
  }
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

function reserveRoleName(name: string, usedNames: Set<string>): string {
  const baseName = (name.trim() || "Chrome Profile").slice(0, 80);
  let candidate = baseName;
  let suffix = 2;
  while (usedNames.has(normalizeNameKey(candidate))) {
    const suffixText = ` (${suffix})`;
    candidate = `${baseName.slice(0, Math.max(1, 80 - suffixText.length))}${suffixText}`;
    suffix += 1;
  }
  usedNames.add(normalizeNameKey(candidate));
  return candidate;
}

function normalizeNameKey(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function isSafeImportId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}

function normalizeElectronCookie(cookie: Record<string, unknown>, fallbackUrl: string): Parameters<Session["cookies"]["set"]>[0] {
  const domain = typeof cookie.domain === "string" ? cookie.domain : undefined;
  return {
    url: fallbackUrl,
    name: typeof cookie.name === "string" ? cookie.name : "",
    value: typeof cookie.value === "string" ? cookie.value : "",
    ...(domain ? { domain } : {}),
    ...(typeof cookie.path === "string" ? { path: cookie.path } : {}),
    ...(typeof cookie.expirationDate === "number" ? { expirationDate: cookie.expirationDate } : {}),
    ...(typeof cookie.httpOnly === "boolean" ? { httpOnly: cookie.httpOnly } : {}),
    ...(typeof cookie.secure === "boolean" ? { secure: cookie.secure } : {}),
    ...(cookie.sameSite === "strict" || cookie.sameSite === "lax" || cookie.sameSite === "no_restriction" || cookie.sameSite === "unspecified"
      ? { sameSite: cookie.sameSite }
      : {})
  } as Parameters<Session["cookies"]["set"]>[0];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export async function readChromeSessionWithCdp(
  userDataDir: string,
  role: Pick<Role, "launchUrl">,
  verificationUrl = role.launchUrl,
  options: {
    findExecutable?: () => string;
    spawnChrome?: (executable: string, args: string[]) => ChildProcess;
    timeoutMs?: number;
  } = {}
): Promise<ChromeSessionSnapshot> {
  const executable = (options.findExecutable ?? findSystemChromeExecutable)();
  const child = (options.spawnChrome ?? ((path, args) => spawn(path, args, { stdio: "ignore" })))(executable, [
    `--user-data-dir=${userDataDir}`,
    `--app=${verificationUrl}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0"
  ]);

  try {
    await waitForChildSpawn(child);
    const port = await waitForDevToolsPort(userDataDir, { timeoutMs: options.timeoutMs ?? 10_000 });
    if (port.state !== "available") {
      throw new ChromeProfileImportError("EXTERNAL_UNAVAILABLE", "Unable to inspect the imported Chrome profile.");
    }
    const target = await waitForPageTarget(port.port, verificationUrl, options.timeoutMs ?? 10_000);
    if (!target?.webSocketDebuggerUrl) {
      throw new ChromeProfileImportError("EXTERNAL_UNAVAILABLE", "Imported Chrome profile did not expose a page target.");
    }
    const client = new CdpClient(target.webSocketDebuggerUrl);
    try {
      const [cookieResult, runtimeResult] = await Promise.all([
        client.send<{ cookies?: unknown[] }>("Network.getAllCookies"),
        client.send<{ result?: { value?: unknown } }>("Runtime.evaluate", {
          expression: LOGIN_STORAGE_EXPRESSION,
          returnByValue: true,
          awaitPromise: true
        })
      ]);
      const snapshot = createLoginStorageSnapshot(cookieResult.cookies, runtimeResult.result?.value);
      const auth = classifyAuthSession(
        target.url ?? verificationUrl,
        snapshot.bodyText,
        isPersistedLoginStorageReady(snapshot)
      );
      return {
        authState: auth.authState,
        cookies: Array.isArray(cookieResult.cookies)
          ? cookieResult.cookies.filter(isRecord)
          : [],
        indexedDb: snapshot.indexedDb,
        localStorage: snapshot.localStorage
      };
    } finally {
      client.close();
    }
  } finally {
    await terminateChrome(child);
  }
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
