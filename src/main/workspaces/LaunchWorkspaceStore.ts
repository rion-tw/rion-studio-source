import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  CreateLaunchWorkspaceInput,
  LaunchWorkspace,
  LaunchWorkspaceSlot,
  InheritableBrowserLaunchMode,
  NormalizedRect,
  ReorderItemsInput,
  UpdateLaunchWorkspaceInput,
  WorkspaceBrowserZoomPercent,
  WorkspaceResourcePolicy,
  WorkspaceLayoutTemplate
} from "../../shared/types";
import {
  createDefaultWorkspaceSlots,
  DEFAULT_WORKSPACE_BROWSER_ZOOM_PERCENT,
  DEFAULT_WORKSPACE_RESOURCE_POLICY,
  DEFAULT_WORKSPACE_TEMPLATE,
  getDefaultWorkspaceBrowserZoomPercent,
  getDefaultWorkspaceRects,
  getWorkspaceTemplateSlotCount,
  isWorkspaceBrowserZoomPercent,
  isWorkspaceLayoutTemplate,
  MAX_WORKSPACE_SLOTS,
  MIN_WORKSPACE_SLOT_SIZE,
  normalizeWorkspaceRectEdges
} from "../../shared/workspaceLayout";
import { SerialTaskQueue } from "../persistence/SerialTaskQueue";
import { writeJsonFileAtomically } from "../persistence/atomicJsonFile";

interface LaunchWorkspacesFile {
  schemaVersion: number;
  workspaces: LaunchWorkspace[];
}

type StoredLaunchWorkspaceSlot = Partial<LaunchWorkspaceSlot> & {
  [key: string]: unknown;
};

type StoredLaunchWorkspace = Omit<LaunchWorkspace, "browserLaunchMode" | "browserZoomPercent" | "resourcePolicy" | "slots" | "targetDisplayId"> & {
  browserLaunchMode?: unknown;
  browserZoomPercent?: unknown;
  resourcePolicy?: unknown;
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
export const LAUNCH_WORKSPACES_FILE_SCHEMA_VERSION = 3;

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

  async replaceWorkspacesForImport(
    workspaces: LaunchWorkspace[],
    publishCache = true
  ): Promise<LaunchWorkspace[]> {
    return this.taskQueue.run(async () => {
      const normalized = workspaces.map((workspace) =>
        this.normalizeStoredWorkspace(workspace as StoredLaunchWorkspace)
      );
      normalized.forEach((workspace) => this.ensureUniqueName(normalized, workspace.name, workspace.id));
      const file = {
        schemaVersion: LAUNCH_WORKSPACES_FILE_SCHEMA_VERSION,
        workspaces: normalized
      };
      await this.writeWorkspacesFile(file, publishCache);
      return cloneWorkspacesFile(file).workspaces;
    });
  }

  publishWorkspacesForImport(workspaces: LaunchWorkspace[]): void {
    this.cachedFile = cloneWorkspacesFile({
      schemaVersion: LAUNCH_WORKSPACES_FILE_SCHEMA_VERSION,
      workspaces
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
      const slots = this.normalizeSlots(template, input.slots);

      this.ensureUniqueName(file.workspaces, name);

      const workspace: LaunchWorkspace = {
        id: randomUUID(),
        name,
        template,
        browserLaunchMode: this.normalizeBrowserLaunchMode(input.browserLaunchMode),
        browserZoomPercent,
        resourcePolicy: this.normalizeResourcePolicy(input.resourcePolicy, slots),
        ...(targetDisplayId === undefined ? {} : { targetDisplayId }),
        slots,
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
      const browserLaunchMode = input.browserLaunchMode === undefined
        ? current.browserLaunchMode
        : this.normalizeBrowserLaunchMode(input.browserLaunchMode);
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
      const slots = this.normalizeSlots(template, sourceSlots);
      const resourcePolicy = this.normalizeResourcePolicy(
        input.resourcePolicy ?? current.resourcePolicy,
        slots
      );

      this.ensureUniqueName(file.workspaces, name, id);

      const updated: LaunchWorkspace = {
        ...current,
        name,
        template,
        browserLaunchMode,
        browserZoomPercent,
        resourcePolicy,
        slots,
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

      await this.writeWorkspacesFile({
        schemaVersion: LAUNCH_WORKSPACES_FILE_SCHEMA_VERSION,
        workspaces
      });
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

      await this.writeWorkspacesFile({
        schemaVersion: LAUNCH_WORKSPACES_FILE_SCHEMA_VERSION,
        workspaces: nextWorkspaces
      });
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

        return workspaceChanged
          ? {
              ...workspace,
              resourcePolicy: this.normalizeResourcePolicy(workspace.resourcePolicy, slots),
              slots,
              updatedAt: now
            }
          : workspace;
      });

      if (!didChange) {
        return;
      }

      await this.writeWorkspacesFile({
        schemaVersion: LAUNCH_WORKSPACES_FILE_SCHEMA_VERSION,
        workspaces
      });
    });
  }

  private async readWorkspacesFile(): Promise<LaunchWorkspacesFile> {
    if (this.cachedFile) {
      return cloneWorkspacesFile(this.cachedFile);
    }

    try {
      const raw = await readFile(this.workspacesPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<LaunchWorkspacesFile>;

      if (!Array.isArray(parsed.workspaces)) {
        throw new LaunchWorkspaceStoreError("WORKSPACE_FILE_INVALID", "Launch workspace data file is invalid.");
      }

      const storedSchemaVersion = parsed.schemaVersion ?? 0;
      if (
        storedSchemaVersion > LAUNCH_WORKSPACES_FILE_SCHEMA_VERSION
      ) {
        throw new LaunchWorkspaceStoreError(
          "WORKSPACE_FILE_INVALID",
          "Launch workspace data file is invalid."
        );
      }

      const didMigrate = parsed.workspaces.some(
        (workspace) =>
          !("browserLaunchMode" in workspace) ||
          !("resourcePolicy" in workspace) ||
          hasLegacyRoleSlotReference(workspace) ||
          hasLegacyCenteredMainDefaultLayout(workspace as StoredLaunchWorkspace)
      ) || storedSchemaVersion < LAUNCH_WORKSPACES_FILE_SCHEMA_VERSION;
      const normalizedWorkspaces = parsed.workspaces.map((workspace) =>
        this.normalizeStoredWorkspace(workspace as StoredLaunchWorkspace)
      );
      const file = {
        schemaVersion: LAUNCH_WORKSPACES_FILE_SCHEMA_VERSION,
        workspaces: storedSchemaVersion < LAUNCH_WORKSPACES_FILE_SCHEMA_VERSION
          ? normalizedWorkspaces.map(migrateWorkspaceResourcePolicyToAdaptive)
          : normalizedWorkspaces
      };

      if (didMigrate) {
        await this.writeWorkspacesFile(file);
      } else {
        this.cachedFile = cloneWorkspacesFile(file);
      }

      return cloneWorkspacesFile(file);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return {
          schemaVersion: LAUNCH_WORKSPACES_FILE_SCHEMA_VERSION,
          workspaces: []
        };
      }

      throw error;
    }
  }

  private async writeWorkspacesFile(file: LaunchWorkspacesFile, publishCache = true): Promise<void> {
    await writeJsonFileAtomically(this.workspacesPath, file);
    if (publishCache) {
      this.cachedFile = cloneWorkspacesFile({
        schemaVersion: LAUNCH_WORKSPACES_FILE_SCHEMA_VERSION,
        workspaces: file.workspaces.map((workspace) =>
          this.normalizeStoredWorkspace(workspace as StoredLaunchWorkspace)
        )
      });
    }
  }

  private normalizeStoredWorkspace(workspace: StoredLaunchWorkspace): LaunchWorkspace {
    const template = this.normalizeTemplate(workspace.template);
    const targetDisplayId = this.normalizeTargetDisplayId(workspace.targetDisplayId);
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
      browserLaunchMode: this.normalizeBrowserLaunchMode(workspace.browserLaunchMode),
      browserZoomPercent: this.normalizeBrowserZoomPercent(
        workspace.browserZoomPercent,
        DEFAULT_WORKSPACE_BROWSER_ZOOM_PERCENT
      ),
      resourcePolicy: this.normalizeResourcePolicy(workspace.resourcePolicy, normalizedSlots),
      ...(targetDisplayId === undefined ? {} : { targetDisplayId }),
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

  private normalizeBrowserLaunchMode(value: unknown): InheritableBrowserLaunchMode {
    if (value === undefined || value === null) {
      return "inherit";
    }
    if (value === "inherit" || value === "auto" || value === "embedded" || value === "external") {
      return value;
    }
    throw new LaunchWorkspaceStoreError(
      "WORKSPACE_BROWSER_LAUNCH_MODE_INVALID",
      "Launch workspace browser mode is invalid."
    );
  }

  private normalizeResourcePolicy(
    value: unknown,
    slots: LaunchWorkspaceSlot[]
  ): WorkspaceResourcePolicy {
    const normalizedValue = value === undefined || value === null
      ? DEFAULT_WORKSPACE_RESOURCE_POLICY
      : value;
    if (typeof normalizedValue !== "object" || Array.isArray(normalizedValue)) {
      throw new LaunchWorkspaceStoreError(
        "WORKSPACE_RESOURCE_POLICY_INVALID",
        "Launch workspace resource policy is invalid."
      );
    }

    const input = normalizedValue as Record<string, unknown>;
    const mode = input.mode;
    if (
      mode !== "unrestricted" && mode !== "primary_priority" && mode !== "adaptive"
    ) {
      throw new LaunchWorkspaceStoreError(
        "WORKSPACE_RESOURCE_POLICY_INVALID",
        "Launch workspace resource policy is invalid."
      );
    }

    if (mode === "unrestricted") {
      return { mode };
    }

    const assignedRoleIds = slots.flatMap((slot) => slot.roleId ? [slot.roleId] : []);
    const requestedPrimaryRoleId = typeof input.primaryRoleId === "string"
      ? input.primaryRoleId.trim()
      : undefined;
    const primaryRoleId = requestedPrimaryRoleId && assignedRoleIds.includes(requestedPrimaryRoleId)
      ? requestedPrimaryRoleId
      : assignedRoleIds[0];

    return primaryRoleId
      ? { mode: "adaptive", primaryRoleId }
      : { mode: "adaptive" };
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

    const normalizedSlots = defaultSlots.map((defaultSlot, index) => {
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
    const normalizedRects = normalizeWorkspaceRectEdges(normalizedSlots.map((slot) => slot.rect));

    return normalizedSlots.map((slot, index) => ({
      ...slot,
      rect: normalizedRects[index]
    }));
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

    return rect;
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
    schemaVersion: file.schemaVersion,
    workspaces: file.workspaces.map((workspace) => ({
      ...workspace,
      resourcePolicy: { ...workspace.resourcePolicy },
      slots: workspace.slots.map((slot) => ({
        ...slot,
        rect: { ...slot.rect }
      }))
    }))
  };
}

export function migrateWorkspaceResourcePolicyToAdaptive(
  workspace: LaunchWorkspace
): LaunchWorkspace {
  if (workspace.resourcePolicy.mode === "unrestricted") {
    return workspace;
  }

  const primaryRoleId = workspace.resourcePolicy.primaryRoleId ??
    workspace.slots.find((slot) => slot.roleId)?.roleId;
  return {
    ...workspace,
    resourcePolicy: {
      mode: "adaptive",
      ...(primaryRoleId ? { primaryRoleId } : {})
    }
  };
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
