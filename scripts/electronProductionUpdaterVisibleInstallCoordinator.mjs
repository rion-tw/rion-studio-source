import {
  assertElectronProductionUpdaterJournalTrace,
  observeElectronProductionUpdaterJournalTrace,
  readElectronProductionUpdaterJournalTrace
} from "./electronProductionUpdaterJournalTraceObserver.mjs";
import {
  ELECTRON_PRODUCTION_UPDATER_SOURCE_JOURNAL_NAME,
  observeElectronProductionUpdaterSourceJournal
} from "./electronProductionUpdaterSourceJournalObserver.mjs";
import {
  pressVisibleProductionUpdaterInstall
} from "./electronProductionUpdaterVisibleUi.mjs";
import { serializeCanonicalJson } from "./canonicalJson.mjs";
import {
  assertEqual,
  assertExactKeys,
  publicIdentity,
  readStableFile,
  requiredAbsolutePath,
  requiredDigest,
  requiredRfc3339,
  requiredSemanticVersion,
  resolveCreateNewFile,
  writeExclusive
} from "./electronUpdaterCompatibilityReceiptIo.mjs";

export const ELECTRON_PRODUCTION_UPDATER_VISIBLE_INSTALL_OBSERVATION_KIND =
  "rion-production-updater-visible-install-observation";

const MAX_DOCUMENT_BYTES = 1024 * 1024;
const INSTALL_ACTION_FILE = "install-action.json";
const PLATFORM_BINDINGS = Object.freeze({
  "darwin-aarch64": Object.freeze({
    handoffPhase: "restartPending",
    uiPlatform: "darwin"
  }),
  "windows-x86_64": Object.freeze({
    handoffPhase: "installerHandoff",
    uiPlatform: "win32"
  })
});
const TRANSITIONS = new Set([
  "tauri-v22-to-electron-v23",
  "electron-v23-to-electron-v23"
]);

export async function coordinateElectronProductionUpdaterVisibleInstall(
  input,
  dependencyOverrides = {}
) {
  assertExactKeys(input, [
    "installActionOutputPath",
    "journalPath",
    "journalTraceOutputPath",
    "platform",
    "processId",
    "signal",
    "sourceJournalOutputPath",
    "targetVersion",
    "transitionKind"
  ], "visible install observation input");
  const platform = requiredPlatform(input.platform);
  const transitionKind = requiredTransition(input.transitionKind);
  const targetVersion = requiredSemanticVersion(
    input.targetVersion,
    "visible install target version"
  );
  const processId = requiredProcessId(input.processId);
  const signal = requiredAbortSignal(input.signal);
  const journalPath = requiredAbsolutePath(
    input.journalPath,
    "source updater install journal"
  );
  const journalTraceOutputPath = requiredAbsolutePath(
    input.journalTraceOutputPath,
    "source journal trace output"
  );
  const sourceJournalOutputPath = requiredAbsolutePath(
    input.sourceJournalOutputPath,
    "sealed source journal output"
  );
  const installActionOutputPath = await resolveCreateNewFile(
    input.installActionOutputPath,
    INSTALL_ACTION_FILE,
    "visible updater install action"
  );
  const dependencies = resolveDependencies(dependencyOverrides);
  const invocationTime = requiredNow(
    dependencies.now(),
    "visible install observation start"
  );
  const visibleInstallInvokedAt = invocationTime.toISOString();
  const cancellation = createLinkedCancellation(signal);
  const traceAdmission = deferred();
  const sourceAdmission = deferred();
  let tracePromise;
  let sourcePromise;

  try {
    tracePromise = dependencies.observeJournalTrace({
      journalPath,
      outputPath: journalTraceOutputPath,
      platform,
      signal: cancellation.signal,
      targetVersion,
      transitionKind,
      visibleInstallInvokedAt
    }, {
      now: dependencies.now,
      onWatchStarted: traceAdmission.resolve,
      readFile: dependencies.readFile,
      watchDirectory: dependencies.watchDirectory
    });
    sourcePromise = dependencies.observeSourceJournal({
      journalPath,
      outputPath: sourceJournalOutputPath,
      platform,
      signal: cancellation.signal,
      targetVersion,
      visibleInstallInvokedAt
    }, {
      onWatchStarted: sourceAdmission.resolve,
      readFile: dependencies.readFile,
      watchDirectory: dependencies.watchDirectory
    });
    void tracePromise.catch(() => undefined);
    void sourcePromise.catch(() => undefined);
    await Promise.all([
      requireWatcherAdmission(traceAdmission.promise, tracePromise, "journal trace"),
      requireWatcherAdmission(sourceAdmission.promise, sourcePromise, "source journal")
    ]);
    if (cancellation.signal.aborted) {
      throw cancelledInstall(cancellation.signal.reason);
    }

    let deliveredInvocationTime = false;
    const action = assertInstallAction(await dependencies.pressInstall({
      platform: PLATFORM_BINDINGS[platform].uiPlatform,
      processId
    }, {
      now: () => {
        if (!deliveredInvocationTime) {
          deliveredInvocationTime = true;
          return new Date(invocationTime);
        }
        return dependencies.now();
      },
      runMacos: dependencies.runMacos,
      runWindows: dependencies.runWindows
    }), PLATFORM_BINDINGS[platform].uiPlatform, processId, visibleInstallInvokedAt);
    await writeExclusive(installActionOutputPath, serializeCanonicalJson(action));
    const actionFile = await readStableFile(
      installActionOutputPath,
      MAX_DOCUMENT_BYTES,
      "sealed visible updater install action"
    );

    const [traceResult, sourceCapture] = await Promise.all([
      tracePromise,
      sourcePromise
    ]);
    const verifiedTrace = await readElectronProductionUpdaterJournalTrace({
      expectedSha256: traceResult.traceIdentity.sha256,
      tracePath: journalTraceOutputPath
    });
    const trace = assertElectronProductionUpdaterJournalTrace(verifiedTrace.trace);
    const sourceFile = await readStableFile(
      sourceJournalOutputPath,
      MAX_DOCUMENT_BYTES,
      "sealed source updater install journal"
    );
    const source = assertSourceCapture(
      sourceCapture,
      platform,
      targetVersion,
      sourceFile
    );
    assertEqual(trace.visibleInstallInvokedAt, action.invokedAt,
      "visible install trace invocation time");
    assertEqual(trace.sourceInstallAttemptId, source.sourceInstallAttemptId,
      "visible install source attempt ID");
    const finalObservation = trace.observations.at(-1);
    assertEqual(finalObservation.phase, PLATFORM_BINDINGS[platform].handoffPhase,
      "visible install trace handoff phase");
    assertEqual(finalObservation.journal.bytes, source.journal.bytes,
      "visible install source journal bytes");
    assertEqual(finalObservation.journal.sha256, source.journal.sha256,
      "visible install source journal SHA-256");

    return deepFreeze({
      schemaVersion: 1,
      kind: ELECTRON_PRODUCTION_UPDATER_VISIBLE_INSTALL_OBSERVATION_KIND,
      platform,
      transitionKind,
      sourceInstallAttemptId: trace.sourceInstallAttemptId,
      artifacts: {
        installAction: publicIdentity(installActionOutputPath, actionFile),
        journalTrace: verifiedTrace.traceIdentity,
        sourceJournal: publicIdentity(sourceJournalOutputPath, sourceFile)
      }
    });
  } catch (error) {
    cancellation.abort(error);
    await Promise.allSettled([
      tracePromise ?? Promise.resolve(),
      sourcePromise ?? Promise.resolve()
    ]);
    throw error;
  } finally {
    cancellation.dispose();
  }
}

function assertInstallAction(value, platform, processId, invokedAt) {
  assertExactKeys(value, [
    "action",
    "completedAt",
    "controlName",
    "interaction",
    "invokedAt",
    "kind",
    "platform",
    "processId",
    "remoteDebugging",
    "schemaVersion"
  ], "visible updater install action");
  assertEqual(value.schemaVersion, 1, "visible updater install schema version");
  assertEqual(value.kind, "rion-production-updater-visible-ui-action",
    "visible updater install kind");
  assertEqual(value.action, "install", "visible updater install action");
  assertEqual(value.controlName, "Restart and update",
    "visible updater install control");
  assertEqual(value.interaction, "visible-os-accessibility-press",
    "visible updater install interaction");
  assertEqual(value.platform, platform, "visible updater install platform");
  assertEqual(value.processId, processId, "visible updater install process ID");
  assertEqual(value.remoteDebugging, false,
    "visible updater install remote-debugging state");
  const observedInvokedAt = requiredRfc3339(
    value.invokedAt,
    "visible updater install invocation"
  );
  assertEqual(observedInvokedAt, invokedAt, "visible updater install invocation");
  const completedAt = requiredRfc3339(
    value.completedAt,
    "visible updater install completion"
  );
  if (Date.parse(completedAt) < Date.parse(observedInvokedAt)) {
    throw new Error("The visible updater install completion precedes invocation.");
  }
  return deepFreeze({ ...value, invokedAt: observedInvokedAt, completedAt });
}

function assertSourceCapture(value, platform, targetVersion, file) {
  assertExactKeys(value, [
    "journal",
    "kind",
    "phase",
    "platform",
    "schemaVersion",
    "sourceInstallAttemptId",
    "startedAt",
    "updatedAt"
  ], "source journal capture");
  assertEqual(value.schemaVersion, 1, "source journal capture schema version");
  assertEqual(value.kind, "rion-production-updater-source-journal-capture",
    "source journal capture kind");
  assertEqual(value.platform, platform, "source journal capture platform");
  assertEqual(value.phase, PLATFORM_BINDINGS[platform].handoffPhase,
    "source journal capture phase");
  assertExactKeys(value.journal, ["bytes", "fileName", "sha256"],
    "source journal capture identity");
  assertEqual(value.journal.fileName, ELECTRON_PRODUCTION_UPDATER_SOURCE_JOURNAL_NAME,
    "source journal capture filename");
  assertEqual(value.journal.bytes, file.bytes, "source journal capture bytes");
  assertEqual(requiredDigest(value.journal.sha256, "source journal capture SHA-256"),
    file.sha256, "source journal capture SHA-256");
  requiredRfc3339(value.startedAt, "source journal capture start time");
  requiredRfc3339(value.updatedAt, "source journal capture update time");
  const document = JSON.parse(file.source.toString("utf8"));
  assertEqual(document?.attempt?.targetVersion, targetVersion,
    "sealed source journal target version");
  assertEqual(document?.attempt?.attemptId, value.sourceInstallAttemptId,
    "sealed source journal attempt ID");
  return value;
}

function requireWatcherAdmission(admission, observation, label) {
  return Promise.race([
    admission,
    observation.then(
      () => { throw new Error(`The ${label} completed before visible install admission.`); },
      (error) => { throw error; }
    )
  ]);
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  let settled = false;
  return Object.freeze({
    promise,
    resolve() {
      if (settled) return;
      settled = true;
      resolve();
    }
  });
}

function createLinkedCancellation(signal) {
  const controller = new AbortController();
  const relay = () => controller.abort(signal.reason);
  if (signal.aborted) relay();
  else signal.addEventListener("abort", relay, { once: true });
  return Object.freeze({
    signal: controller.signal,
    abort(reason) {
      if (!controller.signal.aborted) controller.abort(reason);
    },
    dispose() {
      signal.removeEventListener("abort", relay);
    }
  });
}

function resolveDependencies(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Visible install coordinator dependencies must be an object.");
  }
  const allowed = new Set([
    "now",
    "observeJournalTrace",
    "observeSourceJournal",
    "pressInstall",
    "readFile",
    "runMacos",
    "runWindows",
    "watchDirectory"
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`Unknown visible install coordinator dependency ${key}.`);
    }
  }
  const dependencies = {
    now: value.now ?? (() => new Date()),
    observeJournalTrace: value.observeJournalTrace ??
      observeElectronProductionUpdaterJournalTrace,
    observeSourceJournal: value.observeSourceJournal ??
      observeElectronProductionUpdaterSourceJournal,
    pressInstall: value.pressInstall ?? pressVisibleProductionUpdaterInstall,
    readFile: value.readFile,
    runMacos: value.runMacos,
    runWindows: value.runWindows,
    watchDirectory: value.watchDirectory
  };
  for (const [name, dependency] of Object.entries(dependencies)) {
    if (dependency !== undefined && typeof dependency !== "function") {
      throw new Error(`The visible install coordinator ${name} dependency is invalid.`);
    }
  }
  return Object.freeze(dependencies);
}

function requiredPlatform(value) {
  if (!Object.hasOwn(PLATFORM_BINDINGS, value)) {
    throw new Error("The visible install observation platform is unsupported.");
  }
  return value;
}

function requiredTransition(value) {
  if (!TRANSITIONS.has(value)) {
    throw new Error("The visible install observation transition is unsupported.");
  }
  return value;
}

function requiredProcessId(value) {
  if (!Number.isSafeInteger(value) || value <= 1) {
    throw new Error("The visible install observation process ID is invalid.");
  }
  return value;
}

function requiredAbortSignal(value) {
  if (!value || typeof value !== "object" ||
      typeof value.aborted !== "boolean" ||
      typeof value.addEventListener !== "function") {
    throw new Error("The visible install observation requires an AbortSignal.");
  }
  return value;
}

function requiredNow(value, label) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`The ${label} clock is invalid.`);
  }
  return value;
}

function cancelledInstall(reason) {
  const suffix = reason instanceof Error ? ` (${reason.message})` : "";
  return new Error(`The visible install observation was cancelled${suffix}.`);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}
