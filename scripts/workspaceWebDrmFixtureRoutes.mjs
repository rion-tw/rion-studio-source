import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { workspaceWebDrmProbePage } from "./workspaceWebDrmProbe.mjs";

const require = createRequire(import.meta.url);
const playerPath = require.resolve("shaka-player/dist/shaka-player.compiled.js");

export async function serveWorkspaceWebDrmFixture(request, response, url) {
  if (request.method !== "GET") return false;
  if (url.pathname === "/drm-capabilities") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    response.end(workspaceWebDrmProbePage());
    return true;
  }
  if (url.pathname === "/drm-player.js") {
    response.writeHead(200, { "Content-Type": "application/javascript", "Cache-Control": "no-store" });
    response.end(await readFile(playerPath));
    return true;
  }
  return false;
}
