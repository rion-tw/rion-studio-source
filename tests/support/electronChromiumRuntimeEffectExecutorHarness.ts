import type {
  BrowserActionRequest,
  EmbeddedRoleViewEffectRecord,
  EmbeddedTabEffectRecord
} from "../../src/shared/generated";
import { vi } from "vitest";
import {
  ChromiumRuntimeEffectExecutor,
  type ChromiumRuntimeBrowserDataClearPort,
  type ChromiumRuntimeGlobalWebBrowserDataClearPort,
  type ChromiumRuntimeGlobalWebSurfacePort,
  type ChromiumRuntimeSurfacePort
} from "../../src/electron/main/chromiumRuntimeEffectExecutor";
import {
  CHROMIUM_ROLE_BROWSER_DATA_STORAGE_TYPES,
  type ChromiumRoleBrowserDataClearInput,
  type ChromiumRoleBrowserDataClearResult
} from "../../src/electron/main/chromiumRoleBrowserDataClearCoordinator";
import type { CreateChromiumRoleSurfaceInput } from
  "../../src/electron/main/chromiumRoleSurfaceRegistry";
import type { CreateChromiumGlobalWebSurfaceInput } from
  "../../src/electron/main/chromiumGlobalWebSurfaceRegistry";
import {
  effect,
  globalWebProfile,
  rolePaths,
  tab,
  webTab
} from "./electronChromiumRuntimeEffectFixtures";
import { FakeChromiumRuntimeEffectHost as FakeHost } from
  "./electronChromiumRuntimeEffectHostFixture";

export interface Harness {
  readonly executor: ChromiumRuntimeEffectExecutor;
  readonly hosts: FakeHost[];
  readonly createHost: ReturnType<typeof vi.fn>;
  readonly createEmptyHost: ReturnType<typeof vi.fn>;
  readonly createSurface: ReturnType<typeof vi.fn>;
  readonly closeRole: ReturnType<typeof vi.fn>;
  readonly setBounds: ReturnType<typeof vi.fn>;
  readonly audioMuted: ReturnType<typeof vi.fn>;
  readonly isCurrentlyAudible: ReturnType<typeof vi.fn>;
  readonly setAudioMuted: ReturnType<typeof vi.fn>;
  readonly audioStates: Map<string, boolean>;
  readonly setVisible: ReturnType<typeof vi.fn>;
  readonly setZoomFactor: ReturnType<typeof vi.fn>;
  readonly resolvePaths: ReturnType<typeof vi.fn>;
  readonly disposeSurfaces: ReturnType<typeof vi.fn>;
  readonly reparentRole: ReturnType<typeof vi.fn>;
  readonly installOverlays: ReturnType<typeof vi.fn>;
  readonly retireOverlay: ReturnType<typeof vi.fn>;
  readonly clearBrowserData: ReturnType<typeof vi.fn>;
  readonly clearGlobalWebBrowserData: ReturnType<typeof vi.fn>;
  readonly executeChromeProfileImport: ReturnType<typeof vi.fn>;
  readonly copyCoordinate: ReturnType<typeof vi.fn>;
  readonly openMacroPage: ReturnType<typeof vi.fn>;
  readonly createWebSurface: ReturnType<typeof vi.fn>;
  readonly closeWebSurface: ReturnType<typeof vi.fn>;
  readonly setWebBounds: ReturnType<typeof vi.fn>;
  readonly setWebVisible: ReturnType<typeof vi.fn>;
  readonly setWebZoomFactor: ReturnType<typeof vi.fn>;
  readonly setWebAudioMuted: ReturnType<typeof vi.fn>;
  readonly webAudioMuted: ReturnType<typeof vi.fn>;
  readonly isWebCurrentlyAudible: ReturnType<typeof vi.fn>;
  readonly reparentWebSurface: ReturnType<typeof vi.fn>;
  readonly disposeWebSurfaces: ReturnType<typeof vi.fn>;
  readonly trustedExecute: ReturnType<typeof vi.fn>;
  readonly managedRetireSurface: ReturnType<typeof vi.fn>;
  readonly trustedRetireSurface: ReturnType<typeof vi.fn>;
  readonly trustedRetireSurfaceForDestruction: ReturnType<typeof vi.fn>;
  readonly trustedDispose: ReturnType<typeof vi.fn>;
  readonly reconcileRolePlaceholders: ReturnType<typeof vi.fn>;
}

export function harness(
  createSurfaceImplementation: (
    input: CreateChromiumRoleSurfaceInput
  ) => Promise<Readonly<{
    roleId: string;
    generation: number;
    parentId: number;
    url: string;
  }>> = async (input) => ({
    roleId: input.roleId,
    generation: input.generation,
    parentId: input.parent.id,
    url: input.url
  }),
  platform: "macos" | "windows" = "macos"
): Harness {
  const hosts: FakeHost[] = [];
  const audioStates = new Map<string, boolean>();
  const createHost = vi.fn(async (
    target: EmbeddedTabEffectRecord["target"],
    initialTab: EmbeddedTabEffectRecord
  ) => {
    const host = new FakeHost(
      target.windowId,
      hosts.length + 1,
      target,
      undefined,
      true,
      initialTab.appkitWindowGeneration ?? 1,
      initialTab.appkitTopologyRevision ?? 1
    );
    if (platform === "windows") {
      Object.defineProperties(host, {
        appKitIdentity: { value: undefined },
        initializeAppKitTab: { value: undefined },
        applyWindowsChromeProjection: { value: vi.fn(async () => undefined) }
      });
    }
    hosts.push(host);
    return host;
  });
  const createEmptyHost = vi.fn(async (
    target: EmbeddedTabEffectRecord["target"],
    identity: Readonly<{
      attemptGeneration: string;
      windowGeneration: number;
      topologyRevision: number;
    }>
  ) => {
    const host = new FakeHost(
      target.windowId,
      hosts.length + 1,
      target,
      identity.attemptGeneration,
      false,
      identity.windowGeneration,
      identity.topologyRevision
    );
    hosts.push(host);
    return host;
  });
  const createSurface = vi.fn(async (input: CreateChromiumRoleSurfaceInput) => {
    const result = await createSurfaceImplementation(input);
    audioStates.set(`${input.roleId}:${input.generation}`, input.audioMuted);
    return result;
  });
  const closeRole = vi.fn(async () => true);
  const setBounds = vi.fn();
  const audioMuted = vi.fn((roleId: string, generation: number) =>
    audioStates.get(`${roleId}:${generation}`) ?? false
  );
  const isCurrentlyAudible = vi.fn(() => false);
  const setAudioMuted = vi.fn((roleId: string, generation: number, muted: boolean) => {
    audioStates.set(`${roleId}:${generation}`, muted);
  });
  const setVisible = vi.fn();
  const setZoomFactor = vi.fn();
  const reparentRole = vi.fn(async () => undefined);
  const disposeSurfaces = vi.fn(async () => undefined);
  const installOverlays = vi.fn(async () => undefined);
  const retireOverlay = vi.fn();
  const clearBrowserData = vi.fn(async (
    input: ChromiumRoleBrowserDataClearInput
  ): Promise<ChromiumRoleBrowserDataClearResult> => ({
    status: "applied",
    receipt: {
      roleId: input.roleId,
      operationId: input.operationId,
      clearedStorages: CHROMIUM_ROLE_BROWSER_DATA_STORAGE_TYPES,
      cookieReadbackCount: 0,
      evidence: "electron-clear-storage-data-promise-and-cookie-readback"
    }
  }));
  const clearGlobalWebBrowserData = vi.fn(async (input: {
    operationId: string;
    profile: ReturnType<typeof globalWebProfile>;
  }) => ({
    status: "applied" as const,
    receipt: {
      profileKey: "global-web" as const,
      operationId: input.operationId,
      clearedStorages: CHROMIUM_ROLE_BROWSER_DATA_STORAGE_TYPES,
      cookieReadbackCount: 0 as const,
      evidence: "electron-clear-storage-data-promise-and-cookie-readback" as const
    }
  }));
  const copyCoordinate = vi.fn((coordinate) => ({ coordinate }));
  const openMacroPage = vi.fn((roleId: string) => ({ roleId }));
  const surfaces: ChromiumRuntimeSurfacePort = {
    audioMuted,
    isCurrentlyAudible,
    create: createSurface,
    closeRole,
    reparentRole,
    readProjection: vi.fn(() => ({
      bounds: { x: 0, y: 44, width: 500, height: 656 },
      visible: true
    })),
    setBounds,
    setAudioMuted,
    setVisible,
    setZoomFactor,
    dispose: disposeSurfaces
  };
  const webAudioStates = new Map<string, boolean>();
  const createWebSurface = vi.fn(async (
    input: CreateChromiumGlobalWebSurfaceInput
  ) => {
    webAudioStates.set(
      `${input.surfaceId}:${input.generation}`,
      input.audioMuted
    );
    return {
      surfaceId: input.surfaceId,
      slotId: input.slotId,
      generation: input.generation,
      parentId: input.parent.id,
      url: input.url
    };
  });
  const closeWebSurface = vi.fn(async () => true);
  const setWebBounds = vi.fn();
  const setWebVisible = vi.fn();
  const setWebZoomFactor = vi.fn();
  const setWebAudioMuted = vi.fn((
    surfaceId: string,
    generation: number,
    muted: boolean
  ) => {
    webAudioStates.set(`${surfaceId}:${generation}`, muted);
  });
  const webAudioMuted = vi.fn((surfaceId: string, generation: number) =>
    webAudioStates.get(`${surfaceId}:${generation}`) ?? false
  );
  const isWebCurrentlyAudible = vi.fn(() => false);
  const reparentWebSurface = vi.fn(async () => undefined);
  const disposeWebSurfaces = vi.fn(async () => undefined);
  const trustedExecute = vi.fn(async (request: BrowserActionRequest) => ({
    requestId: request.requestId,
    roleId: request.roleId,
    inputEpoch: request.inputEpoch,
    surfaceGeneration: 1,
    status: "applied" as const,
    completedAtMs: request.scheduledAtMs + 1,
    errorCode: null,
    errorMessage: null,
    confirmedInputNeutrality: true
  }));
  const managedRetireSurface = vi.fn(async () => undefined);
  const trustedRetireSurface = vi.fn(async () => true);
  const trustedRetireSurfaceForDestruction = vi.fn(async () => true);
  const trustedDispose = vi.fn(async () => undefined);
  const reconcileRolePlaceholders = vi.fn(async () => undefined);
  const webSurfaces: ChromiumRuntimeGlobalWebSurfacePort = {
    audioMuted: webAudioMuted,
    isCurrentlyAudible: isWebCurrentlyAudible,
    create: createWebSurface,
    closeSurface: closeWebSurface,
    reparentSurface: reparentWebSurface,
    readProjection: vi.fn(() => ({
      bounds: { x: 0, y: 44, width: 1000, height: 656 },
      visible: true
    })),
    setBounds: setWebBounds,
    setAudioMuted: setWebAudioMuted,
    setVisible: setWebVisible,
    setZoomFactor: setWebZoomFactor,
    dispose: disposeWebSurfaces
  };
  const resolvePaths = vi.fn(async (roleId: string) => rolePaths(roleId));
  const executeChromeProfileImport = vi.fn(async () => ({ status: "applied" }));
  const executor = new ChromiumRuntimeEffectExecutor({
    browserDataClear: {
      clear: clearBrowserData as ChromiumRuntimeBrowserDataClearPort["clear"]
    },
    chromeProfileImport: { execute: executeChromeProfileImport },
    globalWebBrowserDataClear: {
      clear: clearGlobalWebBrowserData as
        ChromiumRuntimeGlobalWebBrowserDataClearPort["clear"]
    },
    hosts: {
      create: createHost,
      createEmpty: createEmptyHost
    },
    layout: {
      resolveRoleBounds: async (specification) => roleBounds(specification),
      ...(platform === "windows" ? {
        resolveWorkspaceLayout: async (specification: EmbeddedTabEffectRecord) => ({
          roles: roleBounds(specification),
          contentBounds: { x: 0, y: 44, width: 1000, height: 656 },
          dividers: [], visible: true
        })
      } : {})
    },
    lifecycleEpoch: () => 1,
    managedShortcutRetirement: { retireSurface: managedRetireSurface },
    preloadPath: "/Rion/app/out/preload/role.cjs",
    overlays: {
      install: installOverlays,
      retire: retireOverlay
    },
    onError: vi.fn(),
    rolePaths: { resolve: resolvePaths },
    rolePlaceholders: {
      dispose: vi.fn(async () => undefined),
      readEvidence: vi.fn(() => {
        throw new Error("No placeholder evidence was requested.");
      }),
      reconcile: reconcileRolePlaceholders
    },
    shellEffects: { copyCoordinate, openMacroPage },
    surfaces,
    trustedInput: {
      execute: trustedExecute,
      retireSurface: trustedRetireSurface,
      retireSurfaceForDestruction: trustedRetireSurfaceForDestruction,
      resumeAfterDocumentReplacement: vi.fn(async () => false),
      prepareControlledDocumentReplacement: vi.fn(async () => undefined),
      confirmControlledDocumentReplacementNeutral: vi.fn(async () => true),
      resumeControlledDocumentReplacement: vi.fn(async () => true),
      supersedeControlledDocumentReplacement: vi.fn(() => true),
      dispose: trustedDispose
    },
    webSurfaces
  });
  return {
    executor,
    hosts,
    createHost,
    createEmptyHost,
    createSurface,
    closeRole,
    setBounds,
    audioMuted,
    isCurrentlyAudible,
    setAudioMuted,
    audioStates,
    setVisible,
    setZoomFactor,
    resolvePaths,
    disposeSurfaces,
    reparentRole,
    installOverlays,
    retireOverlay,
    clearBrowserData,
    clearGlobalWebBrowserData,
    executeChromeProfileImport,
    copyCoordinate,
    openMacroPage,
    createWebSurface,
    closeWebSurface,
    setWebBounds,
    setWebVisible,
    setWebZoomFactor,
    setWebAudioMuted,
    webAudioMuted,
    isWebCurrentlyAudible,
    reparentWebSurface,
    disposeWebSurfaces,
    trustedExecute,
    managedRetireSurface,
    trustedRetireSurface,
    trustedRetireSurfaceForDestruction,
    trustedDispose,
    reconcileRolePlaceholders
  };
}

export async function createTab(subject: Harness, specification = tab()): Promise<void> {
  await subject.executor.execute(effect(
    specification.tabId,
    { type: "embeddedCreateTab", tab: specification }
  ));
}
export async function loadRoles(
  subject: Harness,
  specification = tab(),
  engine = "chromium"
): Promise<void> {
  await subject.executor.execute(effect(
    specification.tabId,
    {
      type: "embeddedLoadRoles",
      roles: specification.roles.map((role) => ({
        roleId: role.role.id,
        resolvedEngine: engine as EmbeddedRoleViewEffectRecord["resolvedEngine"],
        url: role.role.launchUrl,
        zoomFactor: role.zoomFactor
      }))
    }
  ));
}
export async function loadWebSurfaces(
  subject: Harness,
  specification = webTab()
): Promise<void> {
  await subject.executor.execute(effect(
    specification.tabId,
    {
      type: "embeddedLoadWebSurfaces",
      tabId: specification.tabId,
      attemptGeneration: specification.attemptGeneration!,
      profile: globalWebProfile(),
      surfaces: specification.roles
        .filter((role) => role.web !== undefined)
        .map((role) => ({
        surfaceId: role.role.id,
        slotId: specification.slots.find(
          (slot) => slot.role.id === role.role.id
        )!.slotId,
        url: role.web!.startUrl,
        zoomFactor: role.zoomFactor,
        resolvedEngine: "chromium"
        }))
    }
  ));
}

function roleBounds(specification: EmbeddedTabEffectRecord) {
  return new Map([
    ...specification.roles.map((role, index) => [
      role.role.id, { x: index * 500, y: 44, width: 500, height: 656 }
    ] as const),
    ...specification.slots.filter(slot => slot.web === undefined).map((slot, index) => [
      slot.role.id, { x: index * 500, y: 44, width: 500, height: 656 }
    ] as const)
  ]);
}
