import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import { expect, it } from "vitest";

const executeFile = promisify(execFile);
const require = createRequire(import.meta.url);

it("verifies initial Role and Website zoom against real first-document Chromium commits", async () => {
  expect(["darwin", "win32"]).toContain(process.platform);
  const directory = await mkdtemp(join(tmpdir(), "rion-initial-zoom-"));
  try {
    const entry = join(directory, "probe.cjs");
    const reportPath = join(directory, "report.json");
    await build({ outfile: entry, bundle: true, platform: "node", format: "cjs", packages: "external",
      loader: { ".html": "text" },
      stdin: { resolveDir: process.cwd(), contents: `
import { app, BrowserWindow, WebContentsView, session } from "electron";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { ChromiumRoleSurfaceRegistry } from "./src/electron/main/chromiumRoleSurfaceRegistry";
import { ChromiumGlobalWebSurfaceRegistry } from "./src/electron/main/chromiumGlobalWebSurfaceRegistry";
app.setPath("userData", process.argv[3]);
app.on("window-all-closed", () => {});
app.whenReady().then(async () => {
 const responses = new Map();
 const server = createServer((request, response) => {
   responses.set(request.url, response);
   response.writeHead(200, { "Content-Type": "text/html" });
   response.write("<html><body>Initial zoom fixture");
 });
 await new Promise(ready => server.listen(0, "127.0.0.1", ready));
 const host = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
 const parent = { id: host.id, contentView: host.contentView, isDestroyed: () => host.isDestroyed() };
 const outcomes = [];
 try {
   for (const kind of ["role", "web"]) for (const factor of [1.1, 0.8, 1.25]) {
     const id = kind + "-" + factor;
     const nativeSession = session.fromPartition(id);
     let view;
     const factory = { create: ({ webPreferences }) => {
       view = new WebContentsView({ webPreferences });
       return view;
     }};
     const registry = kind === "role" ? new ChromiumRoleSurfaceRegistry({
       ensure: () => ({ roleId: id, chromiumUserDataDir: process.argv[3], session: nativeSession }),
       releaseRole: async () => true, dispose: async () => {}
     }, factory) : new ChromiumGlobalWebSurfaceRegistry({
       acquireSurface: () => ({ surfaceId: id, surfaceGeneration: 1, session: nativeSession }),
       releaseSurface: async () => true, dispose: async () => {}
     }, factory);
     const path = "/" + id;
     const url = "http://127.0.0.1:" + server.address().port + path;
     const common = { parent, generation: 1, tabId: id, zoomFactor: factor, audioMuted: false,
       visible: true, bounds: { x: 0, y: 0, width: 640, height: 480 }, url };
     const creation = registry.create(kind === "role" ? { ...common, roleId: id,
       rolePaths: {}, preloadPath: ${JSON.stringify(resolve("out/preload/chromium-role-trusted-input.js"))}
     } : { ...common, surfaceId: id, slotId: id, attemptGeneration: id,
       windowId: "window", windowGeneration: 1, profile: {} });
     const beforeCommit = view.webContents.getZoomFactor();
     let atCommit;
     const expected = factor === 1.1 ? 1.2 : factor;
     view.webContents.once("did-navigate", () => {
       atCommit = view.webContents.getZoomFactor();
       if (expected !== factor) registry.setZoomFactor(id, 1, expected);
       responses.get(path).end("</body></html>");
     });
     await creation;
     outcomes.push({ kind, factor, beforeCommit, atCommit, expected,
       atReady: registry.readProjection(id, 1).zoomFactor });
     if (kind === "role") await registry.closeRole(id, 1);
     else await registry.closeSurface(id, 1);
   }
 } finally {
   host.destroy(); server.closeAllConnections(); await new Promise(done => server.close(done));
 }
 await writeFile(process.argv[2], JSON.stringify({ platform: process.platform, outcomes }));
 app.quit();
}).catch(error => { console.error(error); app.exit(1); });
` } });
    await executeFile(require("electron") as string, [entry, reportPath, join(directory, "data")],
      { timeout: 30_000, maxBuffer: 1024 * 1024 });
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    process.stdout.write(`${JSON.stringify(report)}\n`);
    expect(report.platform).toBe(process.platform);
    expect(report.outcomes).toHaveLength(6);
    for (const outcome of report.outcomes) {
      expect(outcome.beforeCommit).toBe(1);
      expect(outcome.atCommit).toBe(outcome.factor);
      expect(outcome.atReady).toBe(outcome.expected);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
