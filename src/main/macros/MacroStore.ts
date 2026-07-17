import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  BulkDeleteResult,
  CreateMacroInput,
  Macro,
  MacroActivationMode,
  MacroKeyAction,
  MacroRepeat,
  MacroStep,
  MacroTrigger,
  UpdateMacroInput
} from "../../shared/types";
import { findMacroDependencyIssue, getMacroReferrers } from "../../shared/macroDependencies";
import { MACRO_DELAY_MAX_MS } from "../../shared/macroSettings";
import {
  areMacroTriggersEqual,
  macroRoleAssignmentsOverlap,
  MACRO_OVERLAY_TRIGGER
} from "../../shared/macroShortcuts";
import { SerialTaskQueue } from "../persistence/SerialTaskQueue";
import { writeJsonFileAtomically } from "../persistence/atomicJsonFile";

interface MacrosFile {
  macros: Macro[];
}

type StoredMacro = Macro & {
  activationMode?: unknown;
  roleId?: unknown;
  roleIds?: unknown;
  [key: string]: unknown;
};

const LEGACY_ROLE_ID_FIELD = "profile" + "Id";

const MACRO_NAME_MAX_LENGTH = 80;
const MACRO_STEPS_MAX_LENGTH = 100;
const MACRO_CODE_MAX_LENGTH = 48;
const MACRO_LABEL_MAX_LENGTH = 48;
const MACRO_ID_MAX_LENGTH = 128;
const MACRO_DELAY_INVALID_MESSAGE = `Macro delay must be between 0 and ${MACRO_DELAY_MAX_MS} ms.`;
const MACRO_INTERVAL_INVALID_MESSAGE = `Macro interval must be between 0 and ${MACRO_DELAY_MAX_MS} ms.`;

export class MacroStoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: { relatedNames?: string[] }
  ) {
    super(message);
    this.name = "MacroStoreError";
  }
}

export class MacroStore {
  private cachedFile: MacrosFile | undefined;
  private readonly macrosPath: string;
  private readonly taskQueue = new SerialTaskQueue();

  constructor(private readonly userDataDir: string) {
    this.macrosPath = join(userDataDir, "macros.json");
  }

  async listMacros(): Promise<Macro[]> {
    return this.taskQueue.run(async () => {
      const file = await this.readMacrosFile();
      return [...file.macros].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    });
  }

  async replaceMacrosForImport(macros: Macro[], publishCache = true): Promise<Macro[]> {
    return this.taskQueue.run(async () => {
      const normalized = macros.map((macro) => this.normalizeStoredMacro(macro as StoredMacro));
      normalized.forEach((macro) => {
        this.assertActivationMode(macro);
        this.assertTriggerAvailable(macro.trigger, macro.roleIds, normalized, macro.id);
      });
      this.assertDependencyGraph(normalized);
      await this.writeMacrosFile({ macros: normalized }, publishCache);
      return cloneMacrosFile({ macros: normalized }).macros;
    });
  }

  publishMacrosForImport(macros: Macro[]): void {
    this.cachedFile = cloneMacrosFile({ macros });
  }

  async getMacro(id: string): Promise<Macro> {
    return this.taskQueue.run(async () => {
      const macro = (await this.readMacrosFile()).macros.find((item) => item.id === id);

      if (!macro) {
        throw new MacroStoreError("MACRO_NOT_FOUND", "Macro not found.");
      }

      return macro;
    });
  }

  async createMacro(input: CreateMacroInput): Promise<Macro> {
    return this.taskQueue.run(async () => {
      const file = await this.readMacrosFile();
      const now = new Date().toISOString();
      const name = this.normalizeName(input.name);

      const macro: Macro = {
        id: randomUUID(),
        enabled: input.enabled === undefined ? true : this.normalizeEnabled(input.enabled),
        activationMode: this.normalizeActivationMode(input.activationMode),
        name,
        roleIds: this.normalizeRoleIds(input.roleIds),
        trigger: this.normalizeTrigger(input.trigger),
        repeat: this.normalizeRepeat(input.repeat),
        steps: this.normalizeSteps(input.steps),
        createdAt: now,
        updatedAt: now
      };

      this.assertActivationMode(macro);
      this.assertTriggerAvailable(macro.trigger, macro.roleIds, file.macros);

      this.assertDependencyGraph([...file.macros, macro]);

      file.macros.push(macro);
      await this.writeMacrosFile(file);

      return macro;
    });
  }

  async updateMacro(id: string, input: UpdateMacroInput): Promise<Macro> {
    return this.taskQueue.run(async () => {
      const file = await this.readMacrosFile();
      const index = file.macros.findIndex((macro) => macro.id === id);

      if (index === -1) {
        throw new MacroStoreError("MACRO_NOT_FOUND", "Macro not found.");
      }

      const current = file.macros[index];
      const name = input.name === undefined ? current.name : this.normalizeName(input.name);

      const updated: Macro = {
        ...current,
        enabled: input.enabled === undefined ? current.enabled : this.normalizeEnabled(input.enabled),
        activationMode: input.activationMode === undefined
          ? current.activationMode
          : this.normalizeActivationMode(input.activationMode),
        name,
        roleIds: input.roleIds === undefined ? current.roleIds : this.normalizeRoleIds(input.roleIds),
        trigger: input.trigger === undefined ? current.trigger : this.normalizeTrigger(input.trigger),
        repeat: input.repeat === undefined ? current.repeat : this.normalizeRepeat(input.repeat),
        steps: input.steps === undefined ? current.steps : this.normalizeSteps(input.steps),
        updatedAt: new Date().toISOString()
      };

      this.assertActivationMode(updated);
      this.assertTriggerAvailable(updated.trigger, updated.roleIds, file.macros, id);

      this.assertDependencyGraph(file.macros.map((macro) => macro.id === id ? updated : macro));

      file.macros[index] = updated;
      await this.writeMacrosFile(file);

      return updated;
    });
  }

  async deleteMacro(id: string): Promise<void> {
    return this.taskQueue.run(async () => {
      const file = await this.readMacrosFile();
      if (!file.macros.some((macro) => macro.id === id)) {
        throw new MacroStoreError("MACRO_NOT_FOUND", "Macro not found.");
      }

      const referrers = getMacroReferrers(file.macros, id);
      if (referrers.length > 0) {
        throw new MacroStoreError(
          "MACRO_IN_USE",
          `Macro is used by: ${referrers.map((macro) => macro.name).join(", ")}.`,
          { relatedNames: referrers.map((macro) => macro.name) }
        );
      }

      await this.writeMacrosFile({ macros: file.macros.filter((macro) => macro.id !== id) });
    });
  }

  async deleteMacros(ids: string[]): Promise<BulkDeleteResult> {
    return this.taskQueue.run(async () => {
      const file = await this.readMacrosFile();
      const requestedIds = [...new Set(ids)];
      const existingIds = new Set(file.macros.map((macro) => macro.id));
      const deletableIds = new Set(requestedIds.filter((id) => existingIds.has(id)));

      let didChange = true;
      while (didChange) {
        didChange = false;
        const remainingMacros = file.macros.filter((macro) => !deletableIds.has(macro.id));
        for (const id of [...deletableIds]) {
          if (getMacroReferrers(remainingMacros, id).length > 0) {
            deletableIds.delete(id);
            didChange = true;
          }
        }
      }

      const remainingMacros = file.macros.filter((macro) => !deletableIds.has(macro.id));
      const skipped: BulkDeleteResult["skipped"] = [];
      requestedIds.forEach((id) => {
        if (!existingIds.has(id)) {
          skipped.push({ id, reason: "not_found" });
        } else if (!deletableIds.has(id)) {
          skipped.push({
            id,
            reason: "in_use",
            relatedNames: getMacroReferrers(remainingMacros, id).map((macro) => macro.name)
          });
        }
      });
      const result: BulkDeleteResult = {
        deletedIds: requestedIds.filter((id) => deletableIds.has(id)),
        skipped
      };

      if (result.deletedIds.length > 0) {
        await this.writeMacrosFile({
          macros: file.macros.filter((macro) => !deletableIds.has(macro.id))
        });
      }
      return result;
    });
  }

  async deleteRoleMacros(roleId: string): Promise<void> {
    return this.taskQueue.run(async () => {
      const file = await this.readMacrosFile();
      const updatedMacros = file.macros.map((macro) => ({
        ...macro,
        roleIds: macro.roleIds.filter((assignedRoleId) => assignedRoleId !== roleId)
      }));
      const removedIds = new Set(
        updatedMacros.filter((macro) => macro.roleIds.length === 0).map((macro) => macro.id)
      );
      let didExpand = true;
      while (didExpand) {
        didExpand = false;
        updatedMacros.forEach((macro) => {
          if (
            !removedIds.has(macro.id) &&
            macro.steps.some((step) => step.type === "macro" && removedIds.has(step.macroId))
          ) {
            removedIds.add(macro.id);
            didExpand = true;
          }
        });
      }
      const macros = updatedMacros.filter((macro) => !removedIds.has(macro.id));

      if (JSON.stringify(macros) === JSON.stringify(file.macros)) {
        return;
      }

      this.assertDependencyGraph(macros);
      await this.writeMacrosFile({ macros });
    });
  }

  private async readMacrosFile(): Promise<MacrosFile> {
    if (this.cachedFile) {
      return cloneMacrosFile(this.cachedFile);
    }

    try {
      const raw = await readFile(this.macrosPath, "utf8");
      const parsed = JSON.parse(raw) as MacrosFile;

      if (!Array.isArray(parsed.macros)) {
        throw new MacroStoreError("MACRO_FILE_INVALID", "Macro data file is invalid.");
      }

      const didMigrate = parsed.macros.some((macro) => {
        const storedMacro = macro as StoredMacro;
        return (
          "roleId" in storedMacro ||
          LEGACY_ROLE_ID_FIELD in storedMacro ||
          storedMacro.enabled === undefined ||
          storedMacro.activationMode === undefined ||
          (Array.isArray(storedMacro.steps) &&
            storedMacro.steps.some((step) => step.type === "key" && step.action === undefined))
        );
      });
      const file = {
        macros: parsed.macros.map((macro) => this.normalizeStoredMacro(macro as StoredMacro))
      };
      file.macros.forEach((macro) => this.assertActivationMode(macro));
      this.assertDependencyGraph(file.macros);

      if (didMigrate) {
        await this.writeMacrosFile(file);
      } else {
        this.cachedFile = cloneMacrosFile(file);
      }

      return cloneMacrosFile(file);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { macros: [] };
      }

      throw error;
    }
  }

  private async writeMacrosFile(file: MacrosFile, publishCache = true): Promise<void> {
    await writeJsonFileAtomically(this.macrosPath, file);
    if (publishCache) {
      this.cachedFile = cloneMacrosFile(file);
    }
  }

  private normalizeStoredMacro(macro: StoredMacro): Macro {
    const now = new Date().toISOString();

    return {
      id: typeof macro.id === "string" && macro.id.trim() ? macro.id : randomUUID(),
      enabled: macro.enabled === undefined ? true : this.normalizeEnabled(macro.enabled),
      activationMode: this.normalizeActivationMode(macro.activationMode),
      name: this.normalizeName(macro.name),
      roleIds: this.normalizeRoleIds(this.readMacroRoleIds(macro)),
      trigger: this.normalizeTrigger(macro.trigger),
      repeat: this.normalizeStoredRepeat(macro.repeat),
      steps: this.normalizeSteps(macro.steps),
      createdAt: typeof macro.createdAt === "string" ? macro.createdAt : now,
      updatedAt: typeof macro.updatedAt === "string" ? macro.updatedAt : now
    };
  }

  private normalizeName(name: string | undefined): string {
    const normalized = name?.trim() ?? "";

    if (!normalized) {
      throw new MacroStoreError("MACRO_NAME_REQUIRED", "Macro name is required.");
    }

    if (normalized.length > MACRO_NAME_MAX_LENGTH) {
      throw new MacroStoreError("MACRO_NAME_TOO_LONG", "Macro name must be 80 characters or fewer.");
    }

    return normalized;
  }

  private normalizeEnabled(enabled: unknown): boolean {
    if (typeof enabled !== "boolean") {
      throw new MacroStoreError("MACRO_ENABLED_INVALID", "Macro enabled state is invalid.");
    }

    return enabled;
  }

  private normalizeActivationMode(value: unknown): MacroActivationMode {
    if (value === undefined || value === "toggle") {
      return "toggle";
    }
    if (value === "while_held") {
      return value;
    }
    throw new MacroStoreError("MACRO_ACTIVATION_MODE_INVALID", "Macro activation mode is invalid.");
  }

  private normalizeRoleIds(roleIds: unknown): string[] {
    if (!Array.isArray(roleIds)) {
      throw new MacroStoreError("MACRO_ROLE_ID_INVALID", "Macro role assignment is invalid.");
    }

    const normalizedRoleIds = roleIds.map((roleId) => (typeof roleId === "string" ? roleId.trim() : ""));
    const uniqueRoleIds = [...new Set(normalizedRoleIds)];

    if (uniqueRoleIds.length === 0 || normalizedRoleIds.some((roleId) => roleId.length === 0)) {
      throw new MacroStoreError("MACRO_ROLE_ID_INVALID", "Macro role assignment is invalid.");
    }

    return uniqueRoleIds;
  }

  private readMacroRoleIds(macro: StoredMacro): unknown {
    if (macro.roleIds !== undefined) {
      return macro.roleIds;
    }

    const legacyRoleId = macro.roleId === undefined ? macro[LEGACY_ROLE_ID_FIELD] : macro.roleId;
    return legacyRoleId === undefined ? undefined : [legacyRoleId];
  }

  private normalizeTrigger(trigger: MacroTrigger | null | undefined): MacroTrigger | undefined {
    if (trigger === null || trigger === undefined) {
      return undefined;
    }

    return {
      code: this.normalizeCode(trigger.code, "Macro shortcut key is invalid."),
      ctrl: Boolean(trigger.ctrl),
      alt: Boolean(trigger.alt),
      shift: Boolean(trigger.shift),
      meta: Boolean(trigger.meta)
    };
  }

  private assertActivationMode(macro: Pick<Macro, "activationMode" | "trigger">): void {
    if (macro.activationMode === "while_held" && !macro.trigger) {
      throw new MacroStoreError(
        "MACRO_WHILE_HELD_TRIGGER_REQUIRED",
        "A while-held macro requires a shortcut."
      );
    }
  }

  private assertTriggerAvailable(
    trigger: MacroTrigger | undefined,
    roleIds: string[],
    macros: Macro[],
    currentMacroId?: string
  ): void {
    if (!trigger) {
      return;
    }

    if (areMacroTriggersEqual(trigger, MACRO_OVERLAY_TRIGGER)) {
      throw new MacroStoreError(
        "MACRO_TRIGGER_RESERVED",
        "Ctrl+Shift+M is reserved for the macro overlay."
      );
    }

    const conflict = macros.find(
      (macro) =>
        macro.id !== currentMacroId &&
        areMacroTriggersEqual(macro.trigger, trigger) &&
        macroRoleAssignmentsOverlap(macro.roleIds, roleIds)
    );
    if (conflict) {
      throw new MacroStoreError(
        "MACRO_TRIGGER_CONFLICT",
        "Macro shortcut conflicts with another macro assigned to the same role."
      );
    }
  }

  private normalizeRepeat(repeat: MacroRepeat | undefined): MacroRepeat {
    if (repeat === undefined || repeat.type === "once") {
      return { type: "once" };
    }

    if (repeat.type !== "loop") {
      throw new MacroStoreError("MACRO_REPEAT_INVALID", "Macro repeat setting is invalid.");
    }

    return {
      type: "loop",
      intervalMs: this.normalizeLoopInterval(repeat.intervalMs)
    };
  }

  private normalizeStoredRepeat(repeat: MacroRepeat | undefined): MacroRepeat {
    return this.normalizeRepeat(repeat);
  }

  private normalizeSteps(steps: MacroStep[] | undefined): MacroStep[] {
    if (!Array.isArray(steps)) {
      throw new MacroStoreError("MACRO_STEPS_REQUIRED", "Macro must contain at least one step.");
    }

    if (steps.length === 0) {
      throw new MacroStoreError("MACRO_STEPS_REQUIRED", "Macro must contain at least one step.");
    }

    if (steps.length > MACRO_STEPS_MAX_LENGTH) {
      throw new MacroStoreError("MACRO_STEPS_TOO_MANY", "Macro can contain at most 100 steps.");
    }

    const seenStepIds = new Set<string>();

    return steps.map((step) => {
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
            code: this.normalizeCode(step.code, "Macro key step is invalid."),
            action: this.normalizeKeyAction(step.action),
            label: this.normalizeOptionalLabel(step.label)
          };
        case "click":
          return {
            id,
            type: "click",
            xPercent: this.normalizePercent(step.xPercent, "Macro click X must be between 0 and 100."),
            yPercent: this.normalizePercent(step.yPercent, "Macro click Y must be between 0 and 100.")
          };
        case "delay":
          return {
            id,
            type: "delay",
            ms: this.normalizeMilliseconds(step.ms, MACRO_DELAY_INVALID_MESSAGE)
          };
        case "macro":
          return {
            id,
            type: "macro",
            macroId: this.normalizeMacroId(step.macroId)
          };
        default:
          throw new MacroStoreError("MACRO_STEP_INVALID", "Macro step is invalid.");
      }
    });
  }

  private normalizeCode(code: string | undefined, message: string): string {
    const normalized = code?.trim() ?? "";

    if (!normalized || normalized.length > MACRO_CODE_MAX_LENGTH || !/^[A-Za-z0-9]+$/.test(normalized)) {
      throw new MacroStoreError("MACRO_KEY_CODE_INVALID", message);
    }

    return normalized;
  }

  private normalizeKeyAction(value: unknown): MacroKeyAction {
    if (value === undefined || value === "tap") {
      return "tap";
    }
    if (value === "hold_until_stop") {
      return value;
    }
    throw new MacroStoreError("MACRO_KEY_ACTION_INVALID", "Macro key action is invalid.");
  }

  private normalizeMacroId(value: string | undefined): string {
    const normalized = value?.trim() ?? "";
    if (!normalized || normalized.length > MACRO_ID_MAX_LENGTH) {
      throw new MacroStoreError("MACRO_STEP_TARGET_INVALID", "Macro step target is invalid.");
    }
    return normalized;
  }

  private assertDependencyGraph(macros: Macro[]): void {
    const issue = findMacroDependencyIssue(macros);
    if (!issue) return;

    const macroById = new Map(macros.map((macro) => [macro.id, macro]));
    if (issue.type === "missing") {
      throw new MacroStoreError("MACRO_STEP_TARGET_NOT_FOUND", "Macro step target was not found.");
    }
    if (issue.type === "repeat") {
      throw new MacroStoreError("MACRO_STEP_TARGET_REPEATS", "Macro step target must run once.");
    }
    if (issue.type === "hold") {
      throw new MacroStoreError(
        "MACRO_STEP_TARGET_HOLDS_KEY",
        "Macro step target cannot hold a key until stopped."
      );
    }
    throw new MacroStoreError(
      "MACRO_DEPENDENCY_CYCLE",
      `Macro dependency cycle: ${issue.macroIds.map((id) => macroById.get(id)?.name ?? id).join(" → ")}.`
    );
  }

  private normalizeOptionalLabel(label: string | undefined): string | undefined {
    const normalized = label?.trim() ?? "";

    if (!normalized) {
      return undefined;
    }

    return normalized.slice(0, MACRO_LABEL_MAX_LENGTH);
  }

  private normalizePercent(value: number, message: string): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
      throw new MacroStoreError("MACRO_CLICK_PERCENT_INVALID", message);
    }

    return Math.round(value * 100) / 100;
  }

  private normalizeMilliseconds(value: number, message: string): number {
    if (!Number.isInteger(value) || value < 0 || value > MACRO_DELAY_MAX_MS) {
      throw new MacroStoreError("MACRO_TIME_INVALID", message);
    }

    return value;
  }

  private normalizeLoopInterval(value: number): number {
    if (!Number.isInteger(value) || value < 0 || value > MACRO_DELAY_MAX_MS) {
      throw new MacroStoreError("MACRO_TIME_INVALID", MACRO_INTERVAL_INVALID_MESSAGE);
    }

    return value;
  }
}

function cloneMacrosFile(file: MacrosFile): MacrosFile {
  return {
    macros: file.macros.map((macro) => ({
      ...macro,
      roleIds: [...macro.roleIds],
      ...(macro.trigger ? { trigger: { ...macro.trigger } } : {}),
      repeat: { ...macro.repeat },
      steps: macro.steps.map((step) => ({ ...step }))
    }))
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
