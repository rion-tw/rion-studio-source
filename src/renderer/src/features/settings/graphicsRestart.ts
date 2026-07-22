import type { GraphicsDiagnostics } from "../../../../shared/types";

export type GraphicsRestartState = "not_required" | "ready" | "roles_running";

export function getGraphicsRestartState(
  restartRequired: boolean,
  hasRunningRoles: boolean
): GraphicsRestartState {
  if (!restartRequired) {
    return "not_required";
  }

  return hasRunningRoles ? "roles_running" : "ready";
}

interface ApplyGraphicsSettingsUpdateOptions {
  loadDiagnostics: () => Promise<GraphicsDiagnostics>;
  onDiagnostics: (diagnostics: GraphicsDiagnostics) => void;
  save: () => Promise<void>;
}

export async function applyGraphicsSettingsUpdate({
  loadDiagnostics,
  onDiagnostics,
  save
}: ApplyGraphicsSettingsUpdateOptions): Promise<GraphicsDiagnostics> {
  await save();
  const diagnostics = await loadDiagnostics();
  onDiagnostics(diagnostics);
  return diagnostics;
}
