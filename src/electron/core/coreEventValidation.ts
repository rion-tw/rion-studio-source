import { isRoleSessionRecoveryRecord } from "./sessionRecoveryValidation";
import type { CoreEvent } from "../../shared/generated";
import {
  closedValidation as check,
  isClosedBrowserActionRequest,
  isClosedCoreEffectRequest
} from "./coreEffectActionValidation";

const EVENT_TYPES = new Set<CoreEvent["type"]>([
  "roleSessionRecoveryChanged",
  "extensionsChanged",
  "graphicsSettingsChanged",
  "ready",
  "stateChanged",
  "logsChanged",
  "logEntriesCaptured",
  "browserActions",
  "coreEffects",
  "coreEffectCancellations",
  "appKitTopologyCommitted",
  "runtimeTabTopologyCommitted",
  "browserStatuses",
  "browserLaunchCompleted",
  "macroStatuses",
  "overlayChanged",
  "chromeProfileImportProgress",
  "shutdown"
]);

const capabilityStatus = check.oneOf("supported", "degraded", "unsupported", "disabled");
const capabilitySnapshot = (value: unknown): boolean => check.closed(value, {
  navigation: capabilityStatus,
  persistentSession: capabilityStatus,
  trustedInput: capabilityStatus,
  backgroundInput: capabilityStatus,
  frameEvaluation: capabilityStatus,
  popup: capabilityStatus,
  audioMute: capabilityStatus,
  customFonts: capabilityStatus,
  downloads: capabilityStatus,
  fileUpload: capabilityStatus,
  permissions: capabilityStatus,
  dialogs: capabilityStatus,
  certificateHandling: capabilityStatus
});
const browserStatus = (value: unknown): boolean => check.closed(value, {
  roleId: check.identity,
  state: check.oneOf("launching", "running", "stopping"),
  runtimeMode: check.oneOf("embedded")
}, {
  launchedAt: check.text,
  notice: check.text,
  automationState: check.oneOf("ready", "unavailable"),
  overlayState: check.oneOf("ready", "unavailable"),
  pageHealth: check.oneOf("healthy", "unresponsive"),
  resolvedEngine: check.oneOf("webview2", "wkwebview", "chromium"),
  hostKind: check.oneOf("system-native", "appkit-chromium", "bundled-chromium"),
  issueReason: check.oneOf(
    "trusted-input-unavailable",
    "macro-input-unavailable",
    "session-migration-required",
    "runtime-creation-failed",
    "runtime-crashed"
  ),
  capabilitySnapshot
});
const macroLastClick = (value: unknown): boolean => check.closed(value, {
  sequence: check.nonnegativeInteger,
  stepId: check.identity
});
const macroStatus = (value: unknown): boolean => check.closed(value, {
  roleId: check.identity,
  macroId: check.identity,
  state: check.oneOf("running", "recovering", "stopping", "failed", "cancelled"),
  iteration: check.nullable(check.nonnegativeInteger),
  lastClick: check.nullable(macroLastClick),
  startedAt: check.text,
  updatedAt: check.text,
  error: check.nullable(check.text)
});
const logError = (value: unknown): boolean => check.closed(value, {
  name: check.text,
  message: check.text
}, {
  stack: check.text,
  cause: logError
});
const logEntry = (value: unknown): boolean => check.closed(value, {
  id: check.identity,
  timestamp: check.text,
  level: check.oneOf("debug", "info", "warn", "error"),
  source: check.oneOf(
    "main", "preload", "renderer", "ipc", "browser", "extension", "macro",
    "persistence", "update"
  ),
  event: check.text,
  message: check.text,
  sessionId: check.identity
}, {
  buildCommit: check.text,
  applicationVersion: check.text,
  runtimeContractVersion: check.nonnegativeInteger,
  packaged: check.bool,
  context: (context) => typeof context === "object" && context !== null &&
    !Array.isArray(context),
  error: logError
});
const chromeProfileImportProgress = (value: unknown): boolean => check.closed(value, {
  importId: check.identity,
  phase: check.text,
  completed: check.nonnegativeInteger,
  total: check.nonnegativeInteger
}, { profileId: check.identity });

function isClosedCriticalEvent(event: Record<string, unknown>): boolean {
  switch (event.type) {
    case "runtimeTabTopologyCommitted":
      return check.closed(event, { type: check.oneOf("runtimeTabTopologyCommitted"),
        operationId: check.identity, tabId: check.identity, windowId: check.identity,
        windowGeneration: check.nonnegativeInteger, topologyRevision: check.nonnegativeInteger });
    case "appKitTopologyCommitted":
      return check.closed(event, { type: check.oneOf("appKitTopologyCommitted"),
        receipt: value => check.closed(value, {
          eventId: check.identity, adapterSequence: check.nonnegativeInteger,
          status: check.oneOf("applied", "superseded", "failed", "degraded", "indeterminate", "cancelled"),
          topologyCommitted: check.bool, nativeApplied: check.bool,
          windowGeneration: check.nonnegativeInteger,
          topologyRevision: check.nonnegativeInteger
        }, { failureCode: check.text }) });
    case "roleSessionRecoveryChanged":
      return check.closed(event, { type: check.oneOf("roleSessionRecoveryChanged"), record: isRoleSessionRecoveryRecord });
    case "graphicsSettingsChanged":
      return check.closed(event, { type: check.oneOf("graphicsSettingsChanged"), snapshot: (value) => check.closed(value, {
        revision: check.nonnegativeInteger,
        settings: (settings) => check.closed(settings, {
          hardwareAcceleration: check.bool,
          rasterization: check.oneOf("auto", "enabled", "disabled"),
          videoDecode: check.oneOf("auto", "disabled")
        })
      }) });
    case "extensionsChanged":
      return check.closed(event, { type: check.oneOf("extensionsChanged"), snapshot: extensionSnapshot });
    case "ready":
      return check.closed(event, {
        type: check.oneOf("ready"), schemaVersion: check.nonnegativeInteger
      });
    case "stateChanged":
      return check.closed(event, {
        type: check.oneOf("stateChanged"),
        revision: check.nonnegativeInteger,
        changedCollections: check.arrayOf(check.oneOf(
          "games", "roles", "launchWorkspaces", "gameWindows", "macros"
        ))
      });
    case "logsChanged":
      return check.closed(event, { type: check.oneOf("logsChanged") });
    case "logEntriesCaptured":
      return check.closed(event, {
        type: check.oneOf("logEntriesCaptured"),
        entries: check.arrayOf(logEntry)
      });
    case "browserActions":
      return check.closed(event, {
        type: check.oneOf("browserActions"),
        actions: check.arrayOf(isClosedBrowserActionRequest)
      });
    case "coreEffects":
      return check.closed(event, {
        type: check.oneOf("coreEffects"),
        effects: check.arrayOf(isClosedCoreEffectRequest)
      });
    case "coreEffectCancellations":
      return check.closed(event, {
        type: check.oneOf("coreEffectCancellations"),
        cancellations: check.arrayOf((value) => check.closed(value, {
          effectId: check.identity,
          operationId: check.identity,
          reason: check.oneOf("operationCancelled", "deadlineElapsed", "actorStopped")
        }))
      });
    case "browserStatuses":
      return check.closed(event, {
        type: check.oneOf("browserStatuses"),
        statuses: check.arrayOf(browserStatus)
      });
    case "browserLaunchCompleted":
      return check.closed(event, {
        type: check.oneOf("browserLaunchCompleted"),
        operationId: check.identity,
        sourceId: check.identity,
        sourceType: check.oneOf("role", "workspace"),
        tabId: check.identity,
        ok: check.bool
      }, { errorCode: check.text });
    case "macroStatuses":
      return check.closed(event, {
        type: check.oneOf("macroStatuses"),
        reliable: check.bool,
        statuses: check.arrayOf(macroStatus)
      });
    case "overlayChanged":
      return check.closed(event, {
        type: check.oneOf("overlayChanged"),
        roleIds: check.arrayOf(check.identity)
      });
    case "chromeProfileImportProgress":
      return check.closed(event, {
        type: check.oneOf("chromeProfileImportProgress"),
        progress: chromeProfileImportProgress
      });
    case "shutdown":
      return check.closed(event, { type: check.oneOf("shutdown") });
    default:
      return false;
  }
}

export function parseCoreEvents(eventsJson: string): CoreEvent[] {
  let value: unknown;
  try {
    value = JSON.parse(eventsJson);
  } catch {
    throw new Error("The Core event batch is invalid. reason=json-parse");
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`The Core event batch is invalid. reason=${
      Array.isArray(value) ? "empty-batch" : "non-array-batch"
    }`);
  }
  for (const [eventIndex, event] of value.entries()) {
    if (typeof event !== "object" || event === null || Array.isArray(event)) {
      throw invalidCoreEvent(eventIndex, event);
    }
    const record = event as Record<string, unknown>;
    if (
      typeof record.type !== "string" ||
      !EVENT_TYPES.has(record.type as CoreEvent["type"]) ||
      !isClosedCriticalEvent(record)
    ) {
      throw invalidCoreEvent(eventIndex, record);
    }
  }
  const shutdownIndexes = value.flatMap((event, index) =>
    (event as { type: string }).type === "shutdown" ? [index] : []
  );
  if (
    shutdownIndexes.length > 1 ||
    (shutdownIndexes.length === 1 && shutdownIndexes[0] !== value.length - 1)
  ) {
    throw new Error("The Core event batch is invalid. reason=shutdown-order");
  }
  return value as CoreEvent[];
}

function invalidCoreEvent(index: number, value: unknown): Error {
  const record = typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
  const eventType = safeDiscriminator(record?.type);
  const actionType = eventType === "browserActions"
    ? firstInvalidBrowserActionType(record?.actions)
    : undefined;
  return new Error(
    `The Core event batch is invalid. eventIndex=${index} eventType=${eventType}` +
    (actionType ? ` actionType=${actionType}` : "")
  );
}

function firstInvalidBrowserActionType(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const request = value.find((candidate) => !isClosedBrowserActionRequest(candidate)) ?? value[0];
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    return "unknown";
  }
  const action = (request as Record<string, unknown>).action;
  if (typeof action !== "object" || action === null || Array.isArray(action)) {
    return "unknown";
  }
  return safeDiscriminator((action as Record<string, unknown>).type);
}

function safeDiscriminator(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value)
    ? value
    : "unknown";
}

const extensionPackage = (value: unknown): boolean => check.closed(value, {
  id: check.identity, name: check.text, version: check.text, permissions: check.arrayOf(check.text),
  sha256: check.text, directory: check.text, enabledRoleIds: check.arrayOf(check.identity), applyToAllRoles: (v: unknown) => typeof v === "boolean", removed: (v: unknown) => typeof v === "boolean"
}, {
  description: check.text, iconDataUrl: check.text, sizeBytes: check.nonnegativeInteger,
  requiredApiPermissions: check.arrayOf(check.text)
});
const extensionRole = (value: unknown): boolean => check.closed(value, {
  roleId: check.identity, leaseId: check.identity, extensionIds: check.arrayOf(check.identity), status: check.oneOf("loading", "loaded", "degraded", "failed", "indeterminate")
});
const extensionSnapshot = (value: unknown): boolean => check.closed(value, {
  revision: check.nonnegativeInteger, installed: check.arrayOf(extensionPackage), roles: check.arrayOf(extensionRole)
});
