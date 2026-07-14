import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, posix, win32 } from "node:path";

import type {
  CreateLaunchWorkspaceInput,
  LaunchWorkspace,
  LaunchWorkspaceSlot,
  NormalizedRect,
  ReorderItemsInput,
  UpdateLaunchWorkspaceInput,
  WorkspaceBrowserZoomPercent,
  WorkspaceCompanion,
  WorkspaceCompanionApplicationTarget,
  WorkspaceCompanionTarget,
  WorkspaceLayoutTemplate
} from "../../shared/types";
import {
  isWorkspaceCompanionPlacement,
  isWorkspaceCompanionSizePercent
} from "../../shared/workspaceCompanion";
import {
  createDefaultWorkspaceSlots,
  DEFAULT_WORKSPACE_BROWSER_ZOOM_PERCENT,
  DEFAULT_WORKSPACE_TEMPLATE,
  getDefaultWorkspaceBrowserZoomPercent,
  getDefaultWorkspaceRects,
  getWorkspaceTemplateSlotCount,
  isWorkspaceBrowserZoomPercent,
  isWorkspaceLayoutTemplate,
  MAX_WORKSPACE_SLOTS,
  MIN_WORKSPACE_SLOT_SIZE
} from "../../shared/workspaceLayout";
import { SerialTaskQueue } from "../persistence/SerialTaskQueue";
import { writeJsonFileAtomically } from "../persistence/atomicJsonFile";

interface LaunchWorkspacesFile {
  workspaces: LaunchWorkspace[];
}

type StoredLaunchWorkspaceSlot = Partial<LaunchWorkspaceSlot> & {
  [key: string]: unknown;
};

type StoredLaunchWorkspace = Omit<
  LaunchWorkspace,
  "browserZoomPercent" | "companion" | "slots" | "targetDisplayId"
> & {
  browserZoomPercent?: unknown;
  companion?: unknown;
  targetDisplayId?: unknown;
  slots: StoredLaunchWorkspaceSlot[];
};

const LEGACY_ROLE_ID_FIELD = "profile" + "Id";
const LEGACY_CENTERED_MAIN_DEFAULT_RECTS: NormalizedRect[] = [
  { x: 0.25, y: 0, width: 0.5, height: 1 },
  { x: 0, y: 0, width: 0.25, height: 0.5 },
  { x: 0, y: 0.5, width: 0.25, height: 0.5 },
  { x: 0.75, y: 0, width: 0.25, height: 0.5 },
  { x: 0.75, y: 0.5, width: 0.25, height: 0.5 }
];

const WORKSPACE_NAME_MAX_LENGTH = 80;
const COMPANION_APP_LABEL_MAX_LENGTH = 80;
const COMPANION_APP_PATH_MAX_LENGTH = 4_096;
const COMPANION_URL_MAX_LENGTH = 2_048;
export class LaunchWorkspaceStoreError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "LaunchWorkspaceStoreError";
  }
}

export class LaunchWorkspaceStore {
  private cachedFile: LaunchWorkspacesFile | undefined;
  private readonly taskQueue = new SerialTaskQueue();
  private readonly workspacesPath: string;

  constructor(private readonly userDataDir: string) {
    this.workspacesPath = join(userDataDir, "launch-workspaces.json");
  }

  async listWorkspaces(): Promise<LaunchWorkspace[]> {
    return this.taskQueue.run(async () => {
      const file = await this.readWorkspacesFile();
      return [...file.workspaces];
    });
  }

  async getWorkspace(id: string): Promise<LaunchWorkspace> {
    return this.taskQueue.run(async () => {
      const workspace = (await this.readWorkspacesFile()).workspaces.find((item) => item.id === id);

      if (!workspace) {
        throw new LaunchWorkspaceStoreError("WORKSPACE_NOT_FOUND", "Launch workspace not found.");
      }

      return workspace;
    });
  }

  async createWorkspace(input: CreateLaunchWorkspaceInput): Promise<LaunchWorkspace> {
    return this.taskQueue.run(async () => {
      const file = await this.readWorkspacesFile();
      const now = new Date().toISOString();
      const name = this.normalizeName(input.name);
      const template = this.normalizeTemplate(input.template);
      const browserZoomPercent = this.normalizeBrowserZoomPercent(
        input.browserZoomPercent,
        getDefaultWorkspaceBrowserZoomPercent(template)
      );
      const targetDisplayId = this.normalizeTargetDisplayId(input.targetDisplayId);
      const companion = this.normalizeCompanion(input.companion);

      this.ensureUniqueName(file.workspaces, name);

      const workspace: LaunchWorkspace = {
        id: randomUUID(),
        name,
        template,
        browserZoomPercent,
        ...(targetDisplayId === undefined ? {} : { targetDisplayId }),
        ...(companion === undefined ? {} : { companion }),
        slots: this.normalizeSlots(template, input.slots),
        createdAt: now,
        updatedAt: now
      };

      file.workspaces.push(workspace);
      await this.writeWorkspacesFile(file);

      return workspace;
    });
  }

  async updateWorkspace(id: string, input: UpdateLaunchWorkspaceInput): Promise<LaunchWorkspace> {
    return this.taskQueue.run(async () => {
      const file = await this.readWorkspacesFile();
      const index = file.workspaces.findIndex((workspace) => workspace.id === id);

      if (index === -1) {
        throw new LaunchWorkspaceStoreError("WORKSPACE_NOT_FOUND", "Launch workspace not found.");
      }

      const current = file.workspaces[index];
      const name = input.name === undefined ? current.name : this.normalizeName(input.name);
      const template = input.template === undefined ? current.template : this.normalizeTemplate(input.template);
      const browserZoomPercent = this.normalizeBrowserZoomPercent(
        input.browserZoomPercent,
        current.browserZoomPercent
      );
      const targetDisplayId = input.targetDisplayId === undefined
        ? current.targetDisplayId
        : this.normalizeTargetDisplayId(input.targetDisplayId);
      const companion = input.companion === undefined
        ? current.companion
        : this.normalizeCompanion(input.companion);
      const sourceSlots = input.slots ?? (
        input.template === undefined
          ? current.slots
          : current.slots.slice(0, getWorkspaceTemplateSlotCount(template))
      );

      this.ensureUniqueName(file.workspaces, name, id);

      const updated: LaunchWorkspace = {
        ...current,
        name,
        template,
        browserZoomPercent,
        slots: this.normalizeSlots(template, sourceSlots),
        updatedAt: new Date().toISOString()
      };
      if (targetDisplayId === undefined) {
        delete updated.targetDisplayId;
      } else {
        updated.targetDisplayId = targetDisplayId;
      }
      if (companion === undefined) {
        delete updated.companion;
      } else {
        updated.companion = companion;
      }

      file.workspaces[index] = updated;
      await this.writeWorkspacesFile(file);

      return updated;
    });
  }

  async reorderWorkspaces(input: ReorderItemsInput): Promise<LaunchWorkspace[]> {
    return this.taskQueue.run(async () => {
      const file = await this.readWorkspacesFile();
      const workspaces = this.reorderItems(file.workspaces, input);

      await this.writeWorkspacesFile({ workspaces });
      return [...workspaces];
    });
  }

  async deleteWorkspace(id: string): Promise<void> {
    return this.taskQueue.run(async () => {
      const file = await this.readWorkspacesFile();
      const nextWorkspaces = file.workspaces.filter((workspace) => workspace.id !== id);

      if (nextWorkspaces.length === file.workspaces.length) {
        throw new LaunchWorkspaceStoreError("WORKSPACE_NOT_FOUND", "Launch workspace not found.");
      }

      await this.writeWorkspacesFile({ workspaces: nextWorkspaces });
    });
  }

  async clearRole(roleId: string): Promise<void> {
    return this.taskQueue.run(async () => {
      const file = await this.readWorkspacesFile();
      let didChange = false;
      const now = new Date().toISOString();

      const workspaces = file.workspaces.map((workspace) => {
        let workspaceChanged = false;
        const slots = workspace.slots.map((slot) => {
          if (slot.roleId !== roleId) {
            return slot;
          }

          didChange = true;
          workspaceChanged = true;
          const { roleId: _roleId, ...nextSlot } = slot;
          return nextSlot;
        });

        return workspaceChanged ? { ...workspace, slots, updatedAt: now } : workspace;
      });

      if (!didChange) {
        return;
      }

      await this.writeWorkspacesFile({ workspaces });
    });
  }

  private async readWorkspacesFile(): Promise<LaunchWorkspacesFile> {
    if (this.cachedFile) {
      return cloneWorkspacesFile(this.cachedFile);
    }

    try {
      const raw = await readFile(this.workspacesPath, "utf8");
      const parsed = JSON.parse(raw) as LaunchWorkspacesFile;

      if (!Array.isArray(parsed.workspaces)) {
        throw new LaunchWorkspaceStoreError("WORKSPACE_FILE_INVALID", "Launch workspace data file is invalid.");
      }

      const didMigrate = parsed.workspaces.some(
        (workspace) =>
          hasLegacyRoleSlotReference(workspace) ||
          hasLegacyCenteredMainDefaultLayout(workspace as StoredLaunchWorkspace)
      );
      const file = {
        workspaces: parsed.workspaces.map((workspace) =>
          this.normalizeStoredWorkspace(workspace as StoredLaunchWorkspace)
        )
      };

      if (didMigrate) {
        await this.writeWorkspacesFile(file);
      } else {
        this.cachedFile = cloneWorkspacesFile(file);
      }

      return cloneWorkspacesFile(file);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { workspaces: [] };
      }

      throw error;
    }
  }

  private async writeWorkspacesFile(file: LaunchWorkspacesFile): Promise<void> {
    await writeJsonFileAtomically(this.workspacesPath, file);
    this.cachedFile = cloneWorkspacesFile({
      workspaces: file.workspaces.map((workspace) =>
        this.normalizeStoredWorkspace(workspace as StoredLaunchWorkspace)
      )
    });
  }

  private normalizeStoredWorkspace(workspace: StoredLaunchWorkspace): LaunchWorkspace {
    const template = this.normalizeTemplate(workspace.template);
    const targetDisplayId = this.normalizeTargetDisplayId(workspace.targetDisplayId);
    const companion = this.normalizeCompanion(workspace.companion);
    const slots = this.normalizeSlots(template, workspace.slots as StoredLaunchWorkspaceSlot[]);
    const normalizedSlots = hasLegacyCenteredMainDefaultLayout(workspace)
      ? slots.map((slot, index) => ({
          ...slot,
          rect: getDefaultWorkspaceRects(template)[index]
        }))
      : slots;

    return {
      id: typeof workspace.id === "string" && workspace.id.trim() ? workspace.id : randomUUID(),
      name: this.normalizeName(workspace.name),
      template,
      browserZoomPercent: this.normalizeBrowserZoomPercent(
        workspace.browserZoomPercent,
        DEFAULT_WORKSPACE_BROWSER_ZOOM_PERCENT
      ),
      ...(targetDisplayId === undefined ? {} : { targetDisplayId }),
      ...(companion === undefined ? {} : { companion }),
      slots: normalizedSlots,
      createdAt: typeof workspace.createdAt === "string" ? workspace.createdAt : new Date().toISOString(),
      updatedAt: typeof workspace.updatedAt === "string" ? workspace.updatedAt : new Date().toISOString()
    };
  }

  private normalizeName(name: string | undefined): string {
    const normalized = name?.trim() ?? "";

    if (!normalized) {
      throw new LaunchWorkspaceStoreError("WORKSPACE_NAME_REQUIRED", "Launch workspace name is required.");
    }

    if (normalized.length > WORKSPACE_NAME_MAX_LENGTH) {
      throw new LaunchWorkspaceStoreError(
        "WORKSPACE_NAME_TOO_LONG",
        "Launch workspace name must be 80 characters or fewer."
      );
    }

    return normalized;
  }

  private reorderItems(workspaces: LaunchWorkspace[], input: ReorderItemsInput): LaunchWorkspace[] {
    const orderedIds = input?.orderedIds;

    if (!Array.isArray(orderedIds) || orderedIds.length !== workspaces.length) {
      throw new LaunchWorkspaceStoreError("WORKSPACE_ORDER_INVALID", "Launch workspace order is invalid.");
    }

    const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
    const uniqueIds = new Set(orderedIds);

    if (
      uniqueIds.size !== workspaces.length ||
      orderedIds.some((id) => typeof id !== "string" || !workspaceById.has(id))
    ) {
      throw new LaunchWorkspaceStoreError("WORKSPACE_ORDER_INVALID", "Launch workspace order is invalid.");
    }

    return orderedIds.map((id) => workspaceById.get(id) as LaunchWorkspace);
  }

  private normalizeTemplate(template: WorkspaceLayoutTemplate | undefined): WorkspaceLayoutTemplate {
    if (template === undefined) {
      return DEFAULT_WORKSPACE_TEMPLATE;
    }

    if (!isWorkspaceLayoutTemplate(template)) {
      throw new LaunchWorkspaceStoreError("WORKSPACE_TEMPLATE_INVALID", "Launch workspace layout is invalid.");
    }

    return template;
  }

  private normalizeBrowserZoomPercent(
    value: unknown,
    fallback: WorkspaceBrowserZoomPercent
  ): WorkspaceBrowserZoomPercent {
    if (value === undefined) {
      return fallback;
    }

    if (!isWorkspaceBrowserZoomPercent(value)) {
      throw new LaunchWorkspaceStoreError(
        "WORKSPACE_BROWSER_ZOOM_INVALID",
        "Launch workspace browser zoom is invalid."
      );
    }

    return value;
  }

  private normalizeTargetDisplayId(value: unknown): number | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }

    if (typeof value !== "number" || !Number.isSafeInteger(value) || value === -1) {
      throw new LaunchWorkspaceStoreError(
        "WORKSPACE_TARGET_DISPLAY_INVALID",
        "Launch workspace target display is invalid."
      );
    }

    return value;
  }

  private normalizeCompanion(value: unknown): WorkspaceCompanion | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }

    if (!isRecord(value)) {
      throw new LaunchWorkspaceStoreError(
        "WORKSPACE_COMPANION_INVALID",
        "Launch workspace companion area is invalid."
      );
    }

    if (!isWorkspaceCompanionPlacement(value.placement)) {
      throw new LaunchWorkspaceStoreError(
        "WORKSPACE_COMPANION_PLACEMENT_INVALID",
        "Launch workspace companion placement is invalid."
      );
    }

    if (!isWorkspaceCompanionSizePercent(value.sizePercent)) {
      throw new LaunchWorkspaceStoreError(
        "WORKSPACE_COMPANION_SIZE_INVALID",
        "Launch workspace companion size is invalid."
      );
    }

    const target = this.normalizeCompanionTarget(value.target);
    const autoOpen = target ? value.autoOpen === true : false;
    if (value.autoOpen !== undefined && typeof value.autoOpen !== "boolean") {
      throw new LaunchWorkspaceStoreError(
        "WORKSPACE_COMPANION_AUTO_OPEN_INVALID",
        "Launch workspace companion auto-open setting is invalid."
      );
    }

    return {
      placement: value.placement,
      sizePercent: value.sizePercent,
      autoOpen,
      ...(target ? { target } : {})
    };
  }

  private normalizeCompanionTarget(value: unknown): WorkspaceCompanionTarget | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }

    if (!isRecord(value)) {
      throw new LaunchWorkspaceStoreError(
        "WORKSPACE_COMPANION_TARGET_INVALID",
        "Launch workspace companion shortcut is invalid."
      );
    }

    if (value.kind === "url") {
      return { kind: "url", url: this.normalizeCompanionUrl(value.url) };
    }

    if (value.kind !== "application") {
      throw new LaunchWorkspaceStoreError(
        "WORKSPACE_COMPANION_TARGET_INVALID",
        "Launch workspace companion shortcut is invalid."
      );
    }

    return this.normalizeCompanionApplication(value);
  }

  private normalizeCompanionUrl(value: unknown): string {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (!normalized || normalized.length > COMPANION_URL_MAX_LENGTH) {
      throw new LaunchWorkspaceStoreError(
        "WORKSPACE_COMPANION_URL_INVALID",
        "Launch workspace companion URL must use HTTP or HTTPS."
      );
    }

    try {
      const url = new URL(normalized);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("Unsupported protocol");
      }
      return url.toString();
    } catch {
      throw new LaunchWorkspaceStoreError(
        "WORKSPACE_COMPANION_URL_INVALID",
        "Launch workspace companion URL must use HTTP or HTTPS."
      );
    }
  }

  private normalizeCompanionApplication(value: Record<string, unknown>): WorkspaceCompanionApplicationTarget {
    const label = typeof value.label === "string" ? value.label.trim() : "";
    const path = typeof value.path === "string" ? value.path.trim() : "";
    const platform = value.platform;
    if (!label || label.length > COMPANION_APP_LABEL_MAX_LENGTH) {
      throw new LaunchWorkspaceStoreError(
        "WORKSPACE_COMPANION_APPLICATION_INVALID",
        "Launch workspace companion application is invalid."
      );
    }
    const pathApi = platform === "win32" ? win32 : posix;
    if (!path || path.length > COMPANION_APP_PATH_MAX_LENGTH || !pathApi.isAbsolute(path)) {
      throw new LaunchWorkspaceStoreError(
        "WORKSPACE_COMPANION_APPLICATION_INVALID",
        "Launch workspace companion application is invalid."
      );
    }
    if (platform !== "darwin" && platform !== "win32") {
      throw new LaunchWorkspaceStoreError(
        "WORKSPACE_COMPANION_APPLICATION_INVALID",
        "Launch workspace companion application is invalid."
      );
    }

    const extension = pathApi.extname(path).toLocaleLowerCase();
    const isSupported = platform === "darwin"
      ? extension === ".app"
      : extension === ".exe" || extension === ".lnk";
    if (!isSupported) {
      throw new LaunchWorkspaceStoreError(
        "WORKSPACE_COMPANION_APPLICATION_INVALID",
        "Launch workspace companion application is invalid."
      );
    }

    return { kind: "application", label, path, platform };
  }

  private normalizeSlots(
    template: WorkspaceLayoutTemplate,
    inputSlots: Array<StoredLaunchWorkspaceSlot> | undefined
  ): LaunchWorkspaceSlot[] {
    const slotCount = getWorkspaceTemplateSlotCount(template);
    const defaultSlots = createDefaultWorkspaceSlots(template);

    if (inputSlots && inputSlots.length > MAX_WORKSPACE_SLOTS) {
      throw new LaunchWorkspaceStoreError("WORKSPACE_TOO_MANY_SLOTS", "Launch workspace can contain at most 8 slots.");
    }

    const sourceSlots = inputSlots ?? [];
    const seenRoles = new Set<string>();

    if (sourceSlots.length > slotCount) {
      const hasRoleOutsideTemplate = sourceSlots
        .slice(slotCount)
        .some((slot) => {
          const roleId = this.readSlotRoleId(slot);
          return typeof roleId === "string" && roleId.trim();
        });

      if (hasRoleOutsideTemplate) {
        throw new LaunchWorkspaceStoreError(
          "WORKSPACE_SLOT_OUTSIDE_LAYOUT",
          "Launch workspace role is outside the selected layout."
        );
      }
    }

    return defaultSlots.map((defaultSlot, index) => {
      const inputSlot = sourceSlots[index];
      const roleId = this.normalizeRoleId(this.readSlotRoleId(inputSlot));

      if (roleId) {
        if (seenRoles.has(roleId)) {
          throw new LaunchWorkspaceStoreError(
            "WORKSPACE_ROLE_DUPLICATE",
            "A role can only appear once in a launch workspace."
          );
        }

        seenRoles.add(roleId);
      }

      return {
        id: this.normalizeSlotId(inputSlot?.id, index),
        ...(roleId ? { roleId } : {}),
        rect: this.normalizeRect(inputSlot?.rect, getDefaultWorkspaceRects(template)[index])
      };
    });
  }

  private normalizeSlotId(value: string | undefined, index: number): string {
    const normalized = value?.trim();
    return normalized || `slot-${index + 1}`;
  }

  private normalizeRoleId(value: string | null | undefined): string | undefined {
    if (value === null || value === undefined) {
      return undefined;
    }

    const normalized = value.trim();
    return normalized || undefined;
  }

  private readSlotRoleId(slot: StoredLaunchWorkspaceSlot | undefined): string | null | undefined {
    if (slot?.roleId !== undefined) {
      return typeof slot.roleId === "string" || slot.roleId === null ? slot.roleId : undefined;
    }

    const legacyRoleId = slot?.[LEGACY_ROLE_ID_FIELD];
    return typeof legacyRoleId === "string" || legacyRoleId === null ? legacyRoleId : undefined;
  }

  private normalizeRect(value: NormalizedRect | undefined, fallback: NormalizedRect): NormalizedRect {
    if (!value) {
      return fallback;
    }

    const rect: NormalizedRect = {
      x: this.normalizeUnit(value.x, "x"),
      y: this.normalizeUnit(value.y, "y"),
      width: this.normalizeUnit(value.width, "width"),
      height: this.normalizeUnit(value.height, "height")
    };

    if (
      rect.width < MIN_WORKSPACE_SLOT_SIZE ||
      rect.height < MIN_WORKSPACE_SLOT_SIZE ||
      rect.x + rect.width > 1.0001 ||
      rect.y + rect.height > 1.0001
    ) {
      throw new LaunchWorkspaceStoreError("WORKSPACE_RECT_INVALID", "Launch workspace slot rectangle is invalid.");
    }

    return {
      x: roundRectValue(rect.x),
      y: roundRectValue(rect.y),
      width: roundRectValue(rect.width),
      height: roundRectValue(rect.height)
    };
  }

  private normalizeUnit(value: number, field: keyof NormalizedRect): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new LaunchWorkspaceStoreError("WORKSPACE_RECT_INVALID", `Launch workspace slot ${field} is invalid.`);
    }

    return value;
  }

  private ensureUniqueName(workspaces: LaunchWorkspace[], name: string, currentId?: string): void {
    const duplicate = workspaces.some(
      (workspace) => workspace.id !== currentId && workspace.name.toLocaleLowerCase() === name.toLocaleLowerCase()
    );

    if (duplicate) {
      throw new LaunchWorkspaceStoreError(
        "WORKSPACE_NAME_DUPLICATE",
        "A launch workspace with this name already exists."
      );
    }
  }
}

function cloneWorkspacesFile(file: LaunchWorkspacesFile): LaunchWorkspacesFile {
  return {
    workspaces: file.workspaces.map((workspace) => ({
      ...workspace,
      ...(workspace.companion
        ? {
            companion: {
              ...workspace.companion,
              ...(workspace.companion.target ? { target: { ...workspace.companion.target } } : {})
            }
          }
        : {}),
      slots: workspace.slots.map((slot) => ({
        ...slot,
        rect: { ...slot.rect }
      }))
    }))
  };
}

function roundRectValue(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function hasLegacyRoleSlotReference(workspace: LaunchWorkspace): boolean {
  return workspace.slots.some((slot) => LEGACY_ROLE_ID_FIELD in (slot as StoredLaunchWorkspaceSlot));
}

function hasLegacyCenteredMainDefaultLayout(workspace: StoredLaunchWorkspace): boolean {
  return (
    workspace.template === "main_center_side_stacks" &&
    Array.isArray(workspace.slots) &&
    workspace.slots.length === LEGACY_CENTERED_MAIN_DEFAULT_RECTS.length &&
    workspace.slots.every((slot, index) =>
      rectMatches(slot.rect, LEGACY_CENTERED_MAIN_DEFAULT_RECTS[index])
    )
  );
}

function rectMatches(value: NormalizedRect | undefined, expected: NormalizedRect): boolean {
  return (
    value?.x === expected.x &&
    value.y === expected.y &&
    value.width === expected.width &&
    value.height === expected.height
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
