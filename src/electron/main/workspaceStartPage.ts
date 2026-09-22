import page from "../../shared/generated/workspace-start.html?raw";
import { isWorkspaceStartUrl, WORKSPACE_START_URL, workspaceStartAppearanceScript } from "../../shared/workspaceStartPage";
import type { ChromiumRoleSessionPort } from "./chromiumRoleSessionRegistry";
import type { ChromiumRoleSurfaceWebContentsPort } from "./chromiumRoleSurfacePorts";
import type { AppLanguage, ResolvedTheme } from "../../shared/types";
import { readWorkspaceWebTheme, updateWorkspaceWebTheme } from "./workspaceWebTheme";

const sessions = new WeakSet<ChromiumRoleSessionPort>();
const contents = new Set<ChromiumRoleSurfaceWebContentsPort>();
let language: AppLanguage = "en";
const languageListeners = new Set<() => void>();

export function readWorkspaceWebLanguage(): AppLanguage { return language; }

export function subscribeWorkspaceWebLanguage(listener: () => void): () => void {
  languageListeners.add(listener);
  return () => { languageListeners.delete(listener); };
}

export function installWorkspaceStartProtocol(session: ChromiumRoleSessionPort): void {
  if (sessions.has(session)) return;
  session.protocol.handle("rion-start", (request) => new Response(
    request.url === WORKSPACE_START_URL && request.method === "GET" ? page : "Not found",
    { status: request.url === WORKSPACE_START_URL && request.method === "GET" ? 200 : 404,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }
  ));
  sessions.add(session);
}

function apply(target: ChromiumRoleSurfaceWebContentsPort): void {
  if (target.isDestroyed() || !isWorkspaceStartUrl(target.getURL())) return;
  // EventBound: presentation follows the acknowledged setting or exact page-load event.
  void target.executeJavaScriptInIsolatedWorld(997, [
    { code: workspaceStartAppearanceScript(language, readWorkspaceWebTheme()) }
  ]).catch(() => undefined); // A superseded/destroyed document has no presentation work left.
}

export function observeWorkspaceStartPage(target: ChromiumRoleSurfaceWebContentsPort): void {
  contents.add(target);
  const loaded = () => apply(target);
  const destroyed = () => {
    contents.delete(target);
    target.removeListener("did-finish-load", loaded);
    target.removeListener("destroyed", destroyed);
  };
  target.on("did-finish-load", loaded);
  target.on("destroyed", destroyed);
}

export function updateWorkspaceStartAppearance(patch: { language?: AppLanguage; theme?: ResolvedTheme }): void {
  const languageChanged = patch.language !== undefined && language !== patch.language;
  language = patch.language ?? language;
  if (patch.theme !== undefined) updateWorkspaceWebTheme(patch.theme);
  // EventBound: only the acknowledged language setting publishes new chrome copy.
  if (languageChanged) for (const listener of languageListeners) listener();
  for (const target of contents) apply(target);
}
