export const TOKEN = "a".repeat(64);
export const GAME_ID = "10000000-0000-4000-8000-000000000001";
export const ROLE_ID = "10000000-0000-4000-8000-000000000002";
export const TRANSFER_ID = "10000000-0000-4000-8000-000000000003";
export const CLEAR_OPERATION_ID = "10000000-0000-4000-8000-000000000004";
export const TAB_ID = "10000000-0000-4000-8000-000000000005";
export const WINDOW_ID = "10000000-0000-4000-8000-000000000006";
export const ATTEMPT_ID = "10000000-0000-4000-8000-000000000007";
export const WINDOW_LAUNCH_ID = "10000000-0000-4000-8000-000000000008";
export const WEB_SLOT_ID = "slot-1";
export const ROLE_SLOT_ID = "slot-2";
export const TARGET_TAB_ID = "10000000-0000-4000-8000-00000000000a";
export const TARGET_WINDOW_ID = "10000000-0000-4000-8000-00000000000b";
export const TARGET_SLOT_ID = "10000000-0000-4000-8000-00000000000c";
export const TARGET_ATTEMPT_ID = "10000000-0000-4000-8000-00000000000d";
export const POPUP_ID = "10000000-0000-4000-8000-00000000000e";
export const POPUP_OPEN_OPERATION_ID = "10000000-0000-4000-8000-00000000000f";
export const POPUP_EVENT_IDS = [
  "10000000-0000-4000-8000-000000000010",
  "10000000-0000-4000-8000-000000000011",
  "10000000-0000-4000-8000-000000000012"
] as const;
export const ZOOM_OPERATION_ID = "10000000-0000-4000-8000-000000000013";
export const TARGET_WINDOW_LAUNCH_ID = "10000000-0000-4000-8000-000000000014";
export const workspaceWebInspection = Object.freeze({
  appKitIdentity: Object.freeze({
    launchGeneration: ATTEMPT_ID,
    logicalWindowId: WINDOW_ID,
    nativeGeneration: 3
  }),
  attemptGeneration: ATTEMPT_ID,
  coreSlots: Object.freeze([
    Object.freeze({
      id: WEB_SLOT_ID,
      rect: Object.freeze({ height: 1, width: 0.56, x: 0, y: 0 }),
      roleId: null,
      web: Object.freeze({
        name: "Chromium Workspace Web",
        startUrl: "http://127.0.0.1:3210/role/chromium-workspace-web"
      })
    }),
    Object.freeze({
      id: ROLE_SLOT_ID,
      rect: Object.freeze({ height: 1, width: 0.44, x: 0.56, y: 0 }),
      roleId: ROLE_ID,
      web: null
    })
  ]),
  focused: true,
  hostKind: "appkit-chromium" as const,
  parentNativeHostId: 41,
  phase: "ready" as const,
  popups: Object.freeze([]),
  presentation: "normal" as const,
  role: Object.freeze({
    bounds: Object.freeze({ height: 600, width: 422, x: 538, y: 40 }),
    generation: 5,
    roleId: ROLE_ID,
    visible: true
  }),
  tabId: TAB_ID,
  topologyRevision: 8,
  visible: true,
  web: Object.freeze({
    canGoBack: false,
    canGoForward: false,
    chromeBounds: Object.freeze({ height: 34, width: 538, x: 0, y: 40 }),
    chromeVisible: true,
    chromeShellSession: "rion-web-chrome-shell:memory" as const,
    chromeShellStoragePath: null,
    chromeShellUrl: "file:///Rion/out/renderer/runtime-web-chrome-electron.html",
    contentBounds: Object.freeze({ height: 566, width: 538, x: 0, y: 74 }),
    contentVisible: true,
    contentProfilePath: "/tmp/rion/web-profiles/global-web/chromium",
    contentSession: "global-web-persistent" as const,
    contentSessionStoragePath: "/tmp/rion/web-profiles/global-web/chromium",
    contentUrl: "http://127.0.0.1:3210/role/chromium-workspace-web",
    containedFullscreen: false,
    containedFullscreenRevision: 0,
    generation: 4,
    isolatedSessions: true as const,
    slotBounds: Object.freeze({ height: 600, width: 538, x: 0, y: 40 }),
    slotId: WEB_SLOT_ID,
    surfaceId: `web-${TAB_ID}-1`,
    tabId: TAB_ID,
    visible: true
  }),
  windowBounds: Object.freeze({ height: 640, width: 960, x: 80, y: 60 }),
  windowGeneration: 2,
  windowId: WINDOW_ID
});
