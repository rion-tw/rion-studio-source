import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type {
  CreateLaunchWorkspaceInput,
  LaunchWorkspace,
  LaunchWorkspaceSlot,
  NormalizedRect,
  UpdateLaunchWorkspaceInput,
  WorkspaceLayoutTemplate
} from "../../shared/types";
import {
  createDefaultWorkspaceSlots,
  DEFAULT_WORKSPACE_TEMPLATE,
  getDefaultWorkspaceRects,
  getWorkspaceTemplateSlotCount,
  isWorkspaceLayoutTemplate,
  MAX_WORKSPACE_SLOTS
} from "../../shared/workspaceLayout";

interface LaunchWorkspacesFile {
  workspaces: LaunchWorkspace[];
}

type StoredLaunchWorkspaceSlot = Partial<LaunchWorkspaceSlot> & {
  [key: string]: unknown;
};

const LEGACY_ROLE_ID_FIELD = "profile" + "Id";

const WORKSPACE_NAME_MAX_LENGTH = 80;
const MIN_NORMALIZED_SIZE = 0.12;

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
  private readonly workspacesPath: string;

  constructor(private readonly userDataDir: string) {
    this.workspacesPath = join(userDataDir, "launch-workspaces.json");
  }

  async listWorkspaces(): Promise<LaunchWorkspace[]> {
    const file = await this.readWorkspacesFile();
    return [...file.workspaces].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getWorkspace(id: string): Promise<LaunchWorkspace> {
    const workspace = (await this.listWorkspaces()).find((item) => item.id === id);

    if (!workspace) {
      throw new LaunchWorkspaceStoreError("WORKSPACE_NOT_FOUND", "Launch workspace not found.");
    }

    return workspace;
  }

  async createWorkspace(input: CreateLaunchWorkspaceInput): Promise<LaunchWorkspace> {
    const file = await this.readWorkspacesFile();
    const now = new Date().toISOString();
    const name = this.normalizeName(input.name);
    const template = this.normalizeTemplate(input.template);

    this.ensureUniqueName(file.workspaces, name);

    const workspace: LaunchWorkspace = {
      id: randomUUID(),
      name,
      template,
      slots: this.normalizeSlots(template, input.slots),
      createdAt: now,
      updatedAt: now
    };

    file.workspaces.push(workspace);
    await this.writeWorkspacesFile(file);

    return workspace;
  }

  async updateWorkspace(id: string, input: UpdateLaunchWorkspaceInput): Promise<LaunchWorkspace> {
    const file = await this.readWorkspacesFile();
    const index = file.workspaces.findIndex((workspace) => workspace.id === id);

    if (index === -1) {
      throw new LaunchWorkspaceStoreError("WORKSPACE_NOT_FOUND", "Launch workspace not found.");
    }

    const current = file.workspaces[index];
    const name = input.name === undefined ? current.name : this.normalizeName(input.name);
    const template = input.template === undefined ? current.template : this.normalizeTemplate(input.template);
    const sourceSlots =
      input.slots ??
      (input.template === undefined ? current.slots : current.slots.slice(0, getWorkspaceTemplateSlotCount(template)));

    this.ensureUniqueName(file.workspaces, name, id);

    const updated: LaunchWorkspace = {
      ...current,
      name,
      template,
      slots: this.normalizeSlots(template, sourceSlots),
      updatedAt: new Date().toISOString()
    };

    file.workspaces[index] = updated;
    await this.writeWorkspacesFile(file);

    return updated;
  }

  async deleteWorkspace(id: string): Promise<void> {
    const file = await this.readWorkspacesFile();
    const nextWorkspaces = file.workspaces.filter((workspace) => workspace.id !== id);

    if (nextWorkspaces.length === file.workspaces.length) {
      throw new LaunchWorkspaceStoreError("WORKSPACE_NOT_FOUND", "Launch workspace not found.");
    }

    await this.writeWorkspacesFile({ workspaces: nextWorkspaces });
  }

  async clearRole(roleId: string): Promise<void> {
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
        workspaces: parsed.workspaces.map((workspace) => this.normalizeStoredWorkspace(workspace))
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
    await mkdir(dirname(this.workspacesPath), { recursive: true });
    const tmpPath = `${this.workspacesPath}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    await rename(tmpPath, this.workspacesPath);
  }

  private normalizeStoredWorkspace(workspace: LaunchWorkspace): LaunchWorkspace {
    const template = this.normalizeTemplate(workspace.template);

    return {
      id: typeof workspace.id === "string" && workspace.id.trim() ? workspace.id : randomUUID(),
      name: this.normalizeName(workspace.name),
      template,
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

  private normalizeTemplate(template: WorkspaceLayoutTemplate | undefined): WorkspaceLayoutTemplate {
    if (template === undefined) {
      return DEFAULT_WORKSPACE_TEMPLATE;
    }

    if (!isWorkspaceLayoutTemplate(template)) {
      throw new LaunchWorkspaceStoreError("WORKSPACE_TEMPLATE_INVALID", "Launch workspace layout is invalid.");
    }

    return template;
  }

  private normalizeSlots(
    template: WorkspaceLayoutTemplate,
    inputSlots: Array<StoredLaunchWorkspaceSlot> | undefined
  ): LaunchWorkspaceSlot[] {
    const slotCount = getWorkspaceTemplateSlotCount(template);
    const defaultSlots = createDefaultWorkspaceSlots(template);

    if (inputSlots && inputSlots.length > MAX_WORKSPACE_SLOTS) {
      throw new LaunchWorkspaceStoreError("WORKSPACE_TOO_MANY_SLOTS", "Launch workspace can contain at most 4 slots.");
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
      rect.width < MIN_NORMALIZED_SIZE ||
      rect.height < MIN_NORMALIZED_SIZE ||
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
