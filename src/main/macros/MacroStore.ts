import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type {
  CreateMacroInput,
  Macro,
  MacroRepeat,
  MacroStep,
  MacroTrigger,
  UpdateMacroInput
} from "../../shared/types";

interface MacrosFile {
  macros: Macro[];
}

type StoredMacro = Macro & {
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
  private readonly macrosPath: string;

  constructor(private readonly userDataDir: string) {
    this.macrosPath = join(userDataDir, "macros.json");
  }

  async listMacros(): Promise<Macro[]> {
    const file = await this.readMacrosFile();
    return [...file.macros].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getMacro(id: string): Promise<Macro> {
    const macro = (await this.listMacros()).find((item) => item.id === id);

    if (!macro) {
      throw new MacroStoreError("MACRO_NOT_FOUND", "Macro not found.");
    }

    return macro;
  }

  async createMacro(input: CreateMacroInput): Promise<Macro> {
    const file = await this.readMacrosFile();
    const now = new Date().toISOString();
    const name = this.normalizeName(input.name);

    this.ensureUniqueName(file.macros, name);

    const macro: Macro = {
      id: randomUUID(),
      name,
      roleId: this.normalizeRoleId(input.roleId),
      trigger: this.normalizeTrigger(input.trigger),
      repeat: this.normalizeRepeat(input.repeat),
      steps: this.normalizeSteps(input.steps),
      createdAt: now,
      updatedAt: now
    };

    file.macros.push(macro);
    await this.writeMacrosFile(file);

    return macro;
  }

  async updateMacro(id: string, input: UpdateMacroInput): Promise<Macro> {
    const file = await this.readMacrosFile();
    const index = file.macros.findIndex((macro) => macro.id === id);

    if (index === -1) {
      throw new MacroStoreError("MACRO_NOT_FOUND", "Macro not found.");
    }

    const current = file.macros[index];
    const name = input.name === undefined ? current.name : this.normalizeName(input.name);
    this.ensureUniqueName(file.macros, name, id);

    const updated: Macro = {
      ...current,
      name,
      roleId: input.roleId === undefined ? current.roleId : this.normalizeRoleId(input.roleId),
      trigger: input.trigger === undefined ? current.trigger : this.normalizeTrigger(input.trigger),
      repeat: input.repeat === undefined ? current.repeat : this.normalizeRepeat(input.repeat),
      steps: input.steps === undefined ? current.steps : this.normalizeSteps(input.steps),
      updatedAt: new Date().toISOString()
    };

    file.macros[index] = updated;
    await this.writeMacrosFile(file);

    return updated;
  }

  async deleteMacro(id: string): Promise<void> {
    const file = await this.readMacrosFile();
    const nextMacros = file.macros.filter((macro) => macro.id !== id);

    if (nextMacros.length === file.macros.length) {
      throw new MacroStoreError("MACRO_NOT_FOUND", "Macro not found.");
    }

    await this.writeMacrosFile({ macros: nextMacros });
  }

  async deleteRoleMacros(roleId: string): Promise<void> {
    const file = await this.readMacrosFile();
    const macros = file.macros.filter((macro) => macro.roleId !== roleId);

    if (macros.length === file.macros.length) {
      return;
    }

    await this.writeMacrosFile({ macros });
  }

  private async readMacrosFile(): Promise<MacrosFile> {
    try {
      const raw = await readFile(this.macrosPath, "utf8");
      const parsed = JSON.parse(raw) as MacrosFile;

      if (!Array.isArray(parsed.macros)) {
        throw new MacroStoreError("MACRO_FILE_INVALID", "Macro data file is invalid.");
      }

      const didMigrate = parsed.macros.some((macro) => LEGACY_ROLE_ID_FIELD in (macro as StoredMacro));
      const file = {
        macros: parsed.macros.map((macro) => this.normalizeStoredMacro(macro as StoredMacro))
      };

      if (didMigrate) {
        await this.writeMacrosFile(file);
      }

      return file;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { macros: [] };
      }

      throw error;
    }
  }

  private async writeMacrosFile(file: MacrosFile): Promise<void> {
    await mkdir(dirname(this.macrosPath), { recursive: true });
    const tmpPath = `${this.macrosPath}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    await rename(tmpPath, this.macrosPath);
  }

  private normalizeStoredMacro(macro: StoredMacro): Macro {
    const now = new Date().toISOString();

    return {
      id: typeof macro.id === "string" && macro.id.trim() ? macro.id : randomUUID(),
      name: this.normalizeName(macro.name),
      roleId: this.normalizeRoleId(this.readMacroRoleId(macro)),
      trigger: this.normalizeTrigger(macro.trigger),
      repeat: this.normalizeRepeat(macro.repeat),
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

  private normalizeRoleId(roleId: unknown): string {
    if (typeof roleId !== "string") {
      throw new MacroStoreError("MACRO_ROLE_ID_INVALID", "Macro role assignment is invalid.");
    }

    const normalized = roleId.trim();

    if (!normalized) {
      throw new MacroStoreError("MACRO_ROLE_ID_INVALID", "Macro role assignment is invalid.");
    }

    return normalized;
  }

  private readMacroRoleId(macro: StoredMacro): unknown {
    return macro.roleId === undefined ? macro[LEGACY_ROLE_ID_FIELD] : macro.roleId;
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

  private normalizeRepeat(repeat: MacroRepeat | undefined): MacroRepeat {
    if (repeat === undefined || repeat.type === "once") {
      return { type: "once" };
    }

    if (repeat.type !== "loop") {
      throw new MacroStoreError("MACRO_REPEAT_INVALID", "Macro repeat setting is invalid.");
    }

    return {
      type: "loop",
      intervalMs: this.normalizeMilliseconds(repeat.intervalMs, "Macro interval must be between 0 and 600000 ms.")
    };
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

  private ensureUniqueName(macros: Macro[], name: string, currentId?: string): void {
    const duplicate = macros.some(
      (macro) => macro.id !== currentId && macro.name.toLocaleLowerCase() === name.toLocaleLowerCase()
    );

    if (duplicate) {
      throw new MacroStoreError("MACRO_NAME_DUPLICATE", "A macro with this name already exists.");
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
