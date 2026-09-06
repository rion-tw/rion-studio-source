import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const phases = Object.freeze([
  "chromium-workspace-web-fullscreen-seed",
  "chromium-workspace-web-fullscreen-restart"
]);

export const chromiumWorkspaceWebFullscreenPhaseDependencies = Object.freeze([
  [
    "chromium-workspace-web-fullscreen-seed",
    ["chromium-entity-persistence-seed", "chromium-entity-persistence-restart"]
  ],
  [
    "chromium-workspace-web-fullscreen-restart",
    [
      "chromium-entity-persistence-seed",
      "chromium-entity-persistence-restart",
      "chromium-workspace-web-fullscreen-seed"
    ]
  ]
]);

export const chromiumWorkspaceWebFullscreenPhaseNamespaces = Object.freeze(
  phases.map((phase) => [phase, "chromium-entity-persistence-lifecycle"])
);

export function isChromiumWorkspaceWebFullscreenPhase(phase) {
  return phases.includes(phase);
}

let seedSqliteEvidence;

const FILE_UPLOAD_FIXTURE_NAME = "rion-e2e.txt";
const FILE_UPLOAD_FIXTURE_SOURCE =
  "Rion Studio Chromium visible file-upload parity fixture.\n";
const IDENTIFIER =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const GLOBAL_WEB_OWNER =
  /^web-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-([1-9][0-9]*)$/u;
const GLOBAL_WEB_SLOT = /^slot-[1-9][0-9]*$/u;
const FAILURE_CODE = /^[A-Z][A-Z0-9_]{0,159}$/u;
const POPUP_ACTIONS = new Set([
  "cancelled", "closeRequested", "failed", "nativeClosed", "nativeReady", "pageReady"
]);
const POPUP_CLOSE_REASONS = new Set([
  "applicationShutdown", "loadFailed", "navigationRejected", "parentRetired", "user"
]);
const POPUP_COMPLETION_SCOPES = new Set([
  "dragCommitted", "inputReady", "lifecycleTransition", "nativeAcknowledgement",
  "nativeDestroyed", "nativeSubmission", "pageFinished", "policyDecision", "runtimeProbe",
  "stateCommit", "topologyCommitted"
]);
const POPUP_PHASES = new Set([
  "admitted", "cancelled", "closed", "closing", "failed", "indeterminate", "nativeReady",
  "ready"
]);
const POPUP_STATUSES = new Set([
  "applied", "cancelled", "degraded", "failed", "indeterminate", "superseded"
]);

function exactKeys(candidate, keys) {
  return candidate !== null && typeof candidate === "object" &&
    !Array.isArray(candidate) && Object.keys(candidate).length === keys.length &&
    keys.every((key) => key in candidate);
}

function requireRuntime(condition, message) {
  if (!condition) {
    throw new Error(`Desktop E2E Workspace Web fullscreen evidence failed: ${message}`);
  }
}

function requireSqlite(condition, message) {
  if (!condition) throw new Error(`Desktop E2E SQLite evidence failed: ${message}`);
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validBounds(bounds, allowNegativeOrigin = false) {
  return exactKeys(bounds, ["height", "width", "x", "y"]) &&
    [bounds.height, bounds.width, bounds.x, bounds.y].every(Number.isSafeInteger) &&
    bounds.height > 0 && bounds.width > 0 &&
    (allowNegativeOrigin || (bounds.x >= 0 && bounds.y >= 0));
}

function validRect(rect) {
  return exactKeys(rect, ["height", "width", "x", "y"]) &&
    [rect.height, rect.width, rect.x, rect.y]
      .every((value) => typeof value === "number" && Number.isFinite(value)) &&
    rect.height > 0 && rect.width > 0 && rect.x >= 0 && rect.y >= 0 &&
    rect.x + rect.width <= 1.000_001 && rect.y + rect.height <= 1.000_001;
}

function expectedWebUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) &&
      url.pathname === "/role/chromium-workspace-web-fullscreen" &&
      url.searchParams.get("mode") === "seed" &&
      url.searchParams.get("marker") ===
        "chromium-workspace-web-fullscreen-marker";
  } catch {
    return false;
  }
}

function validAppKitIdentity(identity, windowId, launchGeneration) {
  return exactKeys(identity, [
    "launchGeneration", "logicalWindowId", "nativeGeneration"
  ]) && identity.launchGeneration === launchGeneration &&
    identity.logicalWindowId === windowId &&
    Number.isSafeInteger(identity.nativeGeneration) && identity.nativeGeneration > 0;
}

function validPopup(popup, platform, hostKind) {
  if (!exactKeys(popup, [
    "appKitIdentity", "bounds", "hostKind", "logicalWindowId", "nativeHostId",
    "openOperationId", "popupId", "presentation", "topologyRevision",
    "visible", "windowGeneration"
  ]) || !validBounds(popup.bounds, true) || popup.hostKind !== hostKind ||
      !Number.isSafeInteger(popup.nativeHostId) || popup.nativeHostId < 1 ||
      typeof popup.openOperationId !== "string" || !IDENTIFIER.test(popup.popupId) ||
      popup.logicalWindowId !== `popup-${popup.popupId}` ||
      popup.presentation !== "normal" || popup.visible !== true ||
      popup.topologyRevision !== 1 || popup.windowGeneration !== 1) {
    return false;
  }
  return platform === "macos"
    ? validAppKitIdentity(
        popup.appKitIdentity,
        popup.logicalWindowId,
        popup.openOperationId
      )
    : popup.appKitIdentity === null;
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

export function validPopupParentRevisionSequence(before, during, after) {
  // A popup has its own topology owner. Its lifecycle must not require a
  // mutation of the parent window; AppKit may also project a newer revision.
  // Exact popup admission and destruction are verified by the lifecycle journal.
  return [before, during, after].every(positiveInteger) &&
    during >= before && after >= during;
}

function boundedString(value, maximum = 512) {
  return typeof value === "string" && value.length > 0 &&
    value.length <= maximum && value.trim() === value;
}

function validPopupParentFence(parent, windowId) {
  if (!exactKeys(parent, [
    "ownerId", "ownerKind", "ownerNativeGeneration", "parentAppkitIdentity",
    "parentAttemptGeneration", "parentNativeHostId", "parentTabId",
    "parentTopologyRevision", "parentWindowGeneration", "parentWindowId",
      "roleOwnerGeneration", "slotId"
  ]) || !["globalWeb", "role"].includes(parent.ownerKind) ||
      !positiveInteger(parent.ownerNativeGeneration) ||
      !IDENTIFIER.test(parent.parentAttemptGeneration) ||
      !positiveInteger(parent.parentNativeHostId) || !IDENTIFIER.test(parent.parentTabId) ||
      !positiveInteger(parent.parentTopologyRevision) ||
      !positiveInteger(parent.parentWindowGeneration) || parent.parentWindowId !== windowId) {
    return false;
  }
  if (parent.ownerKind === "role") {
    if (!IDENTIFIER.test(parent.ownerId) || parent.slotId !== null ||
        !positiveInteger(parent.roleOwnerGeneration)) return false;
  } else {
    const owner = GLOBAL_WEB_OWNER.exec(parent.ownerId);
    if (!owner || owner[1] !== parent.parentTabId ||
        Number(owner[2]) !== parent.ownerNativeGeneration ||
        !GLOBAL_WEB_SLOT.test(parent.slotId) || parent.roleOwnerGeneration !== null) {
      return false;
    }
  }
  return parent.parentAppkitIdentity === null || (
    exactKeys(parent.parentAppkitIdentity, [
      "launchGeneration", "logicalWindowId", "nativeGeneration"
    ]) && IDENTIFIER.test(parent.parentAppkitIdentity.launchGeneration) &&
    parent.parentAppkitIdentity.logicalWindowId === windowId &&
    positiveInteger(parent.parentAppkitIdentity.nativeGeneration)
  );
}

function canonicalPopupParentFence(parent) {
  return {
    ownerId: parent.ownerId,
    ownerKind: parent.ownerKind,
    ownerNativeGeneration: parent.ownerNativeGeneration,
    parentAppkitIdentity: parent.parentAppkitIdentity === null ? null : {
      launchGeneration: parent.parentAppkitIdentity.launchGeneration,
      logicalWindowId: parent.parentAppkitIdentity.logicalWindowId,
      nativeGeneration: parent.parentAppkitIdentity.nativeGeneration
    },
    parentAttemptGeneration: parent.parentAttemptGeneration,
    parentNativeHostId: parent.parentNativeHostId,
    parentTabId: parent.parentTabId,
    parentTopologyRevision: parent.parentTopologyRevision,
    parentWindowGeneration: parent.parentWindowGeneration,
    parentWindowId: parent.parentWindowId,
    roleOwnerGeneration: parent.roleOwnerGeneration,
    slotId: parent.slotId
  };
}

function samePopupParentFence(left, right) {
  return sameValue(canonicalPopupParentFence(left), canonicalPopupParentFence(right));
}

function validPopupLifecycleObservation(observation, windowId, priorSequence) {
  if (!exactKeys(observation, [
    "action", "closeNative", "closeReason", "completionScope", "eventId", "failureCode",
    "lifecycleRevision", "lifecycleTerminal", "openOperationId", "operationId",
    "operationTerminal", "parent", "phase", "popupId", "sequence", "status",
    "terminalReason"
  ]) || !POPUP_ACTIONS.has(observation.action) ||
      typeof observation.closeNative !== "boolean" ||
      !(observation.closeReason === null ||
        POPUP_CLOSE_REASONS.has(observation.closeReason)) ||
      !POPUP_COMPLETION_SCOPES.has(observation.completionScope) ||
      !IDENTIFIER.test(observation.eventId) ||
      !(observation.failureCode === null || FAILURE_CODE.test(observation.failureCode)) ||
      !positiveInteger(observation.lifecycleRevision) ||
      typeof observation.lifecycleTerminal !== "boolean" ||
      !IDENTIFIER.test(observation.openOperationId) ||
      !IDENTIFIER.test(observation.operationId) ||
      typeof observation.operationTerminal !== "boolean" ||
      !validPopupParentFence(observation.parent, windowId) ||
      !POPUP_PHASES.has(observation.phase) || !IDENTIFIER.test(observation.popupId) ||
      !positiveInteger(observation.sequence) || observation.sequence <= priorSequence ||
      !POPUP_STATUSES.has(observation.status) ||
      !(observation.terminalReason === null ||
        boundedString(observation.terminalReason, 160))) {
    return false;
  }
  if (observation.lifecycleTerminal && !observation.operationTerminal) return false;
  if (observation.operationTerminal !== (observation.terminalReason !== null)) return false;
  return observation.action !== "nativeClosed" || !observation.lifecycleTerminal ||
    observation.completionScope === "nativeDestroyed";
}

function validPopupLifecycleJournal(journal) {
  if (!exactKeys(journal, [
    "capacity", "journalVersion", "observations", "windowId"
  ]) || journal.capacity !== 256 || journal.journalVersion !== 1 ||
      !IDENTIFIER.test(journal.windowId) || !Array.isArray(journal.observations) ||
      journal.observations.length > journal.capacity) {
    return false;
  }
  let priorSequence = 0;
  const popupFences = new Map();
  for (const observation of journal.observations) {
    if (!validPopupLifecycleObservation(
      observation,
      journal.windowId,
      priorSequence
    )) return false;
    priorSequence = observation.sequence;
    const fence = JSON.stringify({
      openOperationId: observation.openOperationId,
      parent: observation.parent
    });
    if (popupFences.has(observation.popupId) &&
        popupFences.get(observation.popupId) !== fence) return false;
    popupFences.set(observation.popupId, fence);
  }
  return true;
}

export function validateChromiumWorkspaceWebPopupLifecycleEvidence(
  journal,
  workspace,
  visiblePopup
) {
  requireRuntime(
    validPopupLifecycleJournal(journal),
    "malformed exact Core popup lifecycle journal"
  );
  const expectedParent = {
    ownerId: workspace.web.surfaceId,
    ownerKind: "globalWeb",
    ownerNativeGeneration: workspace.web.generation,
    parentAppkitIdentity: workspace.appKitIdentity,
    parentAttemptGeneration: workspace.attemptGeneration,
    parentNativeHostId: workspace.parentNativeHostId,
    parentTabId: workspace.tabId,
    parentTopologyRevision: workspace.topologyRevision,
    parentWindowGeneration: workspace.windowGeneration,
    parentWindowId: workspace.windowId,
    roleOwnerGeneration: null,
    slotId: workspace.web.slotId
  };
  const grouped = new Map();
  for (const observation of journal.observations) {
    const entries = grouped.get(observation.popupId) ?? [];
    entries.push(observation);
    grouped.set(observation.popupId, entries);
  }
  const visibleOperation = grouped.get(visiblePopup.popupId) ?? [];
  const retiredOperations = [...grouped.values()].filter((entries) =>
    entries.some((entry) => entry.action === "nativeClosed" &&
      entry.closeReason === "parentRetired" && entry.lifecycleTerminal === true)
  );
  const retiredOperation = retiredOperations[0] ?? [];
  const visibleTerminal = visibleOperation.at(-1);
  const nativeReady = retiredOperation[0];
  const closeRequested = retiredOperation[1];
  const nativeClosed = retiredOperation[2];
  const retiredParent = nativeReady?.parent;
  const expectedRetiredParent = retiredParent && {
    ...expectedParent,
    parentTopologyRevision: retiredParent.parentTopologyRevision
  };
  requireRuntime(
    journal.windowId === workspace.windowId &&
      visibleOperation.map((entry) => entry.action).join(",") ===
        "nativeReady,pageReady,closeRequested,nativeClosed" &&
      visibleOperation.every((entry) =>
        samePopupParentFence(entry.parent, expectedParent)) &&
      visibleOperation.every((entry) =>
        entry.openOperationId === visiblePopup.openOperationId) &&
      visibleTerminal?.closeReason === "user" &&
      visibleTerminal?.completionScope === "nativeDestroyed" &&
      visibleTerminal?.lifecycleTerminal === true &&
      visibleTerminal?.operationTerminal === true &&
      visibleTerminal?.terminalReason === "user" && retiredOperations.length === 1 &&
      retiredOperation.map((entry) => entry.action).join(",") ===
        "nativeReady,closeRequested,nativeClosed" &&
      retiredParent?.parentTopologyRevision >= expectedParent.parentTopologyRevision &&
      retiredOperation.every((entry) =>
        samePopupParentFence(entry.parent, expectedRetiredParent)) &&
      nativeReady?.sequence > visibleTerminal?.sequence &&
      nativeReady?.popupId !== visiblePopup.popupId &&
      nativeReady?.operationId === nativeReady?.openOperationId &&
      nativeReady?.completionScope === "nativeAcknowledgement" &&
      nativeReady?.operationTerminal === false &&
      nativeReady?.lifecycleTerminal === false &&
      closeRequested?.openOperationId === nativeReady?.openOperationId &&
      closeRequested?.operationId === nativeReady?.openOperationId &&
      closeRequested?.closeReason === "parentRetired" &&
      closeRequested?.closeNative === true && closeRequested?.phase === "closing" &&
      closeRequested?.operationTerminal === false &&
      closeRequested?.lifecycleTerminal === false &&
      nativeClosed?.popupId === nativeReady?.popupId &&
      nativeClosed?.openOperationId === nativeReady?.openOperationId &&
      nativeClosed?.operationId === nativeReady?.openOperationId &&
      nativeClosed?.closeReason === "parentRetired" &&
      nativeClosed?.completionScope === "nativeDestroyed" &&
      nativeClosed?.failureCode === "CHROMIUM_POPUP_OWNER_RETIRED" &&
      nativeClosed?.phase === "cancelled" && nativeClosed?.status === "cancelled" &&
      nativeClosed?.operationTerminal === true &&
      nativeClosed?.lifecycleTerminal === true &&
      nativeClosed?.terminalReason === "parentRetired",
    "visible popup and parent-retired popup lack exact Core terminal receipts"
  );
  return Object.freeze({
    openOperationId: nativeReady.openOperationId,
    popupId: nativeReady.popupId,
    terminalSequence: nativeClosed.sequence
  });
}

function validWeb(web, webSlot) {
  if (!exactKeys(web, [
    "canGoBack", "canGoForward", "chromeBounds", "chromeShellSession",
    "chromeShellStoragePath", "chromeShellUrl", "chromeVisible", "contentBounds",
    "contentProfilePath", "contentSession", "contentSessionStoragePath",
    "contentUrl", "containedFullscreen", "containedFullscreenRevision",
    "contentVisible", "generation", "isolatedSessions", "slotBounds", "slotId",
    "surfaceId", "tabId", "visible"
  ]) || !validBounds(web.chromeBounds) || !validBounds(web.contentBounds) ||
      !validBounds(web.slotBounds) || web.chromeShellSession !==
        "rion-web-chrome-shell:memory" || web.chromeShellStoragePath !== null ||
      web.contentSession !== "global-web-persistent" ||
      web.contentSessionStoragePath !== web.contentProfilePath ||
      !web.contentProfilePath.replaceAll("\\", "/").toLowerCase()
        .endsWith("/web-profiles/global-web/chromium") ||
      !web.chromeShellUrl.endsWith("/runtime-web-chrome-electron.html") ||
      !expectedWebUrl(web.contentUrl) || web.isolatedSessions !== true ||
      web.visible !== true || web.contentVisible !== true ||
      web.slotId !== webSlot.id || !Number.isSafeInteger(web.generation) ||
      web.generation < 1 || !Number.isSafeInteger(web.containedFullscreenRevision) ||
      web.containedFullscreenRevision < 0 || web.chromeBounds.x !== web.slotBounds.x ||
      web.chromeBounds.y !== web.slotBounds.y ||
      web.chromeBounds.width !== web.slotBounds.width) {
    return false;
  }
  if (web.containedFullscreen) {
    return web.containedFullscreenRevision > 0 && web.chromeVisible === false &&
      web.contentBounds.x === web.slotBounds.x &&
      web.contentBounds.y === web.slotBounds.y &&
      web.contentBounds.width === web.slotBounds.width &&
      web.contentBounds.height === web.slotBounds.height;
  }
  return web.chromeVisible === true &&
    web.contentBounds.x === web.slotBounds.x &&
    web.contentBounds.width === web.slotBounds.width &&
    web.contentBounds.y === web.chromeBounds.y + web.chromeBounds.height &&
    web.contentBounds.height + web.chromeBounds.height === web.slotBounds.height;
}

function validObservation(observation, platform) {
  const hostKind = platform === "macos"
    ? "appkit-chromium"
    : "bundled-chromium";
  if (!exactKeys(observation, [
    "appKitIdentity", "attemptGeneration", "coreSlots", "focused", "hostKind",
    "parentNativeHostId", "phase", "popups", "presentation", "role", "tabId",
    "topologyRevision", "visible", "web", "windowBounds", "windowGeneration",
    "windowId"
  ]) || !Array.isArray(observation.coreSlots) || observation.coreSlots.length !== 2 ||
      !Array.isArray(observation.popups) || observation.hostKind !== hostKind ||
      observation.phase !== "ready" || observation.presentation !== "normal" ||
      observation.visible !== true ||
      !validBounds(observation.windowBounds, true) ||
      !Number.isSafeInteger(observation.parentNativeHostId) ||
      observation.parentNativeHostId < 1 ||
      !Number.isSafeInteger(observation.topologyRevision) ||
      observation.topologyRevision < 1 ||
      !Number.isSafeInteger(observation.windowGeneration) ||
      observation.windowGeneration < 1) {
    return false;
  }
  const webSlots = observation.coreSlots.filter((slot) =>
    exactKeys(slot, ["id", "rect", "roleId", "web"]) && slot.web !== null &&
    validRect(slot.rect) && expectedWebUrl(slot.web?.startUrl)
  );
  const roleSlots = observation.coreSlots.filter((slot) =>
    exactKeys(slot, ["id", "rect", "roleId", "web"]) &&
    typeof slot.roleId === "string" && slot.web === null && validRect(slot.rect)
  );
  if (webSlots.length !== 1 || roleSlots.length !== 1 ||
      !exactKeys(observation.role, ["bounds", "generation", "roleId", "visible"]) ||
      !validBounds(observation.role.bounds) ||
      observation.role.roleId !== roleSlots[0].roleId ||
      !Number.isSafeInteger(observation.role.generation) ||
      observation.role.generation < 1 || observation.role.visible !== true ||
      !validWeb(observation.web, webSlots[0]) ||
      !observation.popups.every((popup) => validPopup(popup, platform, hostKind))) {
    return false;
  }
  return platform === "macos"
    ? validAppKitIdentity(
        observation.appKitIdentity,
        observation.windowId,
        observation.attemptGeneration
      )
    : observation.appKitIdentity === null;
}

function validSecurityPolicyObservation(observation, priorSequence) {
  if (!Number.isSafeInteger(observation?.sequence) ||
      observation.sequence <= priorSequence || typeof observation.origin !== "string") {
    return false;
  }
  if (observation.kind === "permission-request") {
    return exactKeys(observation, [
      "callback", "kind", "origin", "permission", "sequence"
    ]) && observation.callback === false && observation.permission === "geolocation";
  }
  return observation.kind === "will-download" && exactKeys(observation, [
    "defaultPrevented", "kind", "origin", "sequence", "url"
  ]) && observation.defaultPrevented === true && typeof observation.url === "string";
}

function validSecurityPolicyInspection(observation) {
  if (!exactKeys(observation, [
    "contentProfilePath", "generation", "observations", "policyVersion",
    "sessionStoragePath", "surfaceId", "windowId"
  ]) || observation.policyVersion !== 1 ||
      observation.contentProfilePath !== observation.sessionStoragePath ||
      typeof observation.contentProfilePath !== "string" ||
      !Number.isSafeInteger(observation.generation) || observation.generation < 1 ||
      typeof observation.surfaceId !== "string" ||
      typeof observation.windowId !== "string" ||
      !Array.isArray(observation.observations)) {
    return false;
  }
  let priorSequence = 0;
  for (const entry of observation.observations) {
    if (!validSecurityPolicyObservation(entry, priorSequence)) return false;
    priorSequence = entry.sequence;
  }
  return true;
}

function validFileUploadEvidence(evidence, platform, phaseDirectory, fixtureBytes) {
  const expectedPath = resolve(phaseDirectory, FILE_UPLOAD_FIXTURE_NAME);
  const expectedPayload = Buffer.from(FILE_UPLOAD_FIXTURE_SOURCE, "utf8");
  const expectedSha256 = createHash("sha256").update(expectedPayload).digest("hex");
  if (!fixtureBytes.equals(expectedPayload) || !exactKeys(evidence, [
    "dialogOwnership", "fixture", "nativeDialog", "observed", "platform",
    "processId", "selector", "visibleAction"
  ]) || evidence.dialogOwnership !== "exact-application-native-owner" ||
      evidence.platform !== platform || !Number.isSafeInteger(evidence.processId) ||
      evidence.processId < 1 || evidence.selector !== "#file-upload" ||
      evidence.visibleAction !== true || evidence.nativeDialog !== (platform === "macos"
        ? "appkit-open-panel"
        : "windows-common-item-dialog") || !exactKeys(evidence.fixture, [
        "bytes", "fileName", "path", "sha256"
      ]) || !exactKeys(evidence.observed, ["bytes", "fileName", "sha256"])) {
    return false;
  }
  const expected = {
    bytes: expectedPayload.byteLength,
    fileName: FILE_UPLOAD_FIXTURE_NAME,
    sha256: expectedSha256
  };
  return evidence.fixture.path === expectedPath &&
    sameValue({
      bytes: evidence.fixture.bytes,
      fileName: evidence.fixture.fileName,
      sha256: evidence.fixture.sha256
    }, expected) && sameValue(evidence.observed, expected);
}

export async function validateChromiumWorkspaceWebFullscreenRuntimeEvidence({
  phase,
  phaseDirectory,
  platform
}) {
  if (!isChromiumWorkspaceWebFullscreenPhase(phase)) return undefined;
  const uploadFixturePath = resolve(phaseDirectory, FILE_UPLOAD_FIXTURE_NAME);
  const [observations, securityPolicy, fileUpload, popupLifecycle, uploadFixture] =
    await Promise.all([
      readFile(resolve(
        phaseDirectory,
        "electron-workspace-web-fullscreen-observations.json"
      ), "utf8").then(JSON.parse),
      readFile(resolve(
        phaseDirectory,
        "electron-workspace-web-security-policy.json"
      ), "utf8").then(JSON.parse),
      readFile(resolve(
        phaseDirectory,
        "electron-workspace-web-file-upload.json"
      ), "utf8").then(JSON.parse),
      readFile(resolve(
        phaseDirectory,
        "electron-popup-lifecycle-journal.json"
      ), "utf8").then(JSON.parse),
      readFile(uploadFixturePath)
    ]);
  requireRuntime(
    Array.isArray(observations) && observations.length >= 9 &&
      observations.every((observation) => validObservation(observation, platform)),
    `${phase}: malformed Core/native contained-fullscreen observation history`
  );
  const first = observations[0];
  const hostInvariant = observations.every((observation) =>
    observation.windowId === first.windowId &&
    observation.windowGeneration === first.windowGeneration &&
    observation.presentation === first.presentation &&
    sameValue(observation.windowBounds, first.windowBounds) &&
    sameValue(observation.coreSlots, first.coreSlots) &&
    sameValue(observation.role, first.role) &&
    sameValue(observation.web.slotBounds, first.web.slotBounds) &&
    sameValue(observation.web.chromeBounds, first.web.chromeBounds)
  );
  const revisions = observations.map(
    (observation) => observation.web.containedFullscreenRevision
  );
  const contained = observations.filter(
    (observation) => observation.web.containedFullscreen
  );
  const popupObservations = observations.filter(
    (observation) => observation.popups.length === 1
  );
  const firstMainFullscreenIndex = observations.findIndex(
    (observation) => observation.web.containedFullscreen
  );
  const firstPopupIndex = observations.findIndex(
    (observation) => observation.popups.length === 1
  );
  const mainFullscreenObservations = firstMainFullscreenIndex > 0 &&
      firstPopupIndex > firstMainFullscreenIndex
    ? observations.slice(firstMainFullscreenIndex - 1, firstPopupIndex)
    : [];
  const mainTopologyRevision = mainFullscreenObservations[0]?.topologyRevision;
  const popupTopologyRevision = popupObservations[0]?.topologyRevision;
  const last = observations.at(-1);
  const topologyRevisionsAreMonotonic = observations.every(
    (observation, index) => index === 0 ||
      observation.topologyRevision >= observations[index - 1].topologyRevision
  );
  requireRuntime(
    hostInvariant && first.web.containedFullscreen === false && first.popups.length === 0 &&
      topologyRevisionsAreMonotonic && mainFullscreenObservations.length >= 5 &&
      mainFullscreenObservations.every((observation) =>
        observation.topologyRevision === mainTopologyRevision &&
        observation.focused === true && observation.popups.length === 0
      ) && validPopupParentRevisionSequence(
        mainTopologyRevision, popupTopologyRevision, last.topologyRevision
      ) &&
      revisions.every((revision, index) => index === 0 || revision >= revisions[index - 1]) &&
      Math.max(...revisions) >= 4 && contained.length >= 2 &&
      popupObservations.length >= 4 && popupObservations.every((observation) =>
        observation.topologyRevision === popupTopologyRevision &&
        observation.focused === false &&
        sameValue(observation.popups, popupObservations[0].popups)
      ) && last.focused === true && last.popups.length === 0,
    `${phase}: bounded fullscreen changed native host or crossed transient topology fences`
  );
  const popupRetirement = validateChromiumWorkspaceWebPopupLifecycleEvidence(
    popupLifecycle,
    mainFullscreenObservations.at(-1),
    popupObservations[0].popups[0]
  );
  requireRuntime(
    Array.isArray(securityPolicy) && securityPolicy.length >= 3 &&
      securityPolicy.every(validSecurityPolicyInspection),
    `${phase}: malformed exact-Session permission/download deny journal`
  );
  const securityFirst = securityPolicy[0];
  const securityLast = securityPolicy.at(-1);
  const securityInvariant = securityPolicy.every((observation) =>
    observation.contentProfilePath === securityFirst.contentProfilePath &&
    observation.generation === securityFirst.generation &&
    observation.sessionStoragePath === securityFirst.sessionStoragePath &&
    observation.surfaceId === securityFirst.surfaceId &&
    observation.windowId === securityFirst.windowId
  );
  const baselineSequence = securityFirst.observations.at(-1)?.sequence ?? 0;
  const securityAdded = securityLast.observations.filter(
    (observation) => observation.sequence > baselineSequence
  );
  const permissionDenials = securityAdded.filter(
    (observation) => observation.kind === "permission-request"
  );
  const downloadDenials = securityAdded.filter(
    (observation) => observation.kind === "will-download"
  );
  const securityOrigin = new URL(first.web.contentUrl).origin;
  requireRuntime(
    securityInvariant && securityFirst.windowId === first.windowId &&
      securityFirst.surfaceId === first.web.surfaceId &&
      securityFirst.generation === first.web.generation &&
      securityFirst.contentProfilePath === first.web.contentProfilePath &&
      permissionDenials.length === 1 &&
      permissionDenials[0].origin === securityOrigin &&
      permissionDenials[0].permission === "geolocation" &&
      permissionDenials[0].callback === false &&
      downloadDenials.length === 1 && downloadDenials[0].origin === securityOrigin &&
      downloadDenials[0].defaultPrevented === true &&
      downloadDenials[0].url ===
        `${securityOrigin}/download/chromium-workspace-web-fullscreen`,
    `${phase}: visible permission/download actions lack exact deny evidence`
  );
  requireRuntime(
    validFileUploadEvidence(fileUpload, platform, phaseDirectory, uploadFixture),
    `${phase}: visible native file upload lacks exact path/content evidence`
  );
  return {
    appKitRetained: platform !== "macos" || first.appKitIdentity !== null,
    containedTransitions: Math.max(...revisions),
    downloadDenied: true,
    fileUploadSupported: true,
    geolocationDenied: true,
    popupHostKind: popupObservations[0].popups[0].hostKind,
    popupParentRetired: popupRetirement.terminalSequence > 0,
    restartVerified: phase === "chromium-workspace-web-fullscreen-restart",
    windowId: first.windowId
  };
}

export function validateChromiumWorkspaceWebFullscreenSqliteEvidence(
  phase,
  entities,
  settings
) {
  const workspaces = entities.workspaces.filter(
    (workspace) => workspace.name === "Chromium Workspace Web Fullscreen"
  );
  const roles = entities.roles.filter(
    (role) => role.name === "Chromium Entity Role Edited"
  );
  requireSqlite(workspaces.length === 1, `${phase}: exact mixed Workspace is missing`);
  requireSqlite(roles.length === 1, `${phase}: dependency Role is missing`);
  const workspace = workspaces[0];
  const slots = workspace.payload?.slots;
  const webSlots = slots?.filter((slot) => expectedWebUrl(slot.web?.startUrl)) ?? [];
  const roleSlots = slots?.filter((slot) => slot.roleId === roles[0].id) ?? [];
  requireSqlite(
    slots?.length === 2 && webSlots.length === 1 && roleSlots.length === 1 &&
      webSlots[0].web.name === "Chromium Workspace Web fullscreen fixture" &&
      validRect(webSlots[0].rect) && validRect(roleSlots[0].rect),
    `${phase}: configured fullscreen Web App + Role workspace was not durable`
  );
  const cleanExit = settings.find(
    (setting) => setting.key === "runtimeRestoreSession"
  )?.payload?.cleanExit;
  requireSqlite(cleanExit === true, `${phase}: Core/runtime clean-exit snapshot is missing`);
  const evidence = { roleId: roles[0].id, slots, workspaceId: workspace.id };
  if (phase === "chromium-workspace-web-fullscreen-seed") {
    seedSqliteEvidence = evidence;
  } else {
    requireSqlite(
      seedSqliteEvidence !== undefined && sameValue(seedSqliteEvidence, evidence),
      `${phase}: restart changed the exact persisted Workspace identity or layout`
    );
  }
  return {
    cleanExit,
    restartVerified: phase === "chromium-workspace-web-fullscreen-restart",
    workspaceId: workspace.id
  };
}
