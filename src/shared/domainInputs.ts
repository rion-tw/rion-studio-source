import type {
  GameCreateInputRecord,
  GameUpdateInputRecord,
  MacroCreateInputRecord,
  MacroUpdateInputRecord,
  RoleCreateInputRecord,
  RoleUpdateInputRecord,
  WorkspaceCreateInputRecord,
  WorkspaceUpdateInputRecord
} from "./generated";
import type {
  CreateGameInput,
  CreateLaunchWorkspaceInput,
  CreateMacroInput,
  CreateRoleInput,
  UpdateGameInput,
  UpdateLaunchWorkspaceInput,
  UpdateMacroInput,
  UpdateRoleInput
} from "./types";

export function toGameCreateInput(input: CreateGameInput): GameCreateInputRecord {
  return {
    name: input.name,
    defaultLaunchUrl: input.defaultLaunchUrl,
    ...(typeof input.iconImageDataUrl === "string"
      ? { iconImageDataUrl: input.iconImageDataUrl }
      : {}),
    ...(typeof input.coverImageDataUrl === "string"
      ? { coverImageDataUrl: input.coverImageDataUrl }
      : {})
  };
}

export function toGameUpdateInput(input: UpdateGameInput): GameUpdateInputRecord {
  return {
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.defaultLaunchUrl === undefined
      ? {}
      : { defaultLaunchUrl: input.defaultLaunchUrl }),
    ...(typeof input.iconImageDataUrl === "string"
      ? { iconImageDataUrl: input.iconImageDataUrl }
      : {}),
    setIconImageDataUrl: input.iconImageDataUrl !== undefined,
    ...(typeof input.coverImageDataUrl === "string"
      ? { coverImageDataUrl: input.coverImageDataUrl }
      : {}),
    setCoverImageDataUrl: input.coverImageDataUrl !== undefined
  };
}

export function toRoleCreateInput(input: CreateRoleInput): RoleCreateInputRecord {
  return {
    gameId: input.gameId,
    name: input.name,
    ...(input.launchUrl === undefined ? {} : { launchUrl: input.launchUrl }),
    ...(input.notes === undefined ? {} : { notes: input.notes }),
    ...(typeof input.coverImageDataUrl === "string"
      ? { coverImageDataUrl: input.coverImageDataUrl }
      : {}),
    ...(typeof input.coverImageDominantColor === "string"
      ? { coverImageDominantColor: input.coverImageDominantColor }
      : {})
  };
}

export function toRoleUpdateInput(input: UpdateRoleInput): RoleUpdateInputRecord {
  return {
    ...(input.gameId === undefined ? {} : { gameId: input.gameId }),
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.launchUrl === undefined ? {} : { launchUrl: input.launchUrl }),
    ...(input.notes === undefined ? {} : { notes: input.notes }),
    ...(typeof input.coverImageDataUrl === "string"
      ? { coverImageDataUrl: input.coverImageDataUrl }
      : {}),
    setCoverImageDataUrl: input.coverImageDataUrl !== undefined,
    ...(typeof input.coverImageDominantColor === "string"
      ? { coverImageDominantColor: input.coverImageDominantColor }
      : {}),
    setCoverImageDominantColor: input.coverImageDominantColor !== undefined
  };
}

export function toWorkspaceCreateInput(
  input: CreateLaunchWorkspaceInput
): WorkspaceCreateInputRecord {
  return {
    name: input.name,
    ...(input.template === undefined ? {} : { template: input.template }),
    ...(input.slots === undefined ? {} : { slots: structuredClone(input.slots) })
  } as WorkspaceCreateInputRecord;
}

export function toWorkspaceUpdateInput(
  input: UpdateLaunchWorkspaceInput
): WorkspaceUpdateInputRecord {
  return {
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.template === undefined ? {} : { template: input.template }),
    ...(input.slots === undefined ? {} : { slots: structuredClone(input.slots) })
  } as WorkspaceUpdateInputRecord;
}

export function toMacroCreateInput(input: CreateMacroInput): MacroCreateInputRecord {
  return {
    ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    ...(input.activationMode === undefined ? {} : { activationMode: input.activationMode }),
    name: input.name,
    roleIds: [...input.roleIds],
    ...(input.shortcutSourceScope === undefined
      ? {}
      : { shortcutSourceScope: structuredClone(input.shortcutSourceScope) }),
    ...(input.trigger ? { trigger: structuredClone(input.trigger) } : {}),
    ...(input.repeat === undefined ? {} : { repeat: structuredClone(input.repeat) }),
    steps: structuredClone(input.steps)
  } as MacroCreateInputRecord;
}

export function toMacroUpdateInput(input: UpdateMacroInput): MacroUpdateInputRecord {
  return {
    ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    ...(input.activationMode === undefined ? {} : { activationMode: input.activationMode }),
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.roleIds === undefined ? {} : { roleIds: [...input.roleIds] }),
    ...(input.shortcutSourceScope === undefined
      ? {}
      : { shortcutSourceScope: structuredClone(input.shortcutSourceScope) }),
    setTrigger: input.trigger !== undefined,
    ...(input.trigger ? { trigger: structuredClone(input.trigger) } : {}),
    ...(input.repeat === undefined ? {} : { repeat: structuredClone(input.repeat) }),
    ...(input.steps === undefined ? {} : { steps: structuredClone(input.steps) })
  } as MacroUpdateInputRecord;
}
