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

interface ApplyGraphicsModeUpdateOptions {
  loadDiagnostics: () => Promise<GraphicsDiagnostics>;
  onDiagnostics: (diagnostics: GraphicsDiagnostics) => void;
  onRestartRequired: (diagnostics: GraphicsDiagnostics) => Promise<void> | void;
  save: () => Promise<void>;
}

export async function applyGraphicsModeUpdate({
  loadDiagnostics,
  onDiagnostics,
  onRestartRequired,
  save
}: ApplyGraphicsModeUpdateOptions): Promise<GraphicsDiagnostics> {
  await save();
  const diagnostics = await loadDiagnostics();
  onDiagnostics(diagnostics);

  if (diagnostics.restartRequired) {
    await onRestartRequired(diagnostics);
  }

  return diagnostics;
}
