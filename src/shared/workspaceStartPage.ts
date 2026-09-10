/** Logical target represented durably by an absent Workspace Web lastUrl. */
export const WORKSPACE_START_URL = "rion-start://home/";

export function workspaceWebLaunchUrl(lastUrl?: string): string {
  return lastUrl?.trim() || WORKSPACE_START_URL;
}

export function isWorkspaceStartUrl(url: string): boolean {
  return url === WORKSPACE_START_URL;
}

/** Bounded presentation update. Safe even if a navigation wins before evaluation. */
export function workspaceStartAppearanceScript(language: string, theme: string): string {
  const locale = ["en", "zh-TW", "zh-CN", "ja"].includes(language) ? language : "en";
  const palette = theme === "dark" ? "dark" : "light";
  return `if (${JSON.stringify([WORKSPACE_START_URL])}.includes(location.href)) { document.documentElement.lang = ${JSON.stringify(locale)}; document.documentElement.dataset.theme = ${JSON.stringify(palette)}; document.documentElement.style.colorScheme = ${JSON.stringify(palette)}; }`;
}
