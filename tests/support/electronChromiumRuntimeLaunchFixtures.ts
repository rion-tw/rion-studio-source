import { projectElectronDisplayTopology } from
  "../../src/electron/main/appSnapshotProjection";
import type {
  CoreAppSnapshotRecord,
  DisplayTopologySnapshotRecord
} from "../../src/shared/generated";

export const CAPTURED_AT = "2026-08-30T12:00:00.000Z";
export const ROLE_ID = "11111111-1111-4111-8111-111111111111";
export const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
export const WINDOW_ID = "33333333-3333-4333-8333-333333333333";
export const TAB_ID = "44444444-4444-4444-8444-444444444441";
export const ATTEMPT_ID = "55555555-5555-4555-8555-555555555551";
export const OPERATION_ID = "66666666-6666-4666-8666-666666666661";
export const WORKSPACE_TAB_ID = "44444444-4444-4444-8444-444444444442";
export const WORKSPACE_ATTEMPT_ID = "55555555-5555-4555-8555-555555555552";
export const WORKSPACE_OPERATION_ID = "66666666-6666-4666-8666-666666666662";
export const WEB_SLOT_ID = "workspace-web-slot";
export const WEB_SURFACE_ID = `web-${WORKSPACE_TAB_ID}-1`;
export const RECT = { x: 0, y: 0, width: 1, height: 1 };
export const MANAGED_RECT = { x: 0, y: 0, width: 0.5, height: 1 };
export const WEB_RECT = { x: 0.5, y: 0, width: 0.5, height: 1 };

export function topology(
  revision = 1,
  workArea = { x: 0, y: 0, width: 1440, height: 900 }
): DisplayTopologySnapshotRecord {
  return projectElectronDisplayTopology({
    displays: [{
      id: 41,
      label: "Built-in Display",
      bounds: { x: 0, y: 0, width: 1440, height: 900 },
      workArea,
      size: { width: 2880, height: 1800 },
      scaleFactor: 2,
      internal: true
    }],
    primaryDisplayId: 41,
    revision,
    capturedAt: CAPTURED_AT,
    cause: revision === 1 ? "electron-initial" : "screen-display-metrics-changed"
  });
}

export function dualDisplayTopology(): DisplayTopologySnapshotRecord {
  return projectElectronDisplayTopology({
    displays: [
      {
        id: 41,
        label: "Built-in Display",
        bounds: { x: 0, y: 0, width: 1440, height: 900 },
        workArea: { x: 0, y: 0, width: 1440, height: 900 },
        size: { width: 2880, height: 1800 },
        scaleFactor: 2,
        internal: true
      },
      {
        id: 99,
        label: "External Display",
        bounds: { x: 1440, y: 0, width: 1920, height: 1080 },
        workArea: { x: 1440, y: 24, width: 1920, height: 1056 },
        size: { width: 1920, height: 1080 },
        scaleFactor: 1,
        internal: false
      }
    ],
    primaryDisplayId: 41,
    revision: 2,
    capturedAt: CAPTURED_AT,
    cause: "screen-display-added"
  });
}

export function emptyCoreSnapshot(): CoreAppSnapshotRecord {
  return {
    revision: 1,
    stateRevision: 1,
    runtimeRevision: 0,
    state: {
      revision: 1,
      games: [],
      roles: [{
        id: ROLE_ID,
        gameId: "77777777-7777-4777-8777-777777777777",
        name: "Pilot",
        launchUrl: "https://game.test/play",
        notes: "",
        createdAt: CAPTURED_AT,
        updatedAt: CAPTURED_AT
      }],
      launchWorkspaces: [{
        id: WORKSPACE_ID,
        name: "Web tools",
        template: "single",
        slots: [],
        createdAt: CAPTURED_AT,
        updatedAt: CAPTURED_AT
      }],
      gameWindows: [],
      macros: []
    },
    browserRuntime: { windows: [], roles: [], tabs: [], workspaces: [] },
    logicalWindows: [],
    roleStatuses: [],
    macroStatuses: []
  };
}
