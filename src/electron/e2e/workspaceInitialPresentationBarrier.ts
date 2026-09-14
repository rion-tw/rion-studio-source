import { BrowserWindow, screen } from "electron";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ChromiumPlatformRuntimeHostFactory } from "../main/chromiumRuntimeHostFactory";
import { ChromiumRoleSurfaceRegistry } from "../main/chromiumRoleSurfaceRegistry";
import { ChromiumGlobalWebPresentationRegistry } from "../main/chromiumGlobalWebPresentationRegistry";
import { ChromiumRuntimeLayoutResolver } from "../main/chromiumRuntimeLayoutResolver";

/** E2E-only, fixture-event barriers. Never bundled into the production entry. */
export function installWorkspaceInitialPresentationBarrier(): void {
  if (process.env.RION_STUDIO_E2E_PHASE !== "chromium-workspace-gap-dividers-seed") return;
  const origin = process.env.RION_STUDIO_E2E_FIXTURE_ORIGIN!;
  const directory = process.env.RION_STUDIO_E2E_ARTIFACT_DIR!;
  const owners = new WeakMap<object, string>();
  const wait = async (id: string) => {
    const response = await fetch(`${origin}/role/${id}`);
    if (!response.ok) throw new Error(`Initial workspace barrier ${id} failed`);
    await response.text();
  };
  const factory = ChromiumPlatformRuntimeHostFactory.prototype;
  const create = factory.create;
  factory.create = async function (target, initialTab) {
    const gates = await (await fetch(`${origin}/api/gates`)).json() as Record<string, { blocked: boolean }>;
    const id = `first-host-${target.windowId}`;
    if (!gates[`${id}-before`]?.blocked) return create.call(this, target, initialTab);
    const backdrop = new BrowserWindow({ ...screen.getPrimaryDisplay().workArea,
      frame: false, focusable: false, show: false, skipTaskbar: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await backdrop.loadURL("data:text/html," + encodeURIComponent('<body id="workspace-background-checker" style="margin:0;background:repeating-conic-gradient(#00ff00 0% 25%,#ff00ff 0% 50%) 0/16px 16px">'));
    backdrop.showInactive();
    const host = await create.call(this, target, initialTab);
    owners.set(host, id);
    host.bindRuntimeWindowState?.(event => {
      if (event.source === "closed" && !backdrop.isDestroyed()) backdrop.destroy();
    });
    const add = host.contentView.addChildView;
    host.contentView.addChildView = function (view) {
      const load = view.webContents.loadURL;
      view.webContents.loadURL = async function (url, ...args) {
        if (!url.startsWith("file:")) await wait(`${id}-mounted`);
        return load.call(this, url, ...args);
      };
      return add.call(this, view);
    };
    return host;
  };
  const roles = ChromiumRoleSurfaceRegistry.prototype;
  const createRole = roles.create;
  roles.create = async function (input) {
    const id = owners.get(input.parent);
    if (id) await wait(`${id}-before`);
    return createRole.call(this, input);
  };
  const web = ChromiumGlobalWebPresentationRegistry.prototype;
  const createWeb = web.create;
  web.create = async function (input) {
    const id = owners.get(input.parent);
    if (id) await wait(`${id}-before`);
    return createWeb.call(this, input);
  };
  const layouts = ChromiumRuntimeLayoutResolver.prototype;
  const resolve = layouts.resolveWorkspaceLayout;
  layouts.resolveWorkspaceLayout = async function (tab, host) {
    const result = await resolve.call(this, tab, host);
    if (owners.has(host)) writeFileSync(join(directory, `first-host-${host.logicalWindowId}-layout.json`),
      JSON.stringify({ ...result, roles: Object.fromEntries(result.roles), tabId: tab.tabId }));
    return result;
  };
}
