import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  DEFAULT_LAUNCH_URL,
  DEFAULT_ROLE_WINDOW_HEIGHT,
  DEFAULT_ROLE_WINDOW_WIDTH,
  type AuthState,
  type CreateRoleInput,
  type LaunchPreset,
  type ReorderItemsInput,
  type Role,
  type RolePaths,
  type UpdateRoleInput
} from "../../shared/types";
import { SerialTaskQueue } from "../persistence/SerialTaskQueue";
import { writeJsonFileAtomically } from "../persistence/atomicJsonFile";

interface RolesFile {
  roles: Role[];
}

const MAX_COVER_IMAGE_DATA_URL_LENGTH = 1_500_000;
const MAX_LAUNCH_URL_LENGTH = 2_048;
const INVALID_LAUNCH_GAME_MESSAGE = "Launch game must use a valid HTTP or HTTPS URL.";
const COVER_IMAGE_DATA_URL_PATTERN = /^data:image\/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;
const COVER_IMAGE_DOMINANT_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;
const LEGACY_ROLES_FIELD = "profile" + "s";

export class RoleStoreError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "RoleStoreError";
  }
}

export class RoleStore {
  private cachedFile: RolesFile | undefined;
  private readonly rolesPath: string;
  private readonly rolesRoot: string;
  private readonly legacyRolesPath: string;
  private readonly legacyRolesRoot: string;
  private readonly taskQueue = new SerialTaskQueue();

  constructor(private readonly userDataDir: string) {
    this.rolesPath = join(userDataDir, "roles.json");
    this.rolesRoot = join(userDataDir, "roles");
    this.legacyRolesPath = join(userDataDir, "profiles.json");
    this.legacyRolesRoot = join(userDataDir, "profiles");
  }

  async listRoles(): Promise<Role[]> {
    return this.taskQueue.run(async () => {
      const file = await this.readRolesFile();
      return [...file.roles];
    });
  }

  async getRole(id: string): Promise<Role> {
    return this.taskQueue.run(async () => {
      const role = (await this.readRolesFile()).roles.find((item) => item.id === id);

      if (!role) {
        throw new RoleStoreError("ROLE_NOT_FOUND", "Role not found.");
      }

      return role;
    });
  }

  async createRole(input: CreateRoleInput): Promise<Role> {
    return this.taskQueue.run(async () => {
      const file = await this.readRolesFile();
      const now = new Date().toISOString();
      const name = this.normalizeName(input.name);

      this.ensureUniqueName(file.roles, name);
      const launchUrl = this.normalizeLaunchUrl(input.launchUrl);
      const coverImageDataUrl = this.normalizeCoverImageDataUrl(input.coverImageDataUrl);
      const coverImageDominantColor = this.normalizeCoverImageDominantColor(input.coverImageDominantColor);

      const role: Role = {
        id: randomUUID(),
        name,
        launchUrl,
        windowWidth: this.normalizeWindowSize(input.windowWidth, DEFAULT_ROLE_WINDOW_WIDTH, "windowWidth"),
        windowHeight: this.normalizeWindowSize(input.windowHeight, DEFAULT_ROLE_WINDOW_HEIGHT, "windowHeight"),
        notes: input.notes?.trim() ?? "",
        launchPreset: this.normalizeLaunchPreset(input.launchPreset),
        authState: "login_required",
        coverImageDataUrl,
        coverImageDominantColor: coverImageDataUrl ? coverImageDominantColor : undefined,
        createdAt: now,
        updatedAt: now
      };

      file.roles.push(role);
      await this.writeRolesFile(file);
      await mkdir(this.getBrowserUserDataDir(role.id), { recursive: true });

      return role;
    });
  }

  async updateRole(id: string, input: UpdateRoleInput): Promise<Role> {
    return this.taskQueue.run(async () => {
      const file = await this.readRolesFile();
      const index = file.roles.findIndex((role) => role.id === id);

      if (index === -1) {
        throw new RoleStoreError("ROLE_NOT_FOUND", "Role not found.");
      }

      const current = file.roles[index];
      const nextName = input.name === undefined ? current.name : this.normalizeName(input.name);
      const nextLaunchUrl = input.launchUrl === undefined
        ? current.launchUrl
        : this.normalizeLaunchUrl(input.launchUrl, current.launchUrl);
      const isLaunchUrlChanged = nextLaunchUrl !== current.launchUrl;
      this.ensureUniqueName(file.roles, nextName, id);
      const isCoverImageUpdated = input.coverImageDataUrl !== undefined;
      const coverImageDataUrl = isCoverImageUpdated
        ? this.normalizeCoverImageDataUrl(input.coverImageDataUrl)
        : current.coverImageDataUrl;
      const coverImageDominantColor = this.normalizeUpdatedCoverImageDominantColor(
        current,
        coverImageDataUrl,
        isCoverImageUpdated,
        input.coverImageDominantColor
      );

      const updated: Role = {
        ...current,
        name: nextName,
        launchUrl: nextLaunchUrl,
        windowWidth: input.windowWidth === undefined
          ? current.windowWidth
          : this.normalizeWindowSize(input.windowWidth, current.windowWidth, "windowWidth"),
        windowHeight: input.windowHeight === undefined
          ? current.windowHeight
          : this.normalizeWindowSize(input.windowHeight, current.windowHeight, "windowHeight"),
        notes: input.notes === undefined ? current.notes : input.notes.trim(),
        launchPreset: input.launchPreset === undefined
          ? current.launchPreset
          : this.normalizeLaunchPreset(input.launchPreset),
        authState: isLaunchUrlChanged ? "login_required" : current.authState,
        lastSuccessfulLoginAt: isLaunchUrlChanged ? undefined : current.lastSuccessfulLoginAt,
        coverImageDataUrl,
        coverImageDominantColor,
        updatedAt: new Date().toISOString()
      };

      file.roles[index] = updated;
      await this.writeRolesFile(file);

      return updated;
    });
  }

  async reorderRoles(input: ReorderItemsInput): Promise<Role[]> {
    return this.taskQueue.run(async () => {
      const file = await this.readRolesFile();
      const roles = this.reorderItems(file.roles, input);

      await this.writeRolesFile({ roles });
      return [...roles];
    });
  }

  async deleteRole(id: string): Promise<void> {
    return this.taskQueue.run(async () => {
      const file = await this.readRolesFile();
      const nextRoles = file.roles.filter((role) => role.id !== id);

      if (nextRoles.length === file.roles.length) {
        throw new RoleStoreError("ROLE_NOT_FOUND", "Role not found.");
      }

      await this.writeRolesFile({ roles: nextRoles });
      await rm(join(this.rolesRoot, id), { force: true, recursive: true });
    });
  }

  async updateAuthState(
    id: string,
    authState: AuthState,
    messageTimestamp = new Date().toISOString()
  ): Promise<Role> {
    return this.taskQueue.run(async () => {
      const file = await this.readRolesFile();
      const index = file.roles.findIndex((role) => role.id === id);

      if (index === -1) {
        throw new RoleStoreError("ROLE_NOT_FOUND", "Role not found.");
      }

      const current = file.roles[index];
      const updated: Role = {
        ...current,
        authState,
        lastAuthCheckAt: messageTimestamp,
        lastSuccessfulLoginAt: authState === "authenticated" ? messageTimestamp : current.lastSuccessfulLoginAt,
        updatedAt: messageTimestamp
      };

      file.roles[index] = updated;
      await this.writeRolesFile(file);

      return updated;
    });
  }

  getRolePaths(id: string): RolePaths {
    return {
      browserUserDataDir: this.getBrowserUserDataDir(id)
    };
  }

  async ensureBrowserUserDataDir(id: string): Promise<string> {
    return this.taskQueue.run(async () => {
      const roleExists = (await this.readRolesFile()).roles.some((role) => role.id === id);

      if (!roleExists) {
        throw new RoleStoreError("ROLE_NOT_FOUND", "Role not found.");
      }

      const browserUserDataDir = this.getBrowserUserDataDir(id);
      await mkdir(browserUserDataDir, { recursive: true });
      return browserUserDataDir;
    });
  }

  private getBrowserUserDataDir(id: string): string {
    return join(this.rolesRoot, id, "browser");
  }

  private async readRolesFile(): Promise<RolesFile> {
    if (this.cachedFile) {
      return cloneRolesFile(this.cachedFile);
    }

    try {
      const raw = await readFile(this.rolesPath, "utf8");
      const parsed = JSON.parse(raw) as RolesFile;

      if (!Array.isArray(parsed.roles)) {
        throw new RoleStoreError("ROLE_FILE_INVALID", "Role data file is invalid.");
      }

      const file = {
        roles: parsed.roles.map((role) => this.normalizeStoredRole(role))
      };

      await this.migrateLegacyRoleDirectories(file.roles.map((role) => role.id));
      this.cachedFile = cloneRolesFile(file);
      return cloneRolesFile(file);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return this.readLegacyRolesFile();
      }

      throw error;
    }
  }

  private async readLegacyRolesFile(): Promise<RolesFile> {
    try {
      const raw = await readFile(this.legacyRolesPath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const legacyRoles = parsed[LEGACY_ROLES_FIELD];

      if (!Array.isArray(legacyRoles)) {
        throw new RoleStoreError("ROLE_FILE_INVALID", "Role data file is invalid.");
      }

      const file = {
        roles: legacyRoles.map((role) => this.normalizeStoredRole(role as Role))
      };

      await this.migrateLegacyRoleDirectories(file.roles.map((role) => role.id));
      await this.writeRolesFile(file);
      return cloneRolesFile(file);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { roles: [] };
      }

      throw error;
    }
  }

  private async writeRolesFile(file: RolesFile): Promise<void> {
    await mkdir(this.rolesRoot, { recursive: true });
    await writeJsonFileAtomically(this.rolesPath, file);
    this.cachedFile = cloneRolesFile(file);
  }

  private normalizeName(name: string): string {
    const normalized = name.trim();

    if (!normalized) {
      throw new RoleStoreError("ROLE_NAME_REQUIRED", "Role name is required.");
    }

    if (normalized.length > 80) {
      throw new RoleStoreError("ROLE_NAME_TOO_LONG", "Role name must be 80 characters or fewer.");
    }

    return normalized;
  }

  private normalizeWindowSize(value: number | undefined, fallback: number, field: string): number {
    const size = value ?? fallback;

    if (!Number.isInteger(size) || size < 640 || size > 7680) {
      throw new RoleStoreError("ROLE_WINDOW_SIZE_INVALID", `${field} must be between 640 and 7680.`);
    }

    return size;
  }

  private normalizeLaunchPreset(value: LaunchPreset | undefined): LaunchPreset {
    if (value === undefined) {
      return "performance";
    }

    if (value !== "balanced" && value !== "performance") {
      throw new RoleStoreError("ROLE_PRESET_INVALID", "Launch preset is invalid.");
    }

    return value;
  }

  private normalizeStoredRole(role: Role): Role {
    const {
      gameUrl: legacyLaunchUrl,
      loginProvider: _loginProvider,
      ...storedRole
    } = role as Role & { gameUrl?: unknown; loginProvider?: unknown };
    const launchUrl = this.normalizeLaunchUrl(
      typeof storedRole.launchUrl === "string"
        ? storedRole.launchUrl
        : typeof legacyLaunchUrl === "string"
          ? legacyLaunchUrl
          : undefined
    );
    const coverImageDataUrl = this.normalizeCoverImageDataUrl(storedRole.coverImageDataUrl);

    return {
      ...storedRole,
      launchUrl,
      authState: this.normalizeAuthState(storedRole.authState),
      notes: storedRole.notes ?? "",
      launchPreset: this.normalizeLaunchPreset(storedRole.launchPreset),
      coverImageDataUrl,
      coverImageDominantColor: coverImageDataUrl
        ? this.normalizeCoverImageDominantColor(storedRole.coverImageDominantColor)
        : undefined,
      lastAuthCheckAt: storedRole.lastAuthCheckAt,
      lastSuccessfulLoginAt: storedRole.lastSuccessfulLoginAt
    };
  }

  private normalizeLaunchUrl(value: string | undefined, fallback = DEFAULT_LAUNCH_URL): string {
    const rawValue = value === undefined ? fallback : value.trim();

    if (!rawValue) {
      throw new RoleStoreError("ROLE_LAUNCH_URL_INVALID", INVALID_LAUNCH_GAME_MESSAGE);
    }

    if (rawValue.length > MAX_LAUNCH_URL_LENGTH) {
      throw new RoleStoreError("ROLE_LAUNCH_URL_INVALID", INVALID_LAUNCH_GAME_MESSAGE);
    }

    try {
      const url = new URL(rawValue);

      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("Unsupported URL protocol.");
      }

      return url.toString();
    } catch {
      throw new RoleStoreError("ROLE_LAUNCH_URL_INVALID", INVALID_LAUNCH_GAME_MESSAGE);
    }
  }

  private normalizeAuthState(value: AuthState | undefined): AuthState {
    if (value === "unknown" || value === "login_required" || value === "authenticated" || value === "auth_failed") {
      return value;
    }

    return "unknown";
  }

  private normalizeCoverImageDataUrl(value: string | null | undefined): string | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }

    const trimmed = value.trim();

    if (!trimmed) {
      return undefined;
    }

    if (trimmed.length > MAX_COVER_IMAGE_DATA_URL_LENGTH || !COVER_IMAGE_DATA_URL_PATTERN.test(trimmed)) {
      throw new RoleStoreError("ROLE_COVER_IMAGE_INVALID", "Role cover image must be a valid image data URL.");
    }

    return trimmed;
  }

  private normalizeCoverImageDominantColor(value: string | null | undefined): string | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }

    const trimmed = value.trim();

    if (!trimmed) {
      return undefined;
    }

    if (!COVER_IMAGE_DOMINANT_COLOR_PATTERN.test(trimmed)) {
      throw new RoleStoreError(
        "ROLE_COVER_COLOR_INVALID",
        "Role cover dominant color must be a valid hex color."
      );
    }

    return trimmed.toUpperCase();
  }

  private normalizeUpdatedCoverImageDominantColor(
    current: Role,
    coverImageDataUrl: string | undefined,
    isCoverImageUpdated: boolean,
    inputValue: string | null | undefined
  ): string | undefined {
    if (!coverImageDataUrl) {
      if (inputValue !== undefined) {
        this.normalizeCoverImageDominantColor(inputValue);
      }

      return undefined;
    }

    if (inputValue !== undefined) {
      return this.normalizeCoverImageDominantColor(inputValue);
    }

    return isCoverImageUpdated ? undefined : current.coverImageDominantColor;
  }

  private ensureUniqueName(roles: Role[], name: string, currentId?: string): void {
    const duplicate = roles.some(
      (role) => role.id !== currentId && role.name.toLocaleLowerCase() === name.toLocaleLowerCase()
    );

    if (duplicate) {
      throw new RoleStoreError("ROLE_NAME_DUPLICATE", "A role with this name already exists.");
    }
  }

  private reorderItems(roles: Role[], input: ReorderItemsInput): Role[] {
    const orderedIds = input?.orderedIds;

    if (!Array.isArray(orderedIds) || orderedIds.length !== roles.length) {
      throw new RoleStoreError("ROLE_ORDER_INVALID", "Role order is invalid.");
    }

    const roleById = new Map(roles.map((role) => [role.id, role]));
    const uniqueIds = new Set(orderedIds);

    if (uniqueIds.size !== roles.length || orderedIds.some((id) => typeof id !== "string" || !roleById.has(id))) {
      throw new RoleStoreError("ROLE_ORDER_INVALID", "Role order is invalid.");
    }

    return orderedIds.map((id) => roleById.get(id) as Role);
  }

  private async migrateLegacyRoleDirectories(roleIds: string[]): Promise<void> {
    if (!(await pathExists(this.legacyRolesRoot))) {
      return;
    }

    if (!(await pathExists(this.rolesRoot))) {
      await rename(this.legacyRolesRoot, this.rolesRoot);
      return;
    }

    await mkdir(this.rolesRoot, { recursive: true });

    for (const roleId of roleIds) {
      const legacyRoleDir = join(this.legacyRolesRoot, roleId);
      const roleDir = join(this.rolesRoot, roleId);

      if (!(await pathExists(legacyRoleDir)) || (await pathExists(roleDir))) {
        continue;
      }

      await rename(legacyRoleDir, roleDir);
    }
  }
}

function cloneRolesFile(file: RolesFile): RolesFile {
  return {
    roles: file.roles.map((role) => ({ ...role }))
  };
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
