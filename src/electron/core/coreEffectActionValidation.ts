import type { CoreEffectRequest } from "../../shared/generated";

type Check = (value: unknown) => boolean;
type Shape = Readonly<Record<string, Check>>;
type ActionType = CoreEffectRequest["action"]["type"];

const text: Check = (value) => typeof value === "string";
const identity: Check = (value) =>
  typeof value === "string" && value.length > 0 && value.length <= 512;
const bool: Check = (value) => typeof value === "boolean";
const finite: Check = (value) => typeof value === "number" && Number.isFinite(value);
const integer: Check = (value) => Number.isSafeInteger(value);
const nonnegativeInteger: Check = (value) =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const positiveInteger: Check = (value) =>
  Number.isSafeInteger(value) && (value as number) > 0;
const nullable = (check: Check): Check => (value) => value === null || check(value);
const arrayOf = (check: Check): Check =>
  (value) => Array.isArray(value) && value.every(check);
const oneOf = (...values: readonly unknown[]): Check =>
  (value) => values.includes(value);

function closed(
  value: unknown,
  required: Shape,
  optional: Shape = {}
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const requiredKeys = Object.keys(required);
  const allowed = new Set([...requiredKeys, ...Object.keys(optional)]);
  return Object.keys(record).every((key) => allowed.has(key)) &&
    requiredKeys.every((key) => Object.hasOwn(record, key) && required[key]!(record[key])) &&
    Object.entries(optional).every(([key, check]) =>
      !Object.hasOwn(record, key) || check(record[key])
    );
}

const engine = oneOf("webview2", "wkwebview", "chromium");
const runtimeTabPhase = oneOf(
  "dormant", "activating", "attaching", "loading", "ready", "degraded", "failed"
);
const layoutBounds: Check = (value) => closed(value, {
  x: finite, y: finite, width: finite, height: finite
});
const normalizedRect: Check = layoutBounds;
const pixelBounds: Check = layoutBounds;
const roleOwner: Check = (value) => closed(value, {
  tabId: identity, slotId: identity, generation: nonnegativeInteger
});
const stateRole: Check = (value) => closed(value, {
  id: identity,
  gameId: identity,
  name: text,
  launchUrl: text,
  notes: text,
  createdAt: text,
  updatedAt: text
}, {
  coverImageDataUrl: text,
  coverImageDominantColor: text
});
const webContent: Check = (value) => closed(value, { name: text, startUrl: text });
const workspaceSlot: Check = (value) => closed(value, {
  id: identity,
  rect: normalizedRect
}, {
  roleId: identity,
  web: webContent,
  browserZoomPercent: finite
});
const appearance: Check = (value) => closed(value, {
  background: oneOf("material", "black"),
  gap: oneOf(1, 2, 4, 6, 8, 12, 16)
});
const launchTarget: Check = (value) => closed(value, {
  windowId: identity,
  displayId: integer,
  scaleFactor: finite,
  workArea: pixelBounds,
  bounds: pixelBounds,
  presentation: oneOf("normal", "maximized", "fullscreen")
}, { persistedName: text });
const roleSlot: Check = (value) => closed(value, {
  slotId: identity,
  role: stateRole,
  rect: normalizedRect,
  zoomFactor: finite,
  zoomMode: oneOf("adaptive", "fixed"),
  state: oneOf("launching", "running", "stopping", "blocked", "available")
}, { web: webContent, owner: roleOwner });
const roleView: Check = (value) => closed(value, {
  role: stateRole,
  resolvedEngine: engine,
  rect: normalizedRect,
  zoomFactor: finite,
  zoomMode: oneOf("adaptive", "fixed")
}, { web: webContent });
const tabEffect: Check = (value) => closed(value, {
  tabId: identity,
  audioMuted: bool,
  sourceId: identity,
  name: text,
  workspaceAppearance: appearance,
  target: launchTarget,
  slots: arrayOf(roleSlot),
  roles: arrayOf(roleView)
}, {
  appkitWindowGeneration: nonnegativeInteger,
  appkitTopologyRevision: nonnegativeInteger,
  attemptGeneration: identity,
  launchPreviewId: identity,
  workspaceId: identity,
  workspaceTemplate: text,
  workspaceSlots: arrayOf(workspaceSlot)
});
const globalWebProfile: Check = (value) => closed(value, {
  profileKey: oneOf("global-web"),
  chromiumUserDataDir: text
});
const roleLoad: Check = (value) => closed(value, {
  roleId: identity, resolvedEngine: engine, url: text, zoomFactor: finite
});
const webSurfaceLoad: Check = (value) => closed(value, {
  surfaceId: identity,
  slotId: identity,
  url: text,
  zoomFactor: finite,
  resolvedEngine: engine
});
const webSurfaceIdentity: Check = (value) => closed(value, {
  surfaceId: identity, slotId: identity
});
const audioMuteRole: Check = (value) => closed(value, {
  roleId: identity, ownerGeneration: nonnegativeInteger
});
const runtimeRole: Check = (value) => closed(value, {
  roleId: identity,
  runtime: oneOf("embedded"),
  owner: roleOwner,
  state: oneOf("launching", "running", "stopping")
}, { launchedAt: text });
const tabPhaseProjection: Check = (value) => closed(value, {
  tabId: identity, phase: runtimeTabPhase
});
const workspaceTabProjection: Check = (value) => closed(value, {
  tabId: identity, workspaceSlots: arrayOf(workspaceSlot)
});
const runtimeWindowProjection: Check = (value) => closed(value, {
  windowId: identity,
  windowGeneration: nonnegativeInteger,
  topologyRevision: nonnegativeInteger,
  tabIds: arrayOf(identity),
  tabPhases: arrayOf(tabPhaseProjection),
  hiddenTabIds: arrayOf(identity)
}, {
  workspaceTabs: arrayOf(workspaceTabProjection),
  activeTabId: identity
});
const appKitIdentity: Check = (value) => closed(value, {
  logicalWindowId: identity,
  launchGeneration: identity,
  nativeGeneration: nonnegativeInteger
});
const appKitTab: Check = (value) => closed(value, {
  tabId: identity,
  name: text,
  phase: runtimeTabPhase,
  tabType: oneOf("role", "workspace", "popup"),
  audioMuted: bool
}, { workspaceTemplate: text });
const appKitRole: Check = (value) => closed(value, {
  roleId: identity,
  tabId: identity,
  ownerGeneration: nonnegativeInteger,
  bounds: layoutBounds
});
const appKitWebSurface: Check = (value) => closed(value, {
  surfaceId: identity,
  slotId: identity,
  tabId: identity,
  attemptGeneration: identity,
  bounds: layoutBounds,
  visible: bool
});
const appKitDivider: Check = (value) => closed(value, {
  tabId: identity,
  attemptGeneration: identity,
  dividerIndex: nonnegativeInteger,
  axis: oneOf("horizontal", "vertical"),
  bounds: layoutBounds,
  visible: bool
});
const appKitWindow: Check = (value) => closed(value, {
  identity: appKitIdentity,
  adapterSequence: nonnegativeInteger,
  windowGeneration: nonnegativeInteger,
  topologyRevision: nonnegativeInteger,
  logicalTabIds: arrayOf(identity),
  hiddenTabIds: arrayOf(identity),
  tabs: arrayOf(appKitTab),
  roles: arrayOf(appKitRole),
  webSurfaces: arrayOf(appKitWebSurface),
  workspaceDividers: arrayOf(appKitDivider),
  windowVisible: bool
}, { activeTabId: identity });
const appKitProjection: Check = (value) => closed(value, {
  eventId: identity, windows: arrayOf(appKitWindow)
});
const reloadFence: Check = (value) => closed(value, {
  roleId: identity,
  ownerGeneration: nonnegativeInteger,
  inputEpoch: nonnegativeInteger
});
const reloadPreparation: Check = (value) => closed(value, {
  roleId: identity,
  ownerGeneration: nonnegativeInteger,
  inputEpoch: nonnegativeInteger,
  surfaceGeneration: nonnegativeInteger,
  documentInstanceId: identity
});
const retirement: Check = (value) => closed(value, {
  cleanupRequestIds: arrayOf(identity),
  documentInstanceId: identity,
  retiredPressIds: arrayOf(identity),
  roleId: identity,
  surfaceGeneration: nonnegativeInteger,
  terminal: oneOf(true)
});
const coordinate: Check = (value) => closed(value, {
  anchor: oneOf(
    "top-left", "top-center", "top-right", "center-left", "center", "center-right",
    "bottom-left", "bottom-center", "bottom-right"
  ),
  appliedPageZoom: finite,
  referenceViewportHeightPx: finite,
  referenceViewportWidthPx: finite,
  xPercent: finite,
  xPx: finite,
  xReferencePx: finite,
  viewportHeightPx: finite,
  viewportWidthPx: finite,
  yPercent: finite,
  yPx: finite,
  yReferencePx: finite
});
const browserAction: Check = (value) => {
  if (closed(value, { type: oneOf("focus") })) return true;
  if (closed(value, {
    type: oneOf("key"),
    phase: oneOf("tap", "hold", "release"),
    key: text,
    code: nullable(text),
    modifiers: arrayOf(oneOf("primary", "ctrl", "alt", "shift", "meta")),
    ownerId: identity,
    suppressOverlayShortcut: bool
  })) return true;
  return closed(value, {
    type: oneOf("click"),
    anchor: nullable(oneOf(
      "top-left", "top-center", "top-right", "center-left", "center", "center-right",
      "bottom-left", "bottom-center", "bottom-right"
    )),
    unit: oneOf("percent", "px", "reference-px"),
    x: finite,
    y: finite,
    button: oneOf("left", "middle", "right")
  });
};
const browserActionRequest: Check = (value) => closed(value, {
  requestId: identity,
  roleId: identity,
  origin: oneOf("macro"),
  inputEpoch: nonnegativeInteger,
  intent: oneOf("normal", "cleanup"),
  scheduledAtMs: finite,
  deadlineMs: positiveInteger,
  action: browserAction
}, {
  surfaceGeneration: nonnegativeInteger,
  documentInstanceId: identity
});

export const isClosedBrowserActionRequest = browserActionRequest;

const chromeJournalPhase = oneOf(
  "prepared", "snapshotted", "applying", "verified", "metadataCommitted",
  "awaitingFreshVerification", "freshVerified", "committing"
);
const chromeBase = {
  transactionId: identity,
  roleId: identity,
  launchUrl: text,
  webview2UserDataDir: text,
  webkitDataStoreIdentifier: text,
  replaceExisting: bool
} satisfies Shape;
const chromeOptional = {
  chromiumUserDataDir: text,
  journalPhase: chromeJournalPhase,
  journalRevision: positiveInteger
} satisfies Shape;

const actionTypes = new Set<ActionType>([
  "globalWebProfileClear",
  "roleBrowserDataClearSession",
  "chromeProfileImportSnapshot",
  "chromeProfileImportApply",
  "chromeProfileImportVerify",
  "chromeProfileImportRollback",
  "chromeProfileImportCommit",
  "embeddedCreateTab",
  "embeddedConfigureRoleSessions",
  "embeddedLoadRoles",
  "embeddedLoadWebSurfaces",
  "embeddedInstallOverlays",
  "embeddedFocusRole",
  "embeddedSetTabAudioMuted",
  "embeddedDestroyRole",
  "embeddedClaimRoleSlot",
  "embeddedDestroyTab",
  "embeddedFollowRoleOwnership",
  "embeddedApplyAppKitProjection",
  "embeddedProvisionWindowForTabMove",
  "embeddedRetireProvisionedWindow",
  "embeddedSetRuntimeWindowVisibility",
  "embeddedSetRuntimeWindowPresentation",
  "embeddedSetRuntimeWindowZoom",
  "embeddedPrepareTabRoleReload",
  "embeddedCommitTabRoleReload",
  "embeddedSupersedeTabRoleReload",
  "overlayOpenMacroPage",
  "overlayCopyCoordinate",
  "browserAction"
]);

function isClosedCoreEffectAction(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const type = (value as Record<string, unknown>).type;
  if (typeof type !== "string" || !actionTypes.has(type as ActionType)) return false;
  return isClosedKnownCoreEffectAction(value, type as ActionType);
}

function isClosedKnownCoreEffectAction(value: unknown, type: ActionType): boolean {
  switch (type) {
    case "globalWebProfileClear":
      return closed(value, { type: oneOf(type), profile: globalWebProfile });
    case "roleBrowserDataClearSession":
      return closed(value, {
        type: oneOf(type), roleId: identity, webview2UserDataDir: text,
        webkitDataStoreIdentifier: text
      });
    case "chromeProfileImportSnapshot":
    case "chromeProfileImportApply":
      return closed(value, { type: oneOf(type), ...chromeBase }, chromeOptional);
    case "chromeProfileImportVerify":
      return closed(value, {
        type: oneOf(type), roleId: identity, webview2UserDataDir: text,
        webkitDataStoreIdentifier: text
      }, {
        transactionId: identity,
        verificationUrl: text,
        authenticatedPath: text,
        loginPath: text,
        ...chromeOptional
      });
    case "chromeProfileImportRollback":
      return closed(value, {
        type: oneOf(type), transactionId: identity, roleId: identity, launchUrl: text,
        webview2UserDataDir: text, webkitDataStoreIdentifier: text
      }, { replaceExisting: bool, ...chromeOptional });
    case "chromeProfileImportCommit":
      return closed(value, { type: oneOf(type), transactionId: identity }, {
        roleId: identity, ...chromeOptional
      });
    case "embeddedCreateTab":
      return closed(value, { type: oneOf(type), tab: tabEffect });
    case "embeddedConfigureRoleSessions":
    case "embeddedInstallOverlays":
      return closed(value, { type: oneOf(type), roleIds: arrayOf(identity) });
    case "embeddedLoadRoles":
      return closed(value, { type: oneOf(type), roles: arrayOf(roleLoad) });
    case "embeddedLoadWebSurfaces":
      return closed(value, {
        type: oneOf(type), tabId: identity, attemptGeneration: identity,
        profile: globalWebProfile, surfaces: arrayOf(webSurfaceLoad)
      });
    case "embeddedFocusRole":
      return closed(value, { type: oneOf(type), roleId: identity }, {
        zoomFactor: nullable(finite)
      });
    case "embeddedSetTabAudioMuted":
      return closed(value, {
        type: oneOf(type), tabId: identity, windowId: identity,
        attemptGeneration: identity, roles: arrayOf(audioMuteRole),
        webSurfaces: arrayOf(webSurfaceIdentity), previousMuted: bool, muted: bool
      });
    case "embeddedDestroyRole":
    case "overlayOpenMacroPage":
      return closed(value, { type: oneOf(type), roleId: identity });
    case "embeddedClaimRoleSlot":
      return closed(value, {
        type: oneOf(type), tabId: identity, slot: roleSlot, role: roleView
      });
    case "embeddedDestroyTab":
      return closed(value, { type: oneOf(type), tabId: identity }, {
        attemptGeneration: identity, nextActiveTabId: nullable(identity)
      });
    case "embeddedFollowRoleOwnership":
      return closed(value, {
        type: oneOf(type), lifecycleEpoch: nonnegativeInteger,
        roles: arrayOf(runtimeRole), revealWindowIds: arrayOf(identity),
        focusWindowIds: arrayOf(identity)
      }, {
        windows: arrayOf(runtimeWindowProjection), target: launchTarget, focusTabId: identity
      });
    case "embeddedApplyAppKitProjection":
      return closed(value, { type: oneOf(type), projection: appKitProjection });
    case "embeddedProvisionWindowForTabMove":
      return closed(value, {
        type: oneOf(type), tabId: identity, sourceWindowId: identity,
        sourceWindowGeneration: nonnegativeInteger, sourceTopologyRevision: nonnegativeInteger,
        target: launchTarget, targetWindowGeneration: nonnegativeInteger,
        targetTopologyRevision: nonnegativeInteger
      });
    case "embeddedRetireProvisionedWindow":
      return closed(value, {
        type: oneOf(type), windowId: identity, windowGeneration: nonnegativeInteger,
        topologyRevision: nonnegativeInteger
      });
    case "embeddedSetRuntimeWindowVisibility":
      return closed(value, {
        type: oneOf(type), lifecycleEpoch: nonnegativeInteger, windowId: identity,
        windowGeneration: nonnegativeInteger, topologyRevision: nonnegativeInteger, visible: bool
      }, { appkitIdentity: appKitIdentity });
    case "embeddedSetRuntimeWindowPresentation":
      return closed(value, {
        type: oneOf(type), windowId: identity, windowGeneration: nonnegativeInteger,
        topologyRevision: nonnegativeInteger,
        presentation: oneOf("normal", "maximized", "fullscreen")
      });
    case "embeddedSetRuntimeWindowZoom":
      return closed(value, {
        type: oneOf(type), windowId: identity, windowGeneration: nonnegativeInteger,
        topologyRevision: nonnegativeInteger, zoomFactor: finite, previousZoomFactor: finite
      });
    case "embeddedPrepareTabRoleReload":
      return closed(value, {
        type: oneOf(type), reloadOperationId: identity, tabId: identity, windowId: identity,
        windowGeneration: nonnegativeInteger, topologyRevision: nonnegativeInteger,
        lifecycleEpoch: nonnegativeInteger, roles: arrayOf(reloadFence)
      });
    case "embeddedCommitTabRoleReload":
      return closed(value, {
        type: oneOf(type), reloadOperationId: identity, tabId: identity, windowId: identity,
        windowGeneration: nonnegativeInteger, topologyRevision: nonnegativeInteger,
        lifecycleEpoch: nonnegativeInteger, roles: arrayOf(reloadPreparation),
        managedShortcutRetirements: arrayOf(retirement)
      });
    case "embeddedSupersedeTabRoleReload":
      return closed(value, {
        type: oneOf(type), reloadOperationId: identity, tabId: identity,
        roleIds: arrayOf(identity), managedShortcutRetirements: arrayOf(retirement),
        reason: oneOf(
          "replacementReload", "tabStop", "tabMove", "tabHide", "windowClose",
          "applicationLifecycle", "surfaceRecovery", "coreCancelled", "coreCleanup"
        )
      });
    case "overlayCopyCoordinate":
      return closed(value, { type: oneOf(type), coordinate });
    case "browserAction":
      return closed(value, { type: oneOf(type), request: browserActionRequest });
    default:
      return unreachable(type);
  }
}

function unreachable(value: never): false {
  void value;
  return false;
}

export function isClosedCoreEffectRequest(value: unknown): value is CoreEffectRequest {
  if (!closed(value, {
    effectId: identity,
    operationId: identity,
    target: (target) => closed(target, {
      kind: oneOf("app", "webContents"), handleId: identity
    }),
    completionPolicy: oneOf("deadlineBound", "eventBound"),
    action: isClosedCoreEffectAction
  }, {
    parentOperationId: identity,
    deadlineMs: positiveInteger
  })) return false;
  return value.completionPolicy === "eventBound"
    ? value.deadlineMs === undefined
    : positiveInteger(value.deadlineMs);
}

export const closedValidation = Object.freeze({
  arrayOf,
  bool,
  closed,
  finite,
  identity,
  integer,
  nonnegativeInteger,
  nullable,
  oneOf,
  text
});
