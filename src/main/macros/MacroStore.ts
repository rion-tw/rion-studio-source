import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  CreateMacroInput,
  Macro,
  MacroRepeat,
  MacroStep,
  MacroTrigger,
  UpdateMacroInput
} from "../../shared/types";
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
  roleId?: unknown;
  roleIds?: unknown;
  [key: string]: unknown;
};

const LEGACY_ROLE_ID_FIELD = "profile" + "Id";

const MACRO_NAME_MAX_LENGTH = 80;
const MACRO_STEPS_MAX_LENGTH = 100;
const MACRO_DELAY_MAX_MS = 600_000;
const MACRO_CODE_MAX_LENGTH = 48;
const MACRO_LABEL_MAX_LENGTH = 48;

export class MacroStoreError extends Error {
  constructor(
    readonly code: string,
    message: string
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
        this.assertTriggerAvailable(macro.trigger, macro.roleIds, normalized, macro.id);
      });
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
        name,
        roleIds: this.normalizeRoleIds(input.roleIds),
        trigger: this.normalizeTrigger(input.trigger),
        repeat: this.normalizeRepeat(input.repeat),
        steps: this.normalizeSteps(input.steps),
        createdAt: now,
        updatedAt: now
      };

      this.assertTriggerAvailable(macro.trigger, macro.roleIds, file.macros);

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
        name,
        roleIds: input.roleIds === undefined ? current.roleIds : this.normalizeRoleIds(input.roleIds),
        trigger: input.trigger === undefined ? current.trigger : this.normalizeTrigger(input.trigger),
        repeat: input.repeat === undefined ? current.repeat : this.normalizeRepeat(input.repeat),
        steps: input.steps === undefined ? current.steps : this.normalizeSteps(input.steps),
        updatedAt: new Date().toISOString()
      };

      this.assertTriggerAvailable(updated.trigger, updated.roleIds, file.macros, id);

      file.macros[index] = updated;
      await this.writeMacrosFile(file);

      return updated;
    });
  }

  async deleteMacro(id: string): Promise<void> {
    return this.taskQueue.run(async () => {
      const file = await this.readMacrosFile();
      const nextMacros = file.macros.filter((macro) => macro.id !== id);

      if (nextMacros.length === file.macros.length) {
        throw new MacroStoreError("MACRO_NOT_FOUND", "Macro not found.");
      }

      await this.writeMacrosFile({ macros: nextMacros });
    });
  }

  async deleteRoleMacros(roleId: string): Promise<void> {
    return this.taskQueue.run(async () => {
      const file = await this.readMacrosFile();
      const macros = file.macros
        .map((macro) => ({
          ...macro,
          roleIds: macro.roleIds.filter((assignedRoleId) => assignedRoleId !== roleId)
        }))
        .filter((macro) => macro.roleIds.length > 0);

      if (JSON.stringify(macros) === JSON.stringify(file.macros)) {
        return;
      }

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
          (storedMacro.repeat?.type === "loop" && storedMacro.repeat.intervalMs === 0)
        );
      });
      const file = {
        macros: parsed.macros.map((macro) => this.normalizeStoredMacro(macro as StoredMacro))
      };

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
    if (repeat?.type === "loop" && repeat.intervalMs === 0) {
      return { type: "loop", intervalMs: 1 };
    }

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
            ms: this.normalizeMilliseconds(step.ms, "Macro delay must be between 0 and 600000 ms.")
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
    if (!Number.isInteger(value) || value < 1 || value > MACRO_DELAY_MAX_MS) {
      throw new MacroStoreError("MACRO_TIME_INVALID", "Macro interval must be between 1 and 600000 ms.");
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
