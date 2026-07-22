import type {
  BulkDeleteResult,
  CreateMacroInput,
  Macro,
  UpdateMacroInput
} from "../../shared/types";
import type { StateRepository } from "../core/RustStateRepository";

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
    private readonly stateRepository: StateRepository
  ) {}

  listMacros(): Promise<Macro[]> {
    return this.repository().listMacros();
  }

  getMacro(id: string): Promise<Macro> {
    return this.repository().getMacro(id);
  }

  createMacro(input: CreateMacroInput): Promise<Macro> {
    return this.repository().createMacro(input);
  }

  updateMacro(id: string, input: UpdateMacroInput): Promise<Macro> {
    return this.repository().updateMacro(id, input);
  }

  deleteMacro(id: string): Promise<void> {
    return this.repository().deleteMacro(id);
  }

  deleteMacros(ids: string[]): Promise<BulkDeleteResult> {
    return this.repository().deleteMacros(ids);
  }

  clearRoleAssignment(roleId: string): Promise<void> {
    return this.repository().clearMacroRole(roleId);
  }

  private repository(): StateRepository {
    return this.stateRepository;
  }
}
