import { posix } from "node:path";
import type {
  BrowserActionRequest,
  CoreEffectAction,
  CoreEffectRequest,
  EmbeddedRoleViewEffectRecord,
  EmbeddedTabEffectRecord,
  RolePathsRecord
} from "../../src/shared/generated";

export function rolePaths(roleId: string): RolePathsRecord {
  const browser = posix.join("/RionData/roles", roleId, "browser");
  return {
    browserUserDataDir: browser,
    systemBrowserDataDir: posix.join(browser, "system-webview"),
    webview2UserDataDir: posix.join(browser, "system-webview", "webview2"),
    chromiumUserDataDir: posix.join(browser, "chromium"),
    webkitDataStoreKey: `role:${roleId}:wkwebview`,
    webkitDataStoreIdentifier: roleId
  };
}

function roleView(roleId: string): EmbeddedRoleViewEffectRecord {
  return {
    role: {
      id: roleId,
      gameId: "game-1",
      name: roleId,
      launchUrl: `https://${roleId}.test/play`,
      notes: "",
      createdAt: "2026-08-30T00:00:00Z",
      updatedAt: "2026-08-30T00:00:00Z"
    },
    resolvedEngine: "chromium" as EmbeddedRoleViewEffectRecord["resolvedEngine"],
    rect: { x: 0, y: 0, width: 1, height: 1 },
    zoomFactor: 1,
    zoomMode: "fixed"
  };
}

export function tab(
  tabId = "tab-1",
  windowId = "window-1",
  roleIds = ["role-1"]
): EmbeddedTabEffectRecord {
  const roles = roleIds.map(roleView);
  return {
    tabId,
    audioMuted: false,
    appkitWindowGeneration: 3,
    appkitTopologyRevision: 7,
    attemptGeneration: `${tabId}-attempt-1`,
    sourceId: roleIds[0] ?? `workspace-${tabId}`,
    name: tabId,
    workspaceAppearance: { background: "black", gap: 4 },
    target: {
      windowId,
      displayId: 101,
      scaleFactor: 2,
      workArea: { x: 0, y: 0, width: 1440, height: 900 },
      bounds: { x: 120, y: 80, width: 1152, height: 720 },
      presentation: "normal"
    },
    slots: roles.map((role, index) => ({
      slotId: `slot-${index + 1}`,
      role: role.role,
      rect: role.rect,
      zoomFactor: role.zoomFactor,
      zoomMode: role.zoomMode,
      state: "launching",
      owner: { tabId, slotId: `slot-${index + 1}`, generation: 1 }
    })),
    roles
  };
}

function webView(
  surfaceId: string,
  startUrl = `https://${surfaceId}.example.test/start`,
  rect = { x: 0, y: 0, width: 1, height: 1 },
  zoomFactor = 1.25
): EmbeddedRoleViewEffectRecord {
  const web = { name: `Web ${surfaceId}`, startUrl };
  return {
    role: {
      id: surfaceId,
      gameId: "workspace-web",
      name: web.name,
      launchUrl: startUrl,
      notes: "",
      createdAt: "",
      updatedAt: ""
    },
    web,
    resolvedEngine: "chromium",
    rect,
    zoomFactor,
    zoomMode: "fixed"
  };
}

export function webTab(
  tabId = "web-tab-1",
  windowId = "web-window-1",
  surfaceIds = ["web-surface-1"]
): EmbeddedTabEffectRecord {
  const roles = surfaceIds.map((surfaceId, index) => webView(
    surfaceId,
    undefined,
    {
      x: index / surfaceIds.length,
      y: 0,
      width: 1 / surfaceIds.length,
      height: 1
    }
  ));
  const base = tab(tabId, windowId, []);
  return {
    ...base,
    sourceId: `workspace-${tabId}`,
    workspaceId: `workspace-${tabId}`,
    slots: roles.map((role, index) => ({
      slotId: `web-slot-${index + 1}`,
      role: role.role,
      web: role.web,
      rect: role.rect,
      zoomFactor: role.zoomFactor,
      zoomMode: role.zoomMode,
      state: "launching"
    })),
    roles
  };
}

export function mixedTab(): EmbeddedTabEffectRecord {
  const managed = tab("mixed-tab-1", "mixed-window-1", ["role-1"]);
  const web = webView(
    "web-surface-1",
    undefined,
    { x: 0.5, y: 0, width: 0.5, height: 1 }
  );
  const managedView = {
    ...managed.roles[0]!,
    rect: { x: 0, y: 0, width: 0.5, height: 1 }
  };
  return {
    ...managed,
    workspaceId: "workspace-mixed-1",
    sourceId: "workspace-mixed-1",
    slots: [
      { ...managed.slots[0]!, rect: managedView.rect },
      {
        slotId: "web-slot-1",
        role: web.role,
        web: web.web,
        rect: web.rect,
        zoomFactor: web.zoomFactor,
        zoomMode: web.zoomMode,
        state: "launching"
      }
    ],
    roles: [managedView, web]
  };
}

export function globalWebProfile() {
  return {
    profileKey: "global-web" as const,
    chromiumUserDataDir: "/RionData/web-profiles/global-web/chromium"
  };
}

export function effect(
  handleId: string,
  action: CoreEffectAction,
  effectId = `${action.type}-effect`
): CoreEffectRequest {
  const eventBound = action.type === "embeddedDestroyRole" ||
    action.type === "embeddedDestroyTab" ||
    action.type === "embeddedSetTabAudioMuted" ||
    action.type === "embeddedInstallOverlays" ||
    action.type === "embeddedApplyAppKitProjection" ||
    action.type === "embeddedFollowRoleOwnership" ||
    action.type === "embeddedSetRuntimeWindowVisibility" ||
    action.type.startsWith("chromeProfileImport");
  return {
    effectId,
    operationId: `${effectId}-operation`,
    target: { kind: "app", handleId },
    completionPolicy: eventBound ? "eventBound" : "deadlineBound",
    ...(eventBound ? {} : { deadlineMs: 60_000 }),
    action
  };
}

export function browserActionEffect(
  request: BrowserActionRequest,
  overrides: Partial<CoreEffectRequest> = {}
): CoreEffectRequest {
  return {
    effectId: request.requestId,
    operationId: `${request.requestId}-operation`,
    target: { kind: "webContents", handleId: request.roleId },
    completionPolicy: "deadlineBound",
    deadlineMs: request.deadlineMs,
    action: { type: "browserAction", request },
    ...overrides
  };
}
