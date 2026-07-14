import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  CreateLaunchWorkspaceInput,
  LaunchWorkspace,
  LaunchWorkspaceSlot,
  NormalizedRect,
  ReorderItemsInput,
  UpdateLaunchWorkspaceInput,
  WorkspaceBrowserZoomPercent,
  WorkspaceLayoutTemplate
} from "../../shared/types";
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

type StoredLaunchWorkspace = Omit<LaunchWorkspace, "browserZoomPercent" | "slots" | "targetDisplayId"> & {
  browserZoomPercent?: unknown;
  targetDisplayId?: unknown;
  slots: StoredLaunchWorkspaceSlot[];
};

const LEGACY_ROLE_ID_FIELD = "profile" + "Id";

const WORKSPACE_NAME_MAX_LENGTH = 80;
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

      this.ensureUniqueName(file.workspaces, name);

      const workspace: LaunchWorkspace = {
        id: randomUUID(),
        name,
        template,
        browserZoomPercent,
        ...(targetDisplayId === undefined ? {} : { targetDisplayId }),
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
    try {
      const raw = await readFile(this.workspacesPath, "utf8");
      const parsed = JSON.parse(raw) as LaunchWorkspacesFile;

      if (!Array.isArray(parsed.workspaces)) {
        throw new LaunchWorkspaceStoreError("WORKSPACE_FILE_INVALID", "Launch workspace data file is invalid.");
      }

      const didMigrate = parsed.workspaces.some(hasLegacyRoleSlotReference);
      const file = {
        workspaces: parsed.workspaces.map((workspace) =>
          this.normalizeStoredWorkspace(workspace as StoredLaunchWorkspace)
        )
      };

      if (didMigrate) {
        await this.writeWorkspacesFile(file);
      }

      return file;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { workspaces: [] };
      }

      throw error;
    }
  }

  private async writeWorkspacesFile(file: LaunchWorkspacesFile): Promise<void> {
    await writeJsonFileAtomically(this.workspacesPath, file);
  }

  private normalizeStoredWorkspace(workspace: StoredLaunchWorkspace): LaunchWorkspace {
    const template = this.normalizeTemplate(workspace.template);
    const targetDisplayId = this.normalizeTargetDisplayId(workspace.targetDisplayId);

    return {
      id: typeof workspace.id === "string" && workspace.id.trim() ? workspace.id : randomUUID(),
      name: this.normalizeName(workspace.name),
      template,
      browserZoomPercent: this.normalizeBrowserZoomPercent(
        workspace.browserZoomPercent,
        DEFAULT_WORKSPACE_BROWSER_ZOOM_PERCENT
      ),
      ...(targetDisplayId === undefined ? {} : { targetDisplayId }),
      slots: this.normalizeSlots(template, workspace.slots as StoredLaunchWorkspaceSlot[]),
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

function roundRectValue(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function hasLegacyRoleSlotReference(workspace: LaunchWorkspace): boolean {
  return workspace.slots.some((slot) => LEGACY_ROLE_ID_FIELD in (slot as StoredLaunchWorkspaceSlot));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
