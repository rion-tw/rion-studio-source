import type {
  MacroCreateInputRecord,
  MacroUpdateInputRecord,
  WorkspaceCreateInputRecord,
  WorkspaceUpdateInputRecord
} from "../../shared/generated";
import type {
  CreateLaunchWorkspaceInput,
  CreateMacroInput,
  UpdateLaunchWorkspaceInput,
  UpdateMacroInput
} from "../../shared/types";

export function toWorkspaceCreateInput(
  input: CreateLaunchWorkspaceInput
): WorkspaceCreateInputRecord {
  return {
    name: input.name,
    ...(input.template === undefined ? {} : { template: input.template }),
    ...(input.browserLaunchMode === undefined ? {} : { browserLaunchMode: input.browserLaunchMode }),
    ...(input.browserZoomMode === undefined ? {} : { browserZoomMode: input.browserZoomMode }),
    ...(input.browserZoomPercent === undefined ? {} : { browserZoomPercent: input.browserZoomPercent }),
    ...(input.targetDisplay && { targetDisplay: structuredClone(input.targetDisplay) }),
    ...(input.slots === undefined ? {} : { slots: structuredClone(input.slots) })
  } as WorkspaceCreateInputRecord;
}

export function toWorkspaceUpdateInput(
  input: UpdateLaunchWorkspaceInput
): WorkspaceUpdateInputRecord {
  return {
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.template === undefined ? {} : { template: input.template }),
    ...(input.browserLaunchMode === undefined ? {} : { browserLaunchMode: input.browserLaunchMode }),
    ...(input.browserZoomMode === undefined ? {} : { browserZoomMode: input.browserZoomMode }),
    ...(input.browserZoomPercent === undefined ? {} : { browserZoomPercent: input.browserZoomPercent }),
    setTargetDisplay: input.targetDisplay !== undefined,
    ...(input.targetDisplay && { targetDisplay: structuredClone(input.targetDisplay) }),
    ...(input.slots === undefined ? {} : { slots: structuredClone(input.slots) })
  } as WorkspaceUpdateInputRecord;
}

export function toMacroCreateInput(input: CreateMacroInput): MacroCreateInputRecord {
  return {
    ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    ...(input.activationMode === undefined ? {} : { activationMode: input.activationMode }),
    name: input.name,
    roleIds: [...input.roleIds],
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
    setTrigger: input.trigger !== undefined,
    ...(input.trigger ? { trigger: structuredClone(input.trigger) } : {}),
    ...(input.repeat === undefined ? {} : { repeat: structuredClone(input.repeat) }),
    ...(input.steps === undefined ? {} : { steps: structuredClone(input.steps) })
  } as MacroUpdateInputRecord;
}
