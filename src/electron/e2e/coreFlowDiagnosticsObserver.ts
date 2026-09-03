import { writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import type {
  CoreAppSnapshotRecord,
  CoreCommand,
  CoreCommandResult
} from "../../shared/generated";
import { CoreAddonClient } from "../core/coreAddonClient";
import { ElectronDiagnosticsExport } from "../main/electronDiagnosticsExport";
import type { ChromiumRuntimeEffectExecutor } from
  "../main/chromiumRuntimeEffectExecutor";
import { ChromiumRuntimeLaunchCompletionCoordinator } from
  "../main/chromiumRuntimeLaunchCompletionCoordinator";
import { ElectronMainLifecycle } from "../main/lifecycle";
import {
  ELECTRON_DESKTOP_E2E_DIAGNOSTICS_EXPORT_JOURNAL_CAPACITY,
  type ElectronDesktopE2eDiagnosticsExportJournalInspection,
  type ElectronDesktopE2eDiagnosticsExportObservation
} from "./desktopE2eBridge";

const artifactDirectory = process.env.RION_STUDIO_E2E_ARTIFACT_DIR;
const CORE_FLOW_OBSERVATION_CAPACITY = 4_096;
const coreFlowObservations: Array<Readonly<{
  boundary: "ack" | "command" | "effect" | "launch";
  identity: string;
  sequence: number;
  status: "started" | "completed" | "rejected";
  type: string;
  details?: unknown;
  error?: string;
}>> = [];
const diagnosticsExportObservations: ElectronDesktopE2eDiagnosticsExportObservation[] =
  [];
let diagnosticsExportCoreInvocationCount = 0;
let nextCoreFlowSequence = 1;
let nextDiagnosticsExportObservationSequence = 1;

export function appendCoreFlowObservation(
  observation: Omit<typeof coreFlowObservations[number], "sequence">
): void {
  coreFlowObservations.push(Object.freeze({
    ...observation,
    sequence: nextCoreFlowSequence++
  }));
  if (coreFlowObservations.length > CORE_FLOW_OBSERVATION_CAPACITY) {
    const routineRead = coreFlowObservations.findIndex((candidate) =>
      candidate.boundary === "command" &&
      (candidate.type === "appSnapshot" ||
        candidate.type === "runtimeWindowPreferencesGet")
    );
    coreFlowObservations.splice(routineRead < 0 ? 0 : routineRead, 1);
  }
  if (artifactDirectory && isAbsolute(artifactDirectory)) {
    writeFileSync(
      join(artifactDirectory, "electron-core-flow-observations.json"),
      `${JSON.stringify(coreFlowObservations, null, 2)}\n`,
      "utf8"
    );
  }
}

export function describeCoreFlowError(error: unknown): string {
  const code = typeof error === "object" && error !== null &&
    typeof Reflect.get(error, "code") === "string"
    ? Reflect.get(error, "code") as string
    : "Error";
  const message = error instanceof Error ? error.message : String(error);
  return `${code}: ${message}`;
}

export function describeRuntimeEffectAction(
  action: Parameters<ChromiumRuntimeEffectExecutor["execute"]>[0]["action"]
): unknown {
  if (action.type === "embeddedCreateTab") {
    return {
      tabId: action.tab.tabId,
      windowId: action.tab.target.windowId,
      windowGeneration: action.tab.appkitWindowGeneration,
      topologyRevision: action.tab.appkitTopologyRevision
    };
  }
  if (action.type === "embeddedLoadRoles") {
    return { roleIds: action.roles.map((role) => role.roleId) };
  }
  if (action.type === "embeddedDestroyTab") {
    return { tabId: action.tabId };
  }
  if (action.type === "embeddedFollowRoleOwnership") {
    return { windows: action.windows ?? [] };
  }
  if (action.type === "embeddedApplyAppKitProjection") {
    return { windows: action.projection.windows };
  }
  return undefined;
}

export function nextCoreFlowIdentity(prefix: string): string {
  return `${prefix}:${nextCoreFlowSequence}`;
}

function appendDiagnosticsExportObservation(
  observation: Omit<ElectronDesktopE2eDiagnosticsExportObservation, "sequence">
): void {
  diagnosticsExportObservations.push(Object.freeze({
    ...observation,
    sequence: nextDiagnosticsExportObservationSequence++
  }));
  if (diagnosticsExportObservations.length >
    ELECTRON_DESKTOP_E2E_DIAGNOSTICS_EXPORT_JOURNAL_CAPACITY) {
    diagnosticsExportObservations.shift();
  }
}

export function readDiagnosticsExportJournal(): ElectronDesktopE2eDiagnosticsExportJournalInspection {
  return Object.freeze({
    capacity: ELECTRON_DESKTOP_E2E_DIAGNOSTICS_EXPORT_JOURNAL_CAPACITY,
    journalVersion: 1,
    observations: Object.freeze([...diagnosticsExportObservations])
  });
}

export function installElectronDesktopE2eDiagnosticsExportObserver(): void {
  const core = CoreAddonClient.prototype;
  const originalInvoke = core.invoke;
  core.invoke = function <Command extends CoreCommand>(
    command: Command
  ): Promise<CoreCommandResult<Command>> {
    if (command.type === "diagnosticsExport") {
      diagnosticsExportCoreInvocationCount += 1;
    }
    const identity = nextCoreFlowIdentity(command.type);
    const requestDetails = command.type === "browserAppKitRuntimeEvent"
      ? { event: command.event }
      : command.type === "browserPopupOpenAdmit"
        ? { request: command.request }
        : undefined;
    appendCoreFlowObservation({
      boundary: "command",
      ...(requestDetails === undefined ? {} : { details: requestDetails }),
      identity,
      status: "started",
      type: command.type
    });
    return (originalInvoke.call(this, command) as Promise<CoreCommandResult<Command>>)
      .then((result) => {
        const details = command.type === "appSnapshot"
          ? (() => {
              const snapshot = result as CoreAppSnapshotRecord;
              return {
                browserTabs: snapshot.browserRuntime.tabs.map((tab) => ({
                  tabId: tab.id,
                  windowId: tab.windowId
                })),
                browserWindows: snapshot.browserRuntime.windows.map((window) => ({
                  tabIds: window.tabIds,
                  windowId: window.windowId
                })),
                browserRoles: snapshot.browserRuntime.roles.map((role) => ({
                  roleId: role.roleId,
                  state: role.state
                })),
                logicalWindows: snapshot.logicalWindows.map((window) => ({
                  tabIds: window.tabs.map((tab) => tab.id),
                  windowId: window.windowId
                })),
                revision: snapshot.revision,
                roleStatuses: snapshot.roleStatuses.map((status) => ({
                  roleId: status.roleId,
                  state: status.state
                })),
                runtimeRevision: snapshot.runtimeRevision
              };
            })()
          : command.type === "browserRoleLaunch" ||
              command.type === "browserWorkspaceLaunch"
            ? { admission: result }
          : command.type === "browserAppKitRuntimeEvent"
            ? { receipt: result }
            : undefined;
        appendCoreFlowObservation({
          boundary: "command",
          ...(details === undefined ? {} : { details }),
          identity,
          status: "completed",
          type: command.type
        });
        return result;
      }, (error: unknown) => {
        appendCoreFlowObservation({
          boundary: "command",
          error: error instanceof Error ? error.message : String(error),
          identity,
          status: "rejected",
          type: command.type
        });
        throw error;
      });
  };

  const diagnostics = ElectronDiagnosticsExport.prototype;
  const originalExport = diagnostics.export;
  diagnostics.export = async function (identity) {
    const invocationCountBefore = diagnosticsExportCoreInvocationCount;
    try {
      const result = await originalExport.call(this, identity);
      appendDiagnosticsExportObservation({
        coreDiagnosticsExportInvocationCount:
          diagnosticsExportCoreInvocationCount - invocationCountBefore,
        outcome: result === null ? "cancelled" : "exported",
        typedOutcome: result === null ? null : "diagnosticExportResult"
      });
      return result;
    } catch (error) {
      appendDiagnosticsExportObservation({
        coreDiagnosticsExportInvocationCount:
          diagnosticsExportCoreInvocationCount - invocationCountBefore,
        outcome: "rejected",
        typedOutcome: "rejected"
      });
      throw error;
    }
  };
}

export function installElectronDesktopE2eLaunchCompletionObserver(): void {
  const coordinator = ChromiumRuntimeLaunchCompletionCoordinator.prototype;
  const originalAwaitExact = coordinator.awaitExact;
  coordinator.awaitExact = function (expected) {
    appendCoreFlowObservation({
      boundary: "launch",
      details: expected,
      identity: expected.operationId,
      status: "started",
      type: "awaitExactCompletion"
    });
    return originalAwaitExact.call(this, expected).then((completion) => {
      appendCoreFlowObservation({
        boundary: "launch",
        details: completion,
        identity: expected.operationId,
        status: "completed",
        type: "awaitExactCompletion"
      });
      return completion;
    }, (error: unknown) => {
      appendCoreFlowObservation({
        boundary: "launch",
        error: describeCoreFlowError(error),
        identity: expected.operationId,
        status: "rejected",
        type: "awaitExactCompletion"
      });
      throw error;
    });
  };
}

export function installElectronDesktopE2eGuardedQuitObserver(
  writeFinalFlushMarker: () => void
): void {
  const lifecycle = ElectronMainLifecycle.prototype;
  const originalConfirmQuit = lifecycle.confirmQuit;
  let finalFlushObserved = false;
  lifecycle.confirmQuit = function (): Promise<void> {
    const terminal = originalConfirmQuit.call(this);
    if (!finalFlushObserved) {
      void terminal.then(() => {
        if (finalFlushObserved) return;
        finalFlushObserved = true;
        // Synchronous persistence ensures the E2E evidence survives the exact
        // app.quit call which follows the completed Core/runtime drain.
        writeFinalFlushMarker();
      }, () => undefined);
    }
    return terminal;
  };
}
