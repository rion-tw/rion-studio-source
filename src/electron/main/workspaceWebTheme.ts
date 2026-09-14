import type { ResolvedTheme } from "../../shared/types";

// Presentation cache: updated only after Core acknowledges setRuntimeTheme.
let theme: ResolvedTheme = "light";
const listeners = new Set<() => void>();

export function readWorkspaceWebTheme(): ResolvedTheme {
  return theme;
}

export function subscribeWorkspaceWebTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function updateWorkspaceWebTheme(next: ResolvedTheme): void {
  if (theme === next) return;
  theme = next;
  // EventBound: consumers follow the acknowledged setting, without polling.
  for (const listener of listeners) listener();
}
