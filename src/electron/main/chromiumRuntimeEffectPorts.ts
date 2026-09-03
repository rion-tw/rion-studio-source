import type {
  BrowserActionRequest,
  CoreErrorPayload,
  CoreEffectRequest,
  EmbeddedTabEffectRecord,
  MacroCoordinateRecord,
  RolePathsRecord
} from "../../shared/generated";
import type {
  ChromiumGlobalWebBrowserDataClearInput,
  ChromiumGlobalWebBrowserDataClearResult
} from "./chromiumGlobalWebBrowserDataClearCoordinator";
import type {
  ChromiumGlobalWebSurfaceHandle,
  CreateChromiumGlobalWebSurfaceInput
} from "./chromiumGlobalWebSurfaceRegistry";
import type {
  ChromiumRoleBrowserDataClearInput,
  ChromiumRoleBrowserDataClearResult
} from "./chromiumRoleBrowserDataClearCoordinator";
import type { ChromiumRoleSurfaceBounds } from "./chromiumRoleSurfacePorts";
import type {
  ChromiumRoleSurfaceHandle,
  CreateChromiumRoleSurfaceInput
} from "./chromiumRoleSurfaceRegistry";
import type { ChromiumRuntimeHostFactoryPort, ChromiumRuntimeHostPort } from
  "./chromiumRuntimeHostPorts";
import type { ChromiumRuntimeSurfaceProjection } from
  "./chromiumRuntimeProjectionTransaction";
import type { ChromiumNativeTrustedInputReceipt } from
  "./chromiumTrustedInputCoordinator";
import type {
  ChromiumRuntimeRolePlaceholderDescriptor,
  ChromiumRuntimeRolePlaceholderEvidence
} from "./chromiumRuntimeRolePlaceholderRegistry";
import type { ChromiumRuntimePopupZoomPort } from
  "./chromiumRuntimeWindowZoomPorts";
import type { ChromiumRoleReloadCoordinator } from
  "./chromiumRoleReloadCoordinator";
import type { ChromiumTrustedInputDocumentReplacementLease } from
  "./chromiumTrustedInputCoordinator";

export interface ChromiumRuntimeSurfacePort {
  audioMuted: (roleId: string, generation: number) => boolean;
  isCurrentlyAudible: (roleId: string, generation: number) => boolean;
  create: (input: CreateChromiumRoleSurfaceInput) => Promise<ChromiumRoleSurfaceHandle>;
  closeRole: (roleId: string, generation: number) => Promise<boolean>;
  dispose: () => Promise<void>;
  reparentRole?: (
    roleId: string,
    generation: number,
    parent: CreateChromiumRoleSurfaceInput["parent"]
  ) => Promise<void>;
  readProjection: (roleId: string, generation: number) =>
    ChromiumRuntimeSurfaceProjection;
  setBounds: (
    roleId: string,
    generation: number,
    bounds: ChromiumRoleSurfaceBounds
  ) => void;
  setAudioMuted: (roleId: string, generation: number, muted: boolean) => void;
  setVisible: (roleId: string, generation: number, visible: boolean) => void;
  setZoomFactor: (roleId: string, generation: number, zoomFactor: number) => void;
}

export interface ChromiumRuntimeGlobalWebSurfacePort {
  audioMuted: (surfaceId: string, generation: number) => boolean;
  isCurrentlyAudible: (surfaceId: string, generation: number) => boolean;
  create: (input: CreateChromiumGlobalWebSurfaceInput) =>
    Promise<ChromiumGlobalWebSurfaceHandle>;
  closeSurface: (surfaceId: string, generation: number) => Promise<boolean>;
  dispose: () => Promise<void>;
  reparentSurface?: (
    surfaceId: string,
    generation: number,
    parent: CreateChromiumGlobalWebSurfaceInput["parent"]
  ) => Promise<void>;
  readProjection: (surfaceId: string, generation: number) =>
    ChromiumRuntimeSurfaceProjection;
  setBounds: (
    surfaceId: string,
    generation: number,
    bounds: ChromiumRoleSurfaceBounds
  ) => void;
  setAudioMuted: (surfaceId: string, generation: number, muted: boolean) => void;
  setVisible: (surfaceId: string, generation: number, visible: boolean) => void;
  setZoomFactor: (surfaceId: string, generation: number, zoomFactor: number) => void;
}

export interface ChromiumRuntimeResolvedWorkspaceLayout {
  readonly contentBounds: ChromiumRoleSurfaceBounds;
  readonly dividers: readonly Readonly<{
    axis: "horizontal" | "vertical";
    bounds: ChromiumRoleSurfaceBounds;
    index: number;
  }>[];
  readonly roles: ReadonlyMap<string, ChromiumRoleSurfaceBounds>;
  readonly visible: boolean;
}

export interface ChromiumRuntimeLayoutPort {
  resolveRoleBounds: (
    tab: EmbeddedTabEffectRecord,
    host: ChromiumRuntimeHostPort
  ) => Promise<ReadonlyMap<string, ChromiumRoleSurfaceBounds>>;
  resolveWorkspaceLayout?: (
    tab: EmbeddedTabEffectRecord,
    host: ChromiumRuntimeHostPort
  ) => Promise<ChromiumRuntimeResolvedWorkspaceLayout>;
}

export interface ChromiumRuntimeRolePathsPort {
  resolve: (roleId: string) => Promise<RolePathsRecord>;
}

export interface ChromiumRuntimeOverlayPort {
  install: (
    roleIds: readonly string[],
    generationForRole: (roleId: string) => number
  ) => Promise<void>;
  retire: (roleId: string, generation: number) => void;
}

export interface ChromiumRuntimeBrowserDataClearPort {
  clear: (input: ChromiumRoleBrowserDataClearInput, signal?: AbortSignal) =>
    Promise<ChromiumRoleBrowserDataClearResult>;
}

export interface ChromiumRuntimeGlobalWebBrowserDataClearPort {
  clear: (input: ChromiumGlobalWebBrowserDataClearInput) =>
    Promise<ChromiumGlobalWebBrowserDataClearResult>;
}

export interface ChromiumRuntimeChromeProfileImportPort {
  execute: (effect: CoreEffectRequest, signal?: AbortSignal) => Promise<unknown>;
}

export interface ChromiumRuntimeTrustedInputPort {
  execute: (request: BrowserActionRequest) => Promise<ChromiumNativeTrustedInputReceipt>;
  retireSurface: (roleId: string, generation: number) => Promise<boolean>;
  retireSurfaceForDestruction: (
    roleId: string,
    generation: number
  ) => Promise<boolean>;
  resumeAfterDocumentReplacement: (
    roleId: string,
    generation: number
  ) => Promise<boolean>;
  prepareControlledDocumentReplacement: (
    lease: ChromiumTrustedInputDocumentReplacementLease
  ) => Promise<void>;
  confirmControlledDocumentReplacementNeutral: (
    lease: ChromiumTrustedInputDocumentReplacementLease
  ) => Promise<boolean>;
  resumeControlledDocumentReplacement: (
    lease: ChromiumTrustedInputDocumentReplacementLease,
    nextDocumentInstanceId: string
  ) => Promise<boolean>;
  supersedeControlledDocumentReplacement: (
    lease: ChromiumTrustedInputDocumentReplacementLease,
    submitted: boolean
  ) => boolean;
  dispose: () => Promise<void>;
}

export interface ChromiumRuntimeShellEffectsPort {
  copyCoordinate: (coordinate: MacroCoordinateRecord) => unknown;
  openMacroPage: (roleId: string) => unknown;
}

export interface ChromiumRuntimeRolePlaceholderPort {
  dispose: () => Promise<void>;
  readEvidence: (placeholderId: string) => ChromiumRuntimeRolePlaceholderEvidence;
  reconcile: (
    descriptors: readonly ChromiumRuntimeRolePlaceholderDescriptor[]
  ) => Promise<void>;
}

export interface ChromiumRuntimeEffectExecutorInput {
  readonly browserDataClear: ChromiumRuntimeBrowserDataClearPort;
  readonly chromeProfileImport: ChromiumRuntimeChromeProfileImportPort;
  readonly globalWebBrowserDataClear: ChromiumRuntimeGlobalWebBrowserDataClearPort;
  readonly hosts: ChromiumRuntimeHostFactoryPort;
  readonly layout: ChromiumRuntimeLayoutPort;
  readonly lifecycleEpoch: () => number;
  readonly managedShortcutRetirement?: Readonly<{
    retireSurface: (roleId: string, surfaceGeneration: number) => Promise<void>;
  }>;
  readonly overlays?: ChromiumRuntimeOverlayPort;
  /** Exact native-owner commit notification; never establishes Core truth. */
  readonly onNativeProjectionChanged?: () => void;
  readonly onError: (error: CoreErrorPayload) => void;
  readonly preloadPath: string;
  readonly popupZoom?: ChromiumRuntimePopupZoomPort;
  readonly rolePaths: ChromiumRuntimeRolePathsPort;
  readonly rolePlaceholders?: ChromiumRuntimeRolePlaceholderPort;
  readonly roleReload?: Pick<
    ChromiumRoleReloadCoordinator,
    "prepare" | "commit" | "supersede"
  >;
  readonly shellEffects: ChromiumRuntimeShellEffectsPort;
  readonly surfaces: ChromiumRuntimeSurfacePort;
  readonly trustedInput?: ChromiumRuntimeTrustedInputPort;
  readonly webSurfaces: ChromiumRuntimeGlobalWebSurfacePort;
}
