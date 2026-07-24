import type {
  BulkDeleteResult,
  CreateMacroInput,
  Macro,
  UpdateMacroInput
} from "../../shared/types";
import { toMacroCreateInput, toMacroUpdateInput } from "../core/domainInputs";
import type { AppCoreClient } from "../core/nativeCore";

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

/** Typed main-process client for the transactional Rust macro domain. */
export class MacroStore {
  constructor(
    _userDataDir: string,
    private readonly core: Pick<AppCoreClient, "invoke">
  ) {}

  listMacros(): Promise<Macro[]> {
    return this.core.invoke({ type: "macrosList" });
  }

  getMacro(id: string): Promise<Macro> {
    return this.core.invoke({ type: "macroGet", id });
  }

  createMacro(input: CreateMacroInput): Promise<Macro> {
    return this.core.invoke({ type: "macroCreate", input: toMacroCreateInput(input) });
  }

  updateMacro(id: string, input: UpdateMacroInput): Promise<Macro> {
    return this.core.invoke({
      type: "macroUpdate",
      id,
      input: toMacroUpdateInput(input)
    });
  }

  deleteMacro(id: string): Promise<void> {
    return this.core.invoke({ type: "macroDelete", id }).then(() => undefined);
  }

  deleteMacros(ids: string[]): Promise<BulkDeleteResult> {
    return this.core.invoke({ type: "macrosDelete", ids });
  }

  clearRoleAssignment(roleId: string): Promise<void> {
    return this.core.invoke({ type: "macrosClearRole", roleId }).then(() => undefined);
  }
}
