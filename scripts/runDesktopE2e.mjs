import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, copyFile, mkdir, readFile, watch, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { observeElectronPhaseShutdown } from "./desktopE2eElectronShutdown.mjs";
import { resolveDesktopE2eFocusedPhases } from "./desktopE2eFocusedPhases.mjs";

import {
  aggregateDesktopE2eJourneyVerdicts,
  resolveDesktopE2eProfile
} from "./desktopE2eManifest.mjs";
import {
  acceptedDesktopE2eForcedTermination,
  desktopE2eForcedTerminationEnvironment,
  isExpectedDesktopE2eForcedTermination
} from "./desktopE2eForcedTermination.mjs";
import { validateChromiumGameCrudSqliteEvidence } from "./desktopE2eChromiumGameCrudEvidence.mjs";
import { validateChromiumEntityPersistenceSqliteEvidence } from "./desktopE2eChromiumEntityPersistenceEvidence.mjs";
import {
  chromiumJourneyPhaseDependencies,
  chromiumJourneyPhaseNamespaces,
  validateChromiumJourneyRuntimeEvidence,
  validateChromiumJourneySqliteEvidence
} from "./desktopE2eChromiumJourneyEvidence.mjs";
import { validateChromiumQuickAccessSqliteEvidence } from "./desktopE2eChromiumQuickAccessEvidence.mjs";
import { withChromiumMacroCutoverNativePrerequisites } from "./desktopE2eChromiumMacroCutoverEvidence.mjs";
import { resolveDesktopE2eProfileName, resolveDesktopE2eRuntimeTarget } from "./desktopE2eRuntimeTarget.mjs";
import { verifyDesktopE2eBuild } from "./verifyDesktopE2eBuild.mjs";

const root = resolve(import.meta.dirname, "..");
const runId = new Date().toISOString().replaceAll(/[:.]/gu, "-");
const artifactRoot = resolve(
  process.env.RION_STUDIO_E2E_ARTIFACT_ROOT ?? resolve(root, ".desktop-e2e-artifacts"),
  `${runId}-${process.platform}`
);
const token = randomBytes(32).toString("hex");
const node = process.execPath;
const wdio = resolve(root, "node_modules", "@wdio", "cli", "bin", "wdio.js");
const profileArgument = process.argv.find((argument) => argument.startsWith("--profile="))?.slice(10);
const profile = resolveDesktopE2eProfileName({
  platform: process.platform,
  profileName: profileArgument ?? process.env.RION_STUDIO_E2E_PROFILE ?? "full"
});
const coverageManifest = JSON.parse(await readFile(resolve(root, "docs/e2e-coverage.json"), "utf8"));
let configuredPhases;
try {
  configuredPhases = resolveDesktopE2eProfile(coverageManifest, profile).phases;
} catch {
  throw new Error(`Unknown desktop E2E profile: ${profile}. Expected smoke, full, or extended.`);
}
const executionPlan = resolveDesktopE2eRuntimeTarget({
  architecture: process.arch,
  manifest: coverageManifest,
  platform: process.platform,
  profileName: profile,
  repositoryRoot: root
});
const binary = executionPlan.applicationPath;
const phaseArgument = process.argv.find((argument) => argument.startsWith("--phase="))?.slice(8);
if (phaseArgument && !configuredPhases.includes(phaseArgument)) {
  throw new Error(`Desktop E2E phase ${phaseArgument} is not part of profile ${profile}.`);
}
const chromiumAppCrudFocusedDependencies = [
  "chromium-entity-persistence-seed",
  "chromium-entity-persistence-restart",
  "chromium-workspace-web-slot-seed",
  "chromium-workspace-web-slot-restart",
  "chromium-workspace-web-fullscreen-seed",
  "chromium-workspace-web-fullscreen-restart",
  "chromium-fullscreen-toolbar-seed",
  "chromium-fullscreen-toolbar-restart",
  "chromium-quick-access-seed",
  "chromium-quick-access-restart",
  "chromium-settings-persistence-seed",
  "chromium-settings-persistence-restart",
  "chromium-macro-ui-seed",
  "chromium-macro-ui-restart",
  "chromium-macro-native-effect"
];
const focusedPhaseDependencies = new Map([
  ["chromium-graphics-settings-restart", ["chromium-graphics-settings-seed"]],
  [
    "chromium-app-crud-mutations",
    chromiumAppCrudFocusedDependencies
  ],
  [
    "chromium-app-crud-cleanup",
    [
      ...chromiumAppCrudFocusedDependencies,
      "chromium-app-crud-mutations"
    ]
  ],
  [
    "chromium-app-crud-final-restart",
    [
      ...chromiumAppCrudFocusedDependencies,
      "chromium-app-crud-mutations",
      "chromium-app-crud-cleanup"
    ]
  ],
  ["chromium-game-crud-restart", ["chromium-game-crud-seed"]],
  ["chromium-game-window-ui-restart", ["chromium-game-window-ui-seed"]],
  ...chromiumJourneyPhaseDependencies,
  ["chromium-entity-persistence-restart", ["chromium-entity-persistence-seed"]],
  [
    "chromium-quick-access-seed",
    ["chromium-entity-persistence-seed", "chromium-entity-persistence-restart"]
  ],
  [
    "chromium-quick-access-restart",
    [
      "chromium-entity-persistence-seed",
      "chromium-entity-persistence-restart",
      "chromium-quick-access-seed"
    ]
  ],
  ["chromium-quit-guard-restart", ["chromium-quit-guard-seed"]],
  ["chromium-role-session-isolation-restart", ["chromium-role-session-isolation-seed"]],
  ["chromium-role-session-reset-restart", ["chromium-role-session-reset-seed"]],
  ["chromium-chrome-profile-import-restart", ["chromium-chrome-profile-import-seed"]]
]);
focusedPhaseDependencies.set("chromium-extensions-restart", ["chromium-extensions-seed"]);
const phases = withChromiumMacroCutoverNativePrerequisites({
  platform: process.platform,
  selectedPhases: phaseArgument
    ? resolveDesktopE2eFocusedPhases({
        configuredPhases, dependencies: focusedPhaseDependencies, phase: phaseArgument
      })
    : configuredPhases
});
const phaseNamespaces = new Map([
  ["chromium-graphics-settings-seed", "chromium-graphics-settings-lifecycle"],
  ["chromium-graphics-settings-restart", "chromium-graphics-settings-lifecycle"],
  ["chromium-app-crud-mutations", "chromium-entity-persistence-lifecycle"],
  ["chromium-app-crud-cleanup", "chromium-entity-persistence-lifecycle"],
  ["chromium-app-crud-final-restart", "chromium-entity-persistence-lifecycle"],
  ["chromium-game-crud-seed", "chromium-game-crud-lifecycle"],
  ["chromium-game-crud-restart", "chromium-game-crud-lifecycle"],
  ["chromium-game-window-ui-seed", "chromium-game-window-ui-lifecycle"],
  ["chromium-game-window-ui-restart", "chromium-game-window-ui-lifecycle"],
  ...chromiumJourneyPhaseNamespaces,
  ["chromium-entity-persistence-seed", "chromium-entity-persistence-lifecycle"],
  ["chromium-entity-persistence-restart", "chromium-entity-persistence-lifecycle"],
  ["chromium-quick-access-seed", "chromium-entity-persistence-lifecycle"],
  ["chromium-quick-access-restart", "chromium-entity-persistence-lifecycle"],
  ["chromium-quit-guard-seed", "chromium-quit-guard-lifecycle"],
  ["chromium-quit-guard-restart", "chromium-quit-guard-lifecycle"],
  ["chromium-role-session-isolation-seed", "chromium-role-session-isolation-lifecycle"],
  ["chromium-role-session-isolation-restart", "chromium-role-session-isolation-lifecycle"],
  ["chromium-role-session-reset-seed", "chromium-role-session-reset-lifecycle"],
  ["chromium-role-session-reset-restart", "chromium-role-session-reset-lifecycle"],
  ["chromium-chrome-profile-import-seed", "chromium-chrome-profile-import-lifecycle"],
  ["chromium-chrome-profile-import-restart", "chromium-chrome-profile-import-lifecycle"]
]);
phaseNamespaces.set("chromium-extensions-seed", "chromium-extensions");
phaseNamespaces.set("chromium-extensions-restart", "chromium-extensions");

function userDataDirForPhase(phase) {
  const namespace = phaseNamespaces.get(phase) ?? phase;
  return resolve(artifactRoot, "user-data", namespace);
}
const checkoutCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8"
}).trim();
const worktreeDirty = execFileSync("git", ["status", "--porcelain"], {
  cwd: root,
  encoding: "utf8"
}).trim().length > 0;
const requestedCommit = process.env.RION_STUDIO_E2E_COMMIT;
let chromiumExplicitResetEvidence;
const chromiumRoleRuntimeEvidenceByFlow = new Map();

await mkdir(resolve(artifactRoot, "phases"), { recursive: true });

async function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...options.env },
    stdio: options.logPath ? ["ignore", "pipe", "pipe"] : "inherit"
  });
  let output = "";
  const stream = options.logPath ? createWriteStream(options.logPath) : undefined;
  for (const source of [child.stdout, child.stderr]) {
    source?.on("data", (chunk) => {
      const text = chunk.toString();
      output += text;
      stream?.write(text);
      process.stdout.write(text);
    });
  }
  const code = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => {
      if (signal) reject(new Error(`${command} ended with signal ${signal}`));
      else resolveExit(exitCode ?? 1);
    });
  });
  if (stream) await new Promise((resolveEnd) => stream.end(resolveEnd));
  return { code, output };
}

async function startFixture() {
  const child = spawn(node, [resolve(root, "scripts/runtimeAuthorityFixtureServer.mjs"), "--port=0"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const log = createWriteStream(resolve(artifactRoot, "fixture.log"));
  child.stderr.pipe(log, { end: false });
  const origin = await new Promise((resolveOrigin, reject) => {
    let pending = "";
    const deadline = setTimeout(() => reject(new Error("Runtime fixture did not report its origin")), 15_000);
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      log.write(text);
      pending += text;
      const match = pending.match(/runtime-authority-fixture (http:\/\/127\.0\.0\.1:\d+)/u);
      if (!match) return;
      clearTimeout(deadline);
      resolveOrigin(match[1]);
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`Runtime fixture exited early (${code})`)));
  });
  return {
    child,
    close: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await new Promise((resolveExit) => child.once("exit", resolveExit));
      }
      await new Promise((resolveEnd) => log.end(resolveEnd));
    },
    origin
  };
}

async function copyIfPresent(source, destination) {
  try {
    await access(source);
    await copyFile(source, destination);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function requireEvidence(condition, message) {
  if (!condition) throw new Error(`Desktop E2E SQLite evidence failed: ${message}`);
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requireRuntimeEvidence(condition, message) {
  if (!condition) throw new Error(`Desktop E2E native runtime evidence failed: ${message}`);
}

function hasExactKeys(candidate, keys) {
  return candidate !== null
    && typeof candidate === "object"
    && !Array.isArray(candidate)
    && Object.keys(candidate).length === keys.length
    && keys.every((key) => key in candidate);
}

async function validateChromiumRoleRuntimeEvidence(phase, phaseDir) {
  const flow = phase.startsWith("chromium-entity-persistence-")
    ? "entity-persistence"
    : phase === "chromium-macro-native-effect"
      ? "entity-persistence"
      : phase.startsWith("chromium-macro-ui-")
        ? "macro-ui"
        : phase.startsWith("chromium-role-session-reset-")
          ? "explicit-reset"
          : undefined;
  if (!flow) return undefined;
  const observations = JSON.parse(await readFile(
    resolve(phaseDir, "electron-role-session-runtime-observations.json"),
    "utf8"
  ));
  requireRuntimeEvidence(
    Array.isArray(observations) && observations.length === 1,
    `${phase}: expected exactly one observed Role Session/runtime owner`
  );
  const observation = observations[0];
  requireRuntimeEvidence(hasExactKeys(observation, [
    "currentRuntime",
    "latestSessionEnsure",
    "roleId"
  ]), `${phase}: Role runtime observation has unexpected fields`);
  const session = observation.latestSessionEnsure;
  const runtime = observation.currentRuntime;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
  const sha256 = /^[a-f0-9]{64}$/u;
  requireRuntimeEvidence(uuid.test(observation.roleId), `${phase}: invalid Role identity`);
  requireRuntimeEvidence(hasExactKeys(session, [
    "chromiumPathSha256",
    "chromiumUserDataDir",
    "ensureCount",
    "nativeSessionInstance",
    "sessionStoragePath",
    "sessionStoragePathSha256"
  ]), `${phase}: Session ownership evidence has unexpected fields`);
  requireRuntimeEvidence(
    typeof session.chromiumUserDataDir === "string"
      && session.chromiumUserDataDir.includes(observation.roleId)
      && session.sessionStoragePath === session.chromiumUserDataDir
      && sha256.test(session.chromiumPathSha256)
      && session.sessionStoragePathSha256 === session.chromiumPathSha256
      && Number.isSafeInteger(session.ensureCount)
      && session.ensureCount > 0
      && Number.isSafeInteger(session.nativeSessionInstance)
      && session.nativeSessionInstance > 0,
    `${phase}: Chromium Session is not bound to the exact Rust-owned persistent path`
  );
  requireRuntimeEvidence(hasExactKeys(runtime, [
    "appKitIdentity",
    "attemptGeneration",
    "focused",
    "generation",
    "hostKind",
    "ownerGeneration",
    "parentNativeHostId",
    "tabId",
    "topologyRevision",
    "visible",
    "windowGeneration",
    "windowId"
  ]), `${phase}: current native runtime evidence is missing or has unexpected fields`);
  const expectedHostKind = executionPlan.platform === "macos"
    ? "appkit-chromium"
    : "bundled-chromium";
  requireRuntimeEvidence(
    uuid.test(runtime.tabId)
      && uuid.test(runtime.windowId)
      && uuid.test(runtime.attemptGeneration)
      && runtime.hostKind === expectedHostKind
      && typeof runtime.focused === "boolean"
      && runtime.visible === true
      && Number.isSafeInteger(runtime.generation)
      && runtime.generation > 0
      && Number.isSafeInteger(runtime.ownerGeneration)
      && runtime.ownerGeneration > 0
      && Number.isSafeInteger(runtime.parentNativeHostId)
      && runtime.parentNativeHostId > 0
      && Number.isSafeInteger(runtime.windowGeneration)
      && runtime.windowGeneration > 0
      && Number.isSafeInteger(runtime.topologyRevision)
      && runtime.topologyRevision > 0,
    `${phase}: native Role/window/tab ownership is not positive, visible, and self-consistent`
  );
  if (executionPlan.platform === "macos") {
    requireRuntimeEvidence(hasExactKeys(runtime.appKitIdentity, [
      "launchGeneration",
      "logicalWindowId",
      "nativeGeneration"
    ]), `${phase}: AppKit host identity is missing or has unexpected fields`);
    requireRuntimeEvidence(
      runtime.appKitIdentity.logicalWindowId === runtime.windowId
        && runtime.appKitIdentity.launchGeneration === runtime.attemptGeneration
        && Number.isSafeInteger(runtime.appKitIdentity.nativeGeneration)
        && runtime.appKitIdentity.nativeGeneration > 0,
      `${phase}: AppKit logical/native launch generations do not match the admitted Role tab`
    );
  } else {
    requireRuntimeEvidence(
      runtime.appKitIdentity === null,
      `${phase}: Windows Chromium runtime unexpectedly reported an AppKit identity`
    );
  }

  const evidence = {
    appKitIdentity: runtime.appKitIdentity,
    attemptGeneration: runtime.attemptGeneration,
    chromiumPathSha256: session.chromiumPathSha256,
    ensureCount: session.ensureCount,
    hostKind: runtime.hostKind,
    nativeSessionInstance: session.nativeSessionInstance,
    ownerGeneration: runtime.ownerGeneration,
    parentNativeHostId: runtime.parentNativeHostId,
    roleId: observation.roleId,
    sessionStoragePathSha256: session.sessionStoragePathSha256,
    tabId: runtime.tabId,
    topologyRevision: runtime.topologyRevision,
    visible: runtime.visible,
    windowGeneration: runtime.windowGeneration,
    windowId: runtime.windowId
  };
  if (phase.endsWith("-seed")) {
    requireRuntimeEvidence(
      !chromiumRoleRuntimeEvidenceByFlow.has(flow),
      `${phase}: duplicate seed native runtime evidence`
    );
    chromiumRoleRuntimeEvidenceByFlow.set(flow, {
      ...evidence,
      chromiumUserDataDir: session.chromiumUserDataDir,
      sessionStoragePath: session.sessionStoragePath
    });
  } else {
    const seed = chromiumRoleRuntimeEvidenceByFlow.get(flow);
    requireRuntimeEvidence(seed !== undefined, `${phase}: seed runtime evidence is missing`);
    requireRuntimeEvidence(
      observation.roleId === seed.roleId
        && session.chromiumUserDataDir === seed.chromiumUserDataDir
        && session.chromiumPathSha256 === seed.chromiumPathSha256
        && session.sessionStoragePath === seed.sessionStoragePath
        && session.sessionStoragePathSha256 === seed.sessionStoragePathSha256,
      `${phase}: restart changed the Rust-owned Role or Chromium Session path identity`
    );
    requireRuntimeEvidence(
      runtime.attemptGeneration !== seed.attemptGeneration,
      `${phase}: restart reused the prior native launch attempt generation`
    );
  }
  return evidence;
}

function validateChromiumAppCrudMutationSqliteEvidence(phase, entities) {
  const roleOrder = [
    "Chromium P1 Role Edited Copy",
    "Chromium P1 Role Edited",
    "Chromium P1 Recovery Role"
  ];
  const workspaceOrder = [
    "Chromium P1 Workspace Edited Copy",
    "Chromium P1 Workspace Edited",
    "Chromium P1 Recovery Workspace"
  ];
  const expectedNames = {
    games: [
      "Chromium Entity Game",
      "Chromium P1 Unused Game",
      "Chromium P1 Recovery Game"
    ],
    macros: ["Chromium P1 Macro Edited", "Chromium P1 Macro Edited Copy"],
    roles: roleOrder,
    workspaces: workspaceOrder
  };
  const resolved = {};
  for (const [entityType, names] of Object.entries(expectedNames)) {
    resolved[entityType] = Object.fromEntries(names.map((name) => {
      const matches = entities[entityType].filter((entity) => entity.name === name);
      requireEvidence(
        matches.length === 1,
        `${phase}: expected exactly one persisted Chromium app CRUD ${entityType} ${name}`
      );
      return [name, matches[0]];
    }));
  }
  requireEvidence(
    sameValue(
      entities.roles.filter((role) => roleOrder.includes(role.name)).map((role) => role.name),
      roleOrder
    ),
    `${phase}: persisted Role ordinal does not match the visible pointer reorder`
  );
  requireEvidence(
    sameValue(
      entities.workspaces
        .filter((workspace) => workspaceOrder.includes(workspace.name))
        .map((workspace) => workspace.name),
      workspaceOrder
    ),
    `${phase}: persisted Workspace ordinal does not match the visible pointer reorder`
  );
  for (const oldName of [
    "Chromium Entity Role Edited",
    "Chromium Entity Workspace Edited",
    "Chromium Entity Macro Edited"
  ]) {
    requireEvidence(
      !Object.values(entities).some((values) =>
        values.some((entity) => entity.name === oldName)
      ),
      `${phase}: edit journey retained old entity name ${oldName}`
    );
  }

  const primaryGame = resolved.games["Chromium Entity Game"];
  const recoveryGame = resolved.games["Chromium P1 Recovery Game"];
  const editedRole = resolved.roles["Chromium P1 Role Edited"];
  const copiedRole = resolved.roles["Chromium P1 Role Edited Copy"];
  const recoveryRole = resolved.roles["Chromium P1 Recovery Role"];
  const editedWorkspace = resolved.workspaces["Chromium P1 Workspace Edited"];
  const copiedWorkspace = resolved.workspaces["Chromium P1 Workspace Edited Copy"];
  const recoveryWorkspace = resolved.workspaces["Chromium P1 Recovery Workspace"];
  const editedMacro = resolved.macros["Chromium P1 Macro Edited"];
  const copiedMacro = resolved.macros["Chromium P1 Macro Edited Copy"];
  const workspaceDefinition = (workspace) => ({
    slots: workspace.payload?.slots?.map((slot) => ({
      browserZoomPercent: slot.browserZoomPercent,
      rect: slot.rect,
      roleId: slot.roleId,
      web: slot.web
    })),
    template: workspace.payload?.template
  });
  requireEvidence(
    editedRole.payload?.gameId === primaryGame.id
      && copiedRole.payload?.gameId === primaryGame.id
      && recoveryRole.payload?.gameId === recoveryGame.id,
    `${phase}: Role duplication or recovery lost its exact Game dependency`
  );
  requireEvidence(
    typeof copiedWorkspace.payload?.template === "string"
      && Array.isArray(copiedWorkspace.payload?.slots)
      && typeof editedWorkspace.payload?.template === "string"
      && Array.isArray(editedWorkspace.payload?.slots)
      && sameValue(workspaceDefinition(copiedWorkspace), workspaceDefinition(editedWorkspace)),
    `${phase}: Workspace duplication did not retain the edited definition`
  );
  requireEvidence(
    recoveryWorkspace.payload?.template === "two_columns"
      && sameValue(
        recoveryWorkspace.payload?.slots
          ?.filter((slot) => slot.roleId)
          .map((slot) => slot.roleId),
        [editedRole.id, recoveryRole.id]
      ),
    `${phase}: visible Workspace layout selection lost its exact two-Role topology`
  );
  requireEvidence(
    editedMacro.payload?.roleIds?.includes(editedRole.id)
      && sameValue(copiedMacro.payload?.roleIds, editedMacro.payload?.roleIds),
    `${phase}: Macro edit or duplicate lost its exact Role dependency`
  );
  return {
    duplicatedDefinitionsPersisted: true,
    roleOrder,
    twoColumnWorkspacePersisted: true,
    workspaceOrder
  };
}

function validateChromiumAppCrudCleanupSqliteEvidence(phase, entities) {
  const deletedNames = {
    games: [
      "Chromium Entity Game",
      "Chromium P1 Unused Game",
      "Chromium P1 Recovery Game"
    ],
    macros: [
      "Chromium Entity Macro Edited",
      "Chromium P1 Macro Edited",
      "Chromium P1 Macro Edited Copy"
    ],
    roles: [
      "Chromium Entity Role Edited",
      "Chromium P1 Role Edited",
      "Chromium P1 Role Edited Copy",
      "Chromium P1 Recovery Role"
    ],
    workspaces: [
      "Chromium Entity Workspace Edited",
      "Chromium P1 Workspace Edited",
      "Chromium P1 Workspace Edited Copy",
      "Chromium P1 Recovery Workspace"
    ]
  };
  for (const [collection, names] of Object.entries(deletedNames)) {
    requireEvidence(
      !entities[collection].some((entity) => names.includes(entity.name)),
      `${phase}: Chromium app CRUD cleanup retained an owned ${collection} entity`
    );
  }
  return {
    builtinGameCount: entities.games.length,
    cleanupComplete: true,
    finalRestartVerified: phase === "chromium-app-crud-final-restart"
  };
}

function validateChromiumSystemSettingsSqliteEvidence(phase, settings) {
  const browserSettings = settings.find(
    (setting) => setting.key === "gameBrowserSettings"
  )?.payload;
  requireEvidence(
    browserSettings !== undefined && !Object.hasOwn(browserSettings, "performance"),
    `${phase}: retired performance preferences remain in persisted settings`
  );
  const session = settings.find(
    (setting) => setting.key === "runtimeRestoreSession"
  )?.payload;
  requireEvidence(
    session?.cleanExit === true,
    `${phase}: the Chromium settings phase did not persist a clean final flush`
  );
  return {
    cleanExit: true,
    retiredPerformanceSettingsAbsent: true
  };
}

function validateChromiumQuitGuardSqliteEvidence(phase, entities, settings) {
  requireEvidence(
    !entities.games.some((game) => game.name === "Chromium Unsaved Quit Guard Game"),
    `${phase}: renderer-discarded Game was persisted`
  );
  const session = settings.find(
    (setting) => setting.key === "runtimeRestoreSession"
  )?.payload;
  requireEvidence(
    session?.cleanExit === true,
    `${phase}: guarded Chromium quit did not persist a clean final flush`
  );
  return {
    cleanExit: true,
    restartVerified: phase === "chromium-quit-guard-restart",
    unsavedEntityAbsent: true
  };
}

function validateChromiumExplicitResetSqliteEvidence(
  phase,
  entities,
  roleSessionMigrations,
  pendingRoleBrowserDataClearOperations
) {
  const roles = entities.roles.filter((role) => role.name === "Chromium Retained v22 Role");
  requireEvidence(
    roles.length === 1,
    `${phase}: expected exactly one retained-v22 Chromium Role`
  );
  const role = roles[0];
  requireEvidence(
    role.payload?.launchUrl?.includes("/role/chromium-explicit-reset?") === true,
    `${phase}: retained-v22 Chromium Role lost its fixture launch URL`
  );
  const journals = roleSessionMigrations.filter((journal) => journal.roleId === role.id);
  requireEvidence(
    journals.length === 1,
    `${phase}: expected exactly one persisted migration journal for the retained-v22 Role`
  );
  const journal = journals[0];
  const sourceEngine = executionPlan.platform === "macos" ? "wkwebview" : "webview2";
  const firstVerifiedLaunch = new Date(journal.firstVerifiedLaunchAt ?? "");
  requireEvidence(
    journal.phase === "v23Ready"
      && Number.isSafeInteger(journal.journalRevision)
      && journal.journalRevision > 1
      && journal.platform === executionPlan.platform
      && journal.sourceEngine === sourceEngine
      && journal.targetEngine === "chromium"
      && journal.sourceRevision === 0
      && journal.targetRevision === 1
      && journal.outcome === "explicitReset"
      && Number.isFinite(firstVerifiedLaunch.valueOf())
      && firstVerifiedLaunch.toISOString() === journal.firstVerifiedLaunchAt,
    `${phase}: explicit reset did not atomically persist the exact v23Ready journal`
  );
  requireEvidence(
    /^chromium-session-clear:[0-9a-f-]{36}$/u.test(journal.cleanFlushReceiptId ?? ""),
    `${phase}: explicit reset lost its exact Chromium clear receipt correlation`
  );
  requireEvidence(
    /^role-browser-clear:role-browser-clear-[0-9a-f-]{36}$/u.test(
      journal.resetReceiptId ?? ""
    ),
    `${phase}: explicit reset lost its Core reset operation receipt`
  );
  requireEvidence(
    pendingRoleBrowserDataClearOperations === 0,
    `${phase}: role browser clear operation journal was not terminally removed`
  );
  const evidence = {
    cleanFlushReceiptId: journal.cleanFlushReceiptId,
    firstVerifiedLaunchAt: journal.firstVerifiedLaunchAt,
    journalRevision: journal.journalRevision,
    outcome: journal.outcome,
    phase: journal.phase,
    resetReceiptId: journal.resetReceiptId,
    roleId: role.id,
    targetRevision: journal.targetRevision,
    transferId: journal.transferId
  };
  if (phase === "chromium-role-session-reset-seed") {
    chromiumExplicitResetEvidence = evidence;
  } else {
    requireEvidence(
      chromiumExplicitResetEvidence !== undefined
        && JSON.stringify(evidence) === JSON.stringify(chromiumExplicitResetEvidence),
      `${phase}: restart changed the persisted explicit-reset receipt or journal identity`
    );
  }
  return {
    ...evidence,
    pendingRoleBrowserDataClearOperations,
    restartVerified: phase === "chromium-role-session-reset-restart"
  };
}

function validateChromiumRoleSessionIsolationSqliteEvidence(
  phase,
  entities,
  roleSessionMigrations,
  pendingRoleBrowserDataClearOperations
) {
  const roleNames = ["Chromium Session Role A", "Chromium Session Role B"];
  const roles = entities.roles.filter((role) => roleNames.includes(role.name));
  requireEvidence(
    roles.length === 2 && roleNames.every((name) => roles.some((role) => role.name === name)),
    `${phase}: expected the exact two Chromium Session isolation Roles`
  );
  requireEvidence(
    roles.every((role) => role.payload?.launchUrl?.includes("mode=observe")),
    `${phase}: an isolation Role lost its observe-only restart URL`
  );
  const games = entities.games.filter((game) => game.name === "Chromium Session Isolation Game");
  const workspaces = entities.workspaces.filter(
    (workspace) => workspace.name === "Chromium Session Isolation Workspace"
  );
  const gameWindows = entities.gameWindows.filter(
    (window) => window.name === "Chromium Session Isolation Window"
  );
  requireEvidence(games.length === 1, `${phase}: isolation Game is not uniquely persisted`);
  requireEvidence(workspaces.length === 1, `${phase}: isolation Workspace is not uniquely persisted`);
  requireEvidence(
    gameWindows.length === 1,
    `${phase}: isolation Game Window is not uniquely persisted`
  );
  const roleIds = new Set(roles.map((role) => role.id));
  const workspaceRoleIds = new Set(
    workspaces[0].payload?.slots?.map((slot) => slot.roleId).filter(Boolean) ?? []
  );
  requireEvidence(
    roleIds.size === 2 && [...roleIds].every((roleId) => workspaceRoleIds.has(roleId)),
    `${phase}: isolation Workspace lost its exact two-Role topology`
  );
  requireEvidence(
    gameWindows[0].payload?.tabs?.length === 1
      && gameWindows[0].payload.tabs[0]?.tabType === "workspace"
      && gameWindows[0].payload.tabs[0]?.sourceId === workspaces[0].id
      && gameWindows[0].payload.activeTabId === gameWindows[0].payload.tabs[0]?.id,
    `${phase}: isolation Game Window lost its exact saved Workspace tab`
  );

  const sourceEngine = executionPlan.platform === "macos" ? "wkwebview" : "webview2";
  const byRoleId = new Map(roleSessionMigrations.map((journal) => [journal.roleId, journal]));
  for (const role of roles) {
    const journal = byRoleId.get(role.id);
    const firstVerifiedLaunch = new Date(journal?.firstVerifiedLaunchAt ?? "");
    const isClearedA = phase === "chromium-role-session-isolation-restart"
      && role.name === "Chromium Session Role A";
    requireEvidence(
      journal?.phase === "v23Ready"
        && Number.isSafeInteger(journal.journalRevision)
        && journal.journalRevision > 1
        && journal.platform === executionPlan.platform
        && journal.sourceEngine === sourceEngine
        && journal.targetEngine === "chromium"
        && journal.sourceRevision === 0
        && journal.targetRevision === (isClearedA ? 1 : 0)
        && journal.outcome === "explicitReset"
        && Number.isFinite(firstVerifiedLaunch.valueOf())
        && firstVerifiedLaunch.toISOString() === journal.firstVerifiedLaunchAt,
      `${phase}: ${role.name} lost its exact terminal v23Ready journal`
    );
    requireEvidence(
      isClearedA
        ? /^chromium-session-clear:[0-9a-f-]{36}$/u.test(journal.cleanFlushReceiptId ?? "")
          && /^role-browser-clear:role-browser-clear-[0-9a-f-]{36}$/u.test(
            journal.resetReceiptId ?? ""
          )
        : /^v23-empty-store:[0-9a-f-]{36}$/u.test(journal.cleanFlushReceiptId ?? "")
          && /^v23-role-create:[0-9a-f-]{36}$/u.test(journal.resetReceiptId ?? ""),
      `${phase}: ${role.name} lost its exact initialization or clear receipt`
    );
  }
  requireEvidence(
    pendingRoleBrowserDataClearOperations === 0,
    `${phase}: Role browser-data clear operation journal was not terminally removed`
  );
  return {
    pendingRoleBrowserDataClearOperations,
    roleIds: [...roleIds].sort(),
    roleTargetRevisions: Object.fromEntries(roles.map((role) => [
      role.name,
      byRoleId.get(role.id)?.targetRevision
    ])),
    windowId: gameWindows[0].id,
    workspaceId: workspaces[0].id
  };
}

async function captureSqlite(phase, userDataDir, validateEvidence) {
  const phaseDir = resolve(artifactRoot, "phases", phase);
  await mkdir(phaseDir, { recursive: true });
  const databasePath = resolve(userDataDir, "rion-studio.sqlite3");
  await copyIfPresent(databasePath, resolve(phaseDir, "rion-studio.sqlite3"));
  await copyIfPresent(`${databasePath}-wal`, resolve(phaseDir, "rion-studio.sqlite3-wal"));
  await copyIfPresent(`${databasePath}-shm`, resolve(phaseDir, "rion-studio.sqlite3-shm"));
  try {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    const readEntities = (table) => database.prepare(
      `SELECT id, name, payload_json AS payloadJson FROM ${table} ORDER BY ordinal`
    ).all().map((row) => ({ ...row, payload: JSON.parse(String(row.payloadJson)) }));
    const entities = {
      games: readEntities("games"),
      gameWindows: readEntities("game_windows"),
      macros: readEntities("macros"),
      roles: readEntities("roles"),
      workspaces: readEntities("workspaces")
    };
    const settings = database.prepare(
      "SELECT key, payload_json AS payloadJson FROM settings ORDER BY key"
    ).all().map((row) => ({
      ...row,
      payload: JSON.parse(String(row.payloadJson))
    }));
    const roleSessionMigrations = database.prepare(`
      SELECT
        role_id AS roleId,
        transfer_id AS transferId,
        phase,
        journal_revision AS journalRevision,
        platform,
        source_engine AS sourceEngine,
        target_engine AS targetEngine,
        source_revision AS sourceRevision,
        target_revision AS targetRevision,
        outcome,
        first_verified_launch_at AS firstVerifiedLaunchAt,
        clean_flush_receipt_id AS cleanFlushReceiptId,
        reset_receipt_id AS resetReceiptId
      FROM role_session_migrations
      ORDER BY role_id
    `).all().map((row) => ({
      ...row,
      journalRevision: Number(row.journalRevision),
      sourceRevision: Number(row.sourceRevision),
      targetRevision: row.targetRevision === null ? null : Number(row.targetRevision)
    }));
    const pendingRoleBrowserDataClearOperations = Number(database.prepare(`
      SELECT COUNT(*) AS count
      FROM operation_journal
      WHERE kind = 'role_browser_data_clear_v1'
    `).get().count);
    database.close();
    await writeFile(
      resolve(phaseDir, "sqlite-query.json"),
      `${JSON.stringify({
        ...entities,
        pendingRoleBrowserDataClearOperations,
        roleSessionMigrations,
        settings
      }, null, 2)}\n`
    );
    if (!validateEvidence) {
      return {
        entityCounts: Object.fromEntries(Object.entries(entities).map(([key, values]) => [key, values.length])),
        validationSkipped: "phase-failed"
      };
    }
    if (phase === "chromium-game-crud-seed" || phase === "chromium-game-crud-restart") {
      return validateChromiumGameCrudSqliteEvidence(phase, entities);
    }
    const chromiumJourney = validateChromiumJourneySqliteEvidence({
      entities,
      phase,
      phaseDirectory: phaseDir,
      settings
    });
    if (chromiumJourney !== undefined) return chromiumJourney;
    if (
      phase === "chromium-entity-persistence-seed"
      || phase === "chromium-entity-persistence-restart"
    ) {
      return validateChromiumEntityPersistenceSqliteEvidence(phase, entities);
    }
    if (
      phase === "chromium-quick-access-seed"
      || phase === "chromium-quick-access-restart"
    ) {
      return validateChromiumQuickAccessSqliteEvidence(phase, entities, settings);
    }
    if (phase === "chromium-app-crud-mutations") {
      return validateChromiumAppCrudMutationSqliteEvidence(phase, entities);
    }
    if (
      phase === "chromium-app-crud-cleanup"
      || phase === "chromium-app-crud-final-restart"
    ) {
      return validateChromiumAppCrudCleanupSqliteEvidence(phase, entities);
    }
    if (phase === "chromium-graphics-settings-seed" || phase === "chromium-graphics-settings-restart") {
      const graphics = settings.find((setting) => setting.key === "graphicsSettings")?.payload;
      if (graphics?.settings?.hardwareAcceleration !== false || graphics.settings.rasterization !== "enabled" || graphics.settings.videoDecode !== "disabled") {
        throw new Error(`${phase}: persisted graphics settings do not match visible selections`);
      }
      return { graphicsSettings: graphics };
    }
    if (phase === "chromium-system-settings") {
      return validateChromiumSystemSettingsSqliteEvidence(phase, settings);
    }
    if (
      phase === "chromium-quit-guard-seed"
      || phase === "chromium-quit-guard-restart"
    ) {
      return validateChromiumQuitGuardSqliteEvidence(phase, entities, settings);
    }
    if (
      phase === "chromium-role-session-reset-seed"
      || phase === "chromium-role-session-reset-restart"
    ) {
      return validateChromiumExplicitResetSqliteEvidence(
        phase,
        entities,
        roleSessionMigrations,
        pendingRoleBrowserDataClearOperations
      );
    }
    if (
      phase === "chromium-role-session-isolation-seed"
      || phase === "chromium-role-session-isolation-restart"
    ) {
      return validateChromiumRoleSessionIsolationSqliteEvidence(
        phase,
        entities,
        roleSessionMigrations,
        pendingRoleBrowserDataClearOperations
      );
    }
    return {
      entityCounts: Object.fromEntries(Object.entries(entities).map(([key, values]) => [key, values.length]))
    };
  } catch (error) {
    await writeFile(resolve(phaseDir, "sqlite-query-error.txt"), `${String(error)}\n`);
    throw error;
  }
}

async function acceptedElectronFinalFlush(phaseDir, phase) {
  const markerName = "electron-final-flush.json";
  const markerPath = resolve(phaseDir, markerName);
  const readMarker = async () => {
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    if (
      marker.complete !== true
      || marker.phase !== phase
      || marker.runtimeTarget !== executionPlan.runtimeTargetName
      || !Number.isSafeInteger(marker.pid)
      || marker.pid <= 0
    ) {
      throw new Error(`Electron final-flush marker is invalid for phase ${phase}`);
    }
    return marker;
  };
  try {
    return await readMarker();
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const abort = AbortSignal.timeout(30_000);
  try {
    const changes = watch(phaseDir, { signal: abort });
    try {
      return await readMarker();
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    for await (const change of changes) {
      if (change.filename === markerName) return readMarker();
    }
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Electron phase ${phase} did not reach an authoritative final flush`, {
        cause: error
      });
    }
    throw error;
  }
  throw new Error(`Electron phase ${phase} ended without final-flush evidence`);
}

async function awaitElectronProcessExit(marker, phase) {
  if (process.platform === "darwin") {
    const deadline = Date.now() + 45_000;
    for (;;) {
      try {
        process.kill(marker.pid, 0);
      } catch (error) {
        if (error?.code === "ESRCH") return;
        throw error;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Electron phase ${phase} did not release its exact macOS process boundary`
        );
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
  }
  if (process.platform !== "win32") return;
  const wait = await run("pwsh", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `$target = Get-Process -Id ${marker.pid} -ErrorAction SilentlyContinue; ` +
      "if ($null -eq $target -or $target.HasExited) { exit 0 }; " +
      "if (-not $target.WaitForExit(45000)) { " +
      "throw 'Electron process exit deadline elapsed' }; exit 0"
  ]);
  if (wait.code !== 0) {
    throw new Error(
      `Electron phase ${phase} did not release its exact Windows process boundary`
    );
  }
}

function blockedReason(output) {
  const matches = [...output.matchAll(/BLOCKED:[^\r\n]*/gu)];
  return matches.at(-1)?.[0];
}

const report = {
  artifactRoot,
  binary,
  commit: checkoutCommit,
  driver: executionPlan.driver,
  journeys: [],
  phases: [],
  profile,
  requestedCommit,
  runtimeTarget: executionPlan.runtimeTargetName,
  startedAt: new Date().toISOString(),
  worktreeDirty
};
let fixture;
let failure;
try {
  if (requestedCommit && requestedCommit.toLowerCase() !== checkoutCommit.toLowerCase()) {
    throw new Error(
      `Desktop E2E checkout ${checkoutCommit} does not match requested commit ${requestedCommit}`
    );
  }
  if (requestedCommit && worktreeDirty) {
    throw new Error("Desktop E2E immutable-SHA validation requires a clean worktree");
  }
  if (process.env.RION_STUDIO_E2E_SKIP_BUILD !== "1") {
    const build = await run(node, [executionPlan.buildScriptPath]);
    if (build.code !== 0) throw new Error(`Desktop E2E build failed (${build.code})`);
  }
  await access(binary);
  await verifyDesktopE2eBuild({
    driver: executionPlan.driver,
    repositoryRoot: root
  });
  fixture = await startFixture();
  for (const phase of phases) {
    const phaseDir = resolve(artifactRoot, "phases", phase);
    const userDataDir = userDataDirForPhase(phase);
    await mkdir(phaseDir, { recursive: true });
    await mkdir(userDataDir, { recursive: true });
    const result = await run(node, [wdio, "run", executionPlan.wdioConfigPath], {
      env: {
        RION_STUDIO_E2E_APP_BINARY: binary,
        RION_STUDIO_E2E_ARTIFACT_DIR: phaseDir,
        RION_STUDIO_E2E_FIXTURE_ORIGIN: fixture.origin,
        RION_STUDIO_E2E_PHASE: phase,
        RION_STUDIO_E2E_RUNTIME_TARGET: executionPlan.runtimeTargetName,
        RION_STUDIO_E2E_SESSION_TOKEN: token,
        ...desktopE2eForcedTerminationEnvironment(phase),
        RION_STUDIO_USER_DATA_DIR: userDataDir
      },
      logPath: resolve(phaseDir, "runner.log")
    });
    const forcedTermination = isExpectedDesktopE2eForcedTermination(phase)
      ? await acceptedDesktopE2eForcedTermination(phaseDir)
      : undefined;
    const shutdown = await observeElectronPhaseShutdown({
      driver: executionPlan.driver,
      forcedTermination: Boolean(forcedTermination),
      exitCode: result.code,
      readFinalFlush: () => acceptedElectronFinalFlush(phaseDir, phase),
      waitForProcessExit: (electronFinalFlush) => awaitElectronProcessExit(electronFinalFlush, phase)
    });
    const electronFinalFlush = shutdown.finalFlush;
    const nativeRuntimeEvidence = executionPlan.driver === "electron"
      && (result.code === 0 || Boolean(forcedTermination))
      ? await validateChromiumJourneyRuntimeEvidence({
        phase,
        phaseDirectory: phaseDir,
        platform: executionPlan.platform
      }) ?? await validateChromiumRoleRuntimeEvidence(phase, phaseDir)
      : undefined;
    const blocked = blockedReason(result.output);
    const sqliteEvidence = await captureSqlite(
      phase,
      userDataDir,
      result.code === 0 || Boolean(forcedTermination)
    );
    const phaseStatus = blocked
      ? "BLOCKED"
      : forcedTermination
        ? "EXPECTED_FORCE_TERMINATION"
        : result.code === 0 ? "PASS" : "FAIL";
    report.phases.push({
      blockedReason: blocked,
      exitCode: result.code,
      expectedForcedTermination: forcedTermination ? true : undefined,
      electronFinalFlush: electronFinalFlush ? true : undefined,
      electronProcessExited: shutdown.processExited,
      electronShutdownError: shutdown.shutdownError,
      nativeRuntimeEvidence,
      phase,
      sqliteEvidence,
      status: phaseStatus
    });
    if (blocked || (result.code !== 0 && !forcedTermination)) {
      throw new Error(
        blocked ?? `Desktop E2E phase ${phase} failed (${result.code})`
      );
    }
  }
  if (!phaseArgument) {
    const incomplete = aggregateDesktopE2eJourneyVerdicts(
      coverageManifest,
      profile,
      report.phases
    ).filter((journey) => journey.status !== "PASS");
    if (incomplete.length > 0) {
      throw new Error(
        `Desktop E2E profile ${profile} has incomplete journey evidence: ${incomplete
          .map((journey) => `${journey.id}=${journey.status}`)
          .join(", ")}`
      );
    }
  }
} catch (error) {
  failure = error;
} finally {
  if (fixture) await fixture.close();
  report.journeys = aggregateDesktopE2eJourneyVerdicts(
    coverageManifest,
    profile,
    report.phases
  );
  report.finishedAt = new Date().toISOString();
  report.failure = failure ? String(failure) : undefined;
  await writeFile(resolve(artifactRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
}

process.stdout.write(`Desktop E2E artifacts: ${artifactRoot}\n`);
if (failure) throw failure;
