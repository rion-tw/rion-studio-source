import page from "../../shared/generated/workspace-start.html?raw";
import { isWorkspaceStartUrl, WORKSPACE_START_URL, workspaceStartAppearanceScript } from "../../shared/workspaceStartPage";
import type { ChromiumRoleSessionPort } from "./chromiumRoleSessionRegistry";
import type { ChromiumRoleSurfaceWebContentsPort } from "./chromiumRoleSurfacePorts";

const sessions = new WeakSet<ChromiumRoleSessionPort>();
const contents = new Set<ChromiumRoleSurfaceWebContentsPort>();
let language = "en";
let theme = "light";

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
    { code: workspaceStartAppearanceScript(language, theme) }
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

export function updateWorkspaceStartAppearance(patch: { language?: string; theme?: string }): void {
  language = patch.language ?? language;
  theme = patch.theme ?? theme;
  for (const target of contents) apply(target);
}
