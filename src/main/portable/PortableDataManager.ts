import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

import { normalizeGameBrowserSettings } from "../../shared/browserFonts";
import type { MacroStore } from "../macros/MacroStore";
import type { RoleStore } from "../roles/RoleStore";
import type { LaunchWorkspaceStore } from "../workspaces/LaunchWorkspaceStore";
import {
  DEFAULT_LAUNCH_URL,
  DEFAULT_ROLE_WINDOW_HEIGHT,
  DEFAULT_ROLE_WINDOW_WIDTH,
  type CreateLaunchWorkspaceInput,
  type CreateMacroInput,
  type CreateRoleInput,
  type GameBrowserSettings,
  type LaunchPreset,
  type MacroRepeat,
  type MacroStep,
  type MacroTrigger,
  type PortableExportInput,
  type PortableExportResult,
  type PortableImportPreview,
  type PortableImportResult,
  type PortableImportWarning,
  type PortableLaunchWorkspace,
  type PortableMacro,
  type PortablePreferences,
  type PortableRole,
  type RionPortableDataV1,
  type RoleDefaults
} from "../../shared/types";
import {
  isWorkspaceBrowserZoomPercent,
  isWorkspaceLayoutTemplate,
  MAX_WORKSPACE_SLOTS,
  MIN_WORKSPACE_SLOT_SIZE
} from "../../shared/workspaceLayout";

interface PortableSaveDialogOptions {
  defaultPath: string;
  filters: Array<{ extensions: string[]; name: string }>;
  title: string;
}

interface PortableOpenDialogOptions {
  filters: Array<{ extensions: string[]; name: string }>;
  properties: Array<"openFile">;
  title: string;
}

interface PortableSaveDialogResult {
  canceled: boolean;
  filePath?: string;
}

interface PortableOpenDialogResult {
  canceled: boolean;
  filePaths: string[];
}

interface PortableDataManagerOptions {
  createImportId?: () => string;
  getAppVersion: () => string;
  now?: () => Date;
  readTextFile?: (path: string, encoding: BufferEncoding) => Promise<string>;
  roleStore: Pick<RoleStore, "createRole" | "listRoles">;
  showOpenDialog: (options: PortableOpenDialogOptions) => Promise<PortableOpenDialogResult>;
  showSaveDialog: (options: PortableSaveDialogOptions) => Promise<PortableSaveDialogResult>;
  workspaceStore: Pick<LaunchWorkspaceStore, "createWorkspace" | "listWorkspaces">;
  macroStore: Pick<MacroStore, "createMacro" | "listMacros">;
  writeTextFile?: (path: string, data: string, encoding: BufferEncoding) => Promise<void>;
}

interface ImportPlan {
  roles: Array<{ name: string; source: PortableRole }>;
  workspaces: Array<{ name: string; source: PortableLaunchWorkspace }>;
  macros: Array<{ name: string; roleIds: string[]; source: PortableMacro }>;
  warnings: PortableImportWarning[];
}

interface PendingImport {
  data: RionPortableDataV1;
  filePath: string;
}

const PORTABLE_APP_NAME = "Rion Studio";
const PORTABLE_SCHEMA_VERSION = 1;
const MAX_COVER_IMAGE_DATA_URL_LENGTH = 1_500_000;
const MAX_LAUNCH_URL_LENGTH = 2_048;
const MAX_NAME_LENGTH = 80;
const MACRO_STEPS_MAX_LENGTH = 100;
const MACRO_DELAY_MAX_MS = 600_000;
const MACRO_CODE_MAX_LENGTH = 48;
const MACRO_LABEL_MAX_LENGTH = 48;
const COVER_IMAGE_DATA_URL_PATTERN = /^data:image\/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;
const COVER_IMAGE_DOMINANT_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;

export class PortableDataError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "PortableDataError";
  }
}

export class PortableDataManager {
  private readonly createImportId: () => string;
  private readonly now: () => Date;
  private readonly pendingImports = new Map<string, PendingImport>();
  private readonly readTextFile: (path: string, encoding: BufferEncoding) => Promise<string>;
  private readonly writeTextFile: (path: string, data: string, encoding: BufferEncoding) => Promise<void>;

  constructor(private readonly options: PortableDataManagerOptions) {
    this.createImportId = options.createImportId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
    this.readTextFile = options.readTextFile ?? readFile;
    this.writeTextFile = options.writeTextFile ?? writeFile;
  }

  async exportData(input: PortableExportInput = {}): Promise<PortableExportResult | null> {
    const dialogResult = await this.options.showSaveDialog({
      defaultPath: `rion-studio-${formatDate(this.now())}.json`,
      filters: [{ name: "Rion Studio JSON", extensions: ["json"] }],
      title: "Export Rion Studio JSON"
    });

    if (dialogResult.canceled || !dialogResult.filePath) {
      return null;
    }

    const data = await this.createPortableData(input.preferences);
    await this.writeTextFile(dialogResult.filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");

    return {
      filePath: dialogResult.filePath,
      roleCount: data.roles.length,
      workspaceCount: data.launchWorkspaces.length,
      macroCount: data.macros.length
    };
  }

  async previewImport(): Promise<PortableImportPreview | null> {
    const dialogResult = await this.options.showOpenDialog({
      filters: [{ name: "Rion Studio JSON", extensions: ["json"] }],
      properties: ["openFile"],
      title: "Import Rion Studio JSON"
    });

    if (dialogResult.canceled || dialogResult.filePaths.length === 0) {
      return null;
    }

    const filePath = dialogResult.filePaths[0];
    const data = parsePortableData(await this.readTextFile(filePath, "utf8"));
    const plan = await this.buildImportPlan(data);
    const importId = this.createImportId();

    this.pendingImports.set(importId, { data, filePath });

    return {
      importId,
      filePath,
      exportedAt: data.exportedAt,
      appVersion: data.appVersion,
      roleCount: plan.roles.length,
      workspaceCount: plan.workspaces.length,
      macroCount: plan.macros.length,
      preferences: data.preferences,
      warnings: plan.warnings
    };
  }

  async applyImport(importId: string): Promise<PortableImportResult> {
    const pendingImport = this.pendingImports.get(importId);

    if (!pendingImport) {
      throw new PortableDataError(
        "PORTABLE_IMPORT_EXPIRED",
        "Portable import session expired. Choose the JSON file again."
      );
    }

    this.pendingImports.delete(importId);
    const plan = await this.buildImportPlan(pendingImport.data);
    const roleIdMap = new Map<string, string>();
    let roleCount = 0;
    let workspaceCount = 0;
    let macroCount = 0;

    for (const rolePlan of plan.roles) {
      const createdRole = await this.options.roleStore.createRole(toCreateRoleInput(rolePlan.source, rolePlan.name));
      roleIdMap.set(rolePlan.source.id, createdRole.id);
      roleCount += 1;
    }

    for (const workspacePlan of plan.workspaces) {
      await this.options.workspaceStore.createWorkspace(
        toCreateWorkspaceInput(workspacePlan.source, workspacePlan.name, roleIdMap)
      );
      workspaceCount += 1;
    }

    for (const macroPlan of plan.macros) {
      await this.options.macroStore.createMacro(toCreateMacroInput(macroPlan.source, macroPlan.name, macroPlan.roleIds, roleIdMap));
      macroCount += 1;
    }

    return {
      roleCount,
      workspaceCount,
      macroCount,
      preferences: pendingImport.data.preferences,
      warnings: plan.warnings
    };
  }

  private async createPortableData(preferences: PortablePreferences | undefined): Promise<RionPortableDataV1> {
    const [roles, launchWorkspaces, macros] = await Promise.all([
      this.options.roleStore.listRoles(),
      this.options.workspaceStore.listWorkspaces(),
      this.options.macroStore.listMacros()
    ]);
    const normalizedPreferences = normalizePortablePreferences(preferences);

    return {
      app: PORTABLE_APP_NAME,
      schemaVersion: PORTABLE_SCHEMA_VERSION,
      exportedAt: this.now().toISOString(),
      appVersion: this.options.getAppVersion(),
      roles: roles.map((role) => ({
        id: role.id,
        name: role.name,
        launchUrl: role.launchUrl,
        windowWidth: role.windowWidth,
        windowHeight: role.windowHeight,
        notes: role.notes,
        launchPreset: role.launchPreset,
        ...(role.coverImageDataUrl ? { coverImageDataUrl: role.coverImageDataUrl } : {}),
        ...(role.coverImageDominantColor ? { coverImageDominantColor: role.coverImageDominantColor } : {})
      })),
      launchWorkspaces: launchWorkspaces.map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        template: workspace.template,
        browserZoomPercent: workspace.browserZoomPercent,
        slots: workspace.slots.map((slot) => ({
          id: slot.id,
          ...(slot.roleId ? { roleId: slot.roleId } : {}),
          rect: { ...slot.rect }
        }))
      })),
      macros: macros.map((macro) => ({
        id: macro.id,
        name: macro.name,
        roleIds: [...macro.roleIds],
        ...(macro.trigger ? { trigger: { ...macro.trigger } } : {}),
        repeat: macro.repeat.type === "loop" ? { ...macro.repeat } : { type: "once" },
        steps: macro.steps.map((step) => ({ ...step }))
      })),
      ...(normalizedPreferences ? { preferences: normalizedPreferences } : {})
    };
  }

  private async buildImportPlan(data: RionPortableDataV1): Promise<ImportPlan> {
    const [existingRoles, existingWorkspaces] = await Promise.all([
      this.options.roleStore.listRoles(),
      this.options.workspaceStore.listWorkspaces()
    ]);
    const warnings: PortableImportWarning[] = [];
    const usedRoleNames = new Set(existingRoles.map((role) => normalizeNameKey(role.name)));
    const usedWorkspaceNames = new Set(existingWorkspaces.map((workspace) => normalizeNameKey(workspace.name)));
    const importedRoleIds = new Set(data.roles.map((role) => role.id));

    const roles = data.roles.map((role) => {
      const name = reserveUniqueName(role.name, usedRoleNames);
      if (name !== role.name) {
        warnings.push({
          code: "ROLE_NAME_RENAMED",
          itemName: role.name,
          replacementName: name
        });
      }

      return { name, source: role };
    });

    const workspaces = data.launchWorkspaces.map((workspace) => {
      const missingRoleCount = workspace.slots.filter(
        (slot) => slot.roleId && !importedRoleIds.has(slot.roleId)
      ).length;
      const name = reserveUniqueName(workspace.name, usedWorkspaceNames);

      if (name !== workspace.name) {
        warnings.push({
          code: "WORKSPACE_NAME_RENAMED",
          itemName: workspace.name,
          replacementName: name
        });
      }

      if (missingRoleCount > 0) {
        warnings.push({
          code: "WORKSPACE_ROLE_MISSING",
          count: missingRoleCount,
          itemName: workspace.name
        });
      }

      return { name, source: workspace };
    });

    const macros = data.macros.flatMap((macro) => {
      const importedRoleIdList = macro.roleIds.filter((roleId) => importedRoleIds.has(roleId));
      const roleIds = [...new Set(importedRoleIdList)];
      const missingRoleCount = [...new Set(macro.roleIds)].filter((roleId) => !importedRoleIds.has(roleId)).length;

      if (roleIds.length === 0) {
        warnings.push({
          code: "MACRO_SKIPPED_NO_ROLES",
          itemName: macro.name
        });
        return [];
      }

      if (missingRoleCount > 0) {
        warnings.push({
          code: "MACRO_ROLE_MISSING",
          count: missingRoleCount,
          itemName: macro.name
        });
      }

      return [{ name: macro.name, roleIds, source: macro }];
    });

    return { roles, workspaces, macros, warnings };
  }
}

function toCreateRoleInput(role: PortableRole, name: string): CreateRoleInput {
  return {
    name,
    launchUrl: role.launchUrl,
    windowWidth: role.windowWidth,
    windowHeight: role.windowHeight,
    notes: role.notes,
    launchPreset: role.launchPreset,
    coverImageDataUrl: role.coverImageDataUrl ?? null,
    coverImageDominantColor: role.coverImageDominantColor ?? null
  };
}

function toCreateWorkspaceInput(
  workspace: PortableLaunchWorkspace,
  name: string,
  roleIdMap: Map<string, string>
): CreateLaunchWorkspaceInput {
  return {
    name,
    template: workspace.template,
    browserZoomPercent: workspace.browserZoomPercent,
    slots: workspace.slots.map((slot) => {
      const mappedRoleId = slot.roleId ? roleIdMap.get(slot.roleId) : undefined;

      return {
        id: slot.id,
        ...(mappedRoleId ? { roleId: mappedRoleId } : {}),
        rect: { ...slot.rect }
      };
    })
  };
}

function toCreateMacroInput(
  macro: PortableMacro,
  name: string,
  roleIds: string[],
  roleIdMap: Map<string, string>
): CreateMacroInput {
  return {
    name,
    roleIds: roleIds.map((roleId) => roleIdMap.get(roleId)).filter(isString),
    trigger: macro.trigger ? { ...macro.trigger } : null,
    repeat: macro.repeat.type === "loop" ? { ...macro.repeat } : { type: "once" },
    steps: macro.steps.map((step) => ({ ...step }))
  };
}

function parsePortableData(raw: string): RionPortableDataV1 {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const data = toRecord(parsed);

    if (
      data.app !== PORTABLE_APP_NAME ||
      data.schemaVersion !== PORTABLE_SCHEMA_VERSION ||
      !Array.isArray(data.roles) ||
      !Array.isArray(data.launchWorkspaces) ||
      !Array.isArray(data.macros)
    ) {
      throw new Error("Invalid portable metadata.");
    }

    const roles = data.roles.map(normalizePortableRole);
    const launchWorkspaces = data.launchWorkspaces.map(normalizePortableLaunchWorkspace);
    const macros = data.macros.map(normalizePortableMacro);
    const preferences = normalizePortablePreferences(data.preferences);
    ensureUniqueIds(roles.map((role) => role.id));
    ensureUniqueIds(launchWorkspaces.map((workspace) => workspace.id));
    ensureUniqueIds(macros.map((macro) => macro.id));

    return {
      app: PORTABLE_APP_NAME,
      schemaVersion: PORTABLE_SCHEMA_VERSION,
      exportedAt: typeof data.exportedAt === "string" ? data.exportedAt : "",
      appVersion: typeof data.appVersion === "string" ? data.appVersion : "",
      roles,
      launchWorkspaces,
      macros,
      ...(preferences ? { preferences } : {})
    };
  } catch (error) {
    if (error instanceof PortableDataError) {
      throw error;
    }

    throw new PortableDataError("PORTABLE_DATA_INVALID", "Portable data file is invalid.");
  }
}

function normalizePortableRole(value: unknown): PortableRole {
  const role = toRecord(value);
  const coverImageDataUrl = normalizeOptionalCoverImageDataUrl(role.coverImageDataUrl);

  return {
    id: normalizeRequiredString(role.id),
    name: normalizeName(role.name),
    launchUrl: normalizeLaunchUrl(role.launchUrl),
    windowWidth: normalizeWindowSize(role.windowWidth, DEFAULT_ROLE_WINDOW_WIDTH),
    windowHeight: normalizeWindowSize(role.windowHeight, DEFAULT_ROLE_WINDOW_HEIGHT),
    notes: typeof role.notes === "string" ? role.notes.trim() : "",
    launchPreset: normalizeLaunchPreset(role.launchPreset),
    ...(coverImageDataUrl ? { coverImageDataUrl } : {}),
    ...(coverImageDataUrl ? normalizeOptionalCoverImageDominantColorProperty(role.coverImageDominantColor) : {})
  };
}

function normalizePortableLaunchWorkspace(value: unknown): PortableLaunchWorkspace {
  const workspace = toRecord(value);
  const template = workspace.template;
  const browserZoomPercent = workspace.browserZoomPercent;

  if (!isWorkspaceLayoutTemplate(template) || !isWorkspaceBrowserZoomPercent(browserZoomPercent)) {
    throw new PortableDataError("PORTABLE_DATA_INVALID", "Portable data file is invalid.");
  }

  if (!Array.isArray(workspace.slots) || workspace.slots.length > MAX_WORKSPACE_SLOTS) {
    throw new PortableDataError("PORTABLE_DATA_INVALID", "Portable data file is invalid.");
  }
  const slots = workspace.slots.map((slot, index) => normalizePortableWorkspaceSlot(slot, index));
  const assignedRoleIds = slots.map((slot) => slot.roleId).filter(isString);
  ensureUniqueIds(assignedRoleIds);

  return {
    id: normalizeRequiredString(workspace.id),
    name: normalizeName(workspace.name),
    template,
    browserZoomPercent,
    slots
  };
}

function normalizePortableWorkspaceSlot(value: unknown, index: number): PortableLaunchWorkspace["slots"][number] {
  const slot = toRecord(value);
  const roleId = slot.roleId === undefined ? undefined : normalizeOptionalString(slot.roleId);

  return {
    id: typeof slot.id === "string" && slot.id.trim() ? slot.id.trim() : `slot-${index + 1}`,
    ...(roleId ? { roleId } : {}),
    rect: normalizeRect(slot.rect)
  };
}

function normalizePortableMacro(value: unknown): PortableMacro {
  const macro = toRecord(value);

  if (!Array.isArray(macro.roleIds)) {
    throw new PortableDataError("PORTABLE_DATA_INVALID", "Portable data file is invalid.");
  }

  return {
    id: normalizeRequiredString(macro.id),
    name: normalizeName(macro.name),
    roleIds: macro.roleIds.map(normalizeRequiredString),
    ...(macro.trigger === undefined ? {} : normalizeOptionalTriggerProperty(macro.trigger)),
    repeat: normalizeRepeat(macro.repeat),
    steps: normalizeSteps(macro.steps)
  };
}

function normalizePortablePreferences(value: unknown): PortablePreferences | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const preferences = toRecord(value);
  const language = preferences.language;
  const themeMode = preferences.themeMode;
  const gameBrowserSettings = normalizeOptionalPortableGameBrowserSettings(preferences.gameBrowserSettings);
  const roleDefaults = normalizeOptionalPortableRoleDefaults(preferences.roleDefaults);
  const normalized: PortablePreferences = {};

  if (language === "en" || language === "zh-TW" || language === "zh-CN" || language === "ja") {
    normalized.language = language;
  }

  if (themeMode === "system" || themeMode === "light" || themeMode === "dark") {
    normalized.themeMode = themeMode;
  }

  if (roleDefaults) {
    normalized.roleDefaults = roleDefaults;
  }

  if (gameBrowserSettings) {
    normalized.gameBrowserSettings = gameBrowserSettings;
  }

  return normalized.language || normalized.themeMode || normalized.roleDefaults || normalized.gameBrowserSettings
    ? normalized
    : undefined;
}

function normalizeOptionalPortableGameBrowserSettings(value: unknown): GameBrowserSettings | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  return normalizeGameBrowserSettings(value);
}

function normalizeOptionalPortableRoleDefaults(value: unknown): RoleDefaults | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  try {
    const defaults = toRecord(value);
    const windowWidth = defaults.windowWidth;
    const windowHeight = defaults.windowHeight;
    const launchPreset = defaults.launchPreset;

    if (
      !isValidRoleDefaultWindowSize(windowWidth) ||
      !isValidRoleDefaultWindowSize(windowHeight) ||
      (launchPreset !== "balanced" && launchPreset !== "performance")
    ) {
      return undefined;
    }

    return {
      windowWidth,
      windowHeight,
      launchPreset
    };
  } catch {
    return undefined;
  }
}

function isValidRoleDefaultWindowSize(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 640 && value <= 7680;
}

function normalizeOptionalTriggerProperty(value: unknown): { trigger?: MacroTrigger } {
  if (value === null || value === undefined) {
    return {};
  }

  const trigger = toRecord(value);

  return {
    trigger: {
      code: normalizeKeyCode(trigger.code),
      ctrl: Boolean(trigger.ctrl),
      alt: Boolean(trigger.alt),
      shift: Boolean(trigger.shift),
      meta: Boolean(trigger.meta)
    }
  };
}

function normalizeRepeat(value: unknown): MacroRepeat {
  const repeat = toRecord(value);

  if (repeat.type === "once") {
    return { type: "once" };
  }

  if (repeat.type !== "loop") {
    throw new PortableDataError("PORTABLE_DATA_INVALID", "Portable data file is invalid.");
  }

  return {
    type: "loop",
    intervalMs: normalizeMilliseconds(repeat.intervalMs)
  };
}

function normalizeSteps(value: unknown): MacroStep[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MACRO_STEPS_MAX_LENGTH) {
    throw new PortableDataError("PORTABLE_DATA_INVALID", "Portable data file is invalid.");
  }

  const seenStepIds = new Set<string>();

  return value.map((rawStep) => {
    const step = toRecord(rawStep);
    const id =
      typeof step.id === "string" && step.id.trim() && !seenStepIds.has(step.id.trim())
        ? step.id.trim()
        : randomUUID();
    seenStepIds.add(id);

    switch (step.type) {
      case "key":
        return {
          id,
          type: "key",
          code: normalizeKeyCode(step.code),
          ...(normalizeOptionalLabel(step.label) ? { label: normalizeOptionalLabel(step.label) } : {})
        };
      case "click":
        return {
          id,
          type: "click",
          xPercent: normalizePercent(step.xPercent),
          yPercent: normalizePercent(step.yPercent)
        };
      case "delay":
        return {
          id,
          type: "delay",
          ms: normalizeMilliseconds(step.ms)
        };
      default:
        throw new PortableDataError("PORTABLE_DATA_INVALID", "Portable data file is invalid.");
    }
  });
}

function normalizeRect(value: unknown): PortableLaunchWorkspace["slots"][number]["rect"] {
  const rect = toRecord(value);
  const normalizedRect = {
    x: normalizeUnit(rect.x),
    y: normalizeUnit(rect.y),
    width: normalizeUnit(rect.width),
    height: normalizeUnit(rect.height)
  };

  if (
    normalizedRect.width < MIN_WORKSPACE_SLOT_SIZE ||
    normalizedRect.height < MIN_WORKSPACE_SLOT_SIZE ||
    normalizedRect.x + normalizedRect.width > 1.0001 ||
    normalizedRect.y + normalizedRect.height > 1.0001
  ) {
    throw new PortableDataError("PORTABLE_DATA_INVALID", "Portable data file is invalid.");
  }

  return {
    x: roundRectValue(normalizedRect.x),
    y: roundRectValue(normalizedRect.y),
    width: roundRectValue(normalizedRect.width),
    height: roundRectValue(normalizedRect.height)
  };
}

function normalizeRequiredString(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new PortableDataError("PORTABLE_DATA_INVALID", "Portable data file is invalid.");
  }

  return value.trim();
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  return normalizeRequiredString(value);
}

function normalizeName(value: unknown): string {
  const name = normalizeRequiredString(value);

  if (name.length > MAX_NAME_LENGTH) {
    throw new PortableDataError("PORTABLE_DATA_INVALID", "Portable data file is invalid.");
  }

  return name;
}

function normalizeLaunchPreset(value: unknown): LaunchPreset {
  if (value === "balanced" || value === "performance") {
    return value;
  }

  return "performance";
}

function normalizeLaunchUrl(value: unknown): string {
  const rawValue = typeof value === "string" && value.trim() ? value.trim() : DEFAULT_LAUNCH_URL;

  if (rawValue.length > MAX_LAUNCH_URL_LENGTH) {
    throw new PortableDataError("PORTABLE_DATA_INVALID", "Portable data file is invalid.");
  }

  try {
    const url = new URL(rawValue);

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Unsupported URL protocol.");
    }

    return url.toString();
  } catch {
    throw new PortableDataError("PORTABLE_DATA_INVALID", "Portable data file is invalid.");
  }
}

function normalizeWindowSize(value: unknown, fallback: number): number {
  const size = value ?? fallback;

  if (!Number.isInteger(size) || Number(size) < 640 || Number(size) > 7680) {
    throw new PortableDataError("PORTABLE_DATA_INVALID", "Portable data file is invalid.");
  }

  return Number(size);
}

function normalizeOptionalCoverImageDataUrl(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const trimmed = normalizeRequiredString(value);

  if (trimmed.length > MAX_COVER_IMAGE_DATA_URL_LENGTH || !COVER_IMAGE_DATA_URL_PATTERN.test(trimmed)) {
    throw new PortableDataError("PORTABLE_DATA_INVALID", "Portable data file is invalid.");
  }

  return trimmed;
}

function normalizeOptionalCoverImageDominantColorProperty(value: unknown): { coverImageDominantColor?: string } {
  if (value === undefined || value === null || value === "") {
    return {};
  }

  const color = normalizeRequiredString(value);

  if (!COVER_IMAGE_DOMINANT_COLOR_PATTERN.test(color)) {
    throw new PortableDataError("PORTABLE_DATA_INVALID", "Portable data file is invalid.");
  }

  return { coverImageDominantColor: color.toUpperCase() };
}

function normalizeKeyCode(value: unknown): string {
  const code = normalizeRequiredString(value);

  if (code.length > MACRO_CODE_MAX_LENGTH || !/^[A-Za-z0-9]+$/.test(code)) {
    throw new PortableDataError("PORTABLE_DATA_INVALID", "Portable data file is invalid.");
  }

  return code;
}

function normalizeOptionalLabel(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const label = value.trim();
  return label ? label.slice(0, MACRO_LABEL_MAX_LENGTH) : undefined;
}

function normalizePercent(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new PortableDataError("PORTABLE_DATA_INVALID", "Portable data file is invalid.");
  }

  return Math.round(value * 100) / 100;
}

function normalizeMilliseconds(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > MACRO_DELAY_MAX_MS) {
    throw new PortableDataError("PORTABLE_DATA_INVALID", "Portable data file is invalid.");
  }

  return Number(value);
}

function normalizeUnit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new PortableDataError("PORTABLE_DATA_INVALID", "Portable data file is invalid.");
  }

  return value;
}

function reserveUniqueName(name: string, usedNames: Set<string>): string {
  const normalizedName = name.trim();

  if (!usedNames.has(normalizeNameKey(normalizedName))) {
    usedNames.add(normalizeNameKey(normalizedName));
    return normalizedName;
  }

  for (let index = 1; index < 10_000; index += 1) {
    const suffix = index === 1 ? " (Imported)" : ` (Imported ${index})`;
    const baseName = normalizedName.slice(0, Math.max(1, MAX_NAME_LENGTH - suffix.length)).trim();
    const candidate = `${baseName}${suffix}`;
    const key = normalizeNameKey(candidate);

    if (!usedNames.has(key)) {
      usedNames.add(key);
      return candidate;
    }
  }

  throw new PortableDataError("PORTABLE_NAME_CONFLICT", "Unable to create a unique imported name.");
}

function normalizeNameKey(name: string): string {
  return name.trim().toLocaleLowerCase();
}

function ensureUniqueIds(ids: string[]): void {
  const uniqueIds = new Set(ids);

  if (uniqueIds.size !== ids.length) {
    throw new PortableDataError("PORTABLE_DATA_INVALID", "Portable data file is invalid.");
  }
}

function toRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PortableDataError("PORTABLE_DATA_INVALID", "Portable data file is invalid.");
  }

  return value as Record<string, unknown>;
}

function isString(value: string | undefined): value is string {
  return typeof value === "string";
}

function roundRectValue(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
