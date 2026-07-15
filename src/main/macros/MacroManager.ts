import { EventEmitter } from "node:events";

import type { Macro, MacroRunStatus, MacroStep } from "../../shared/types";
import type { BrowserManager } from "../browser/BrowserManager";
import type { BrowserAutomationTarget } from "../browser/ElectronAutomationTarget";
import type { MacroStore } from "./MacroStore";

export interface MacroManagerEvents {
  change: [MacroRunStatus[]];
}

interface MacroRun {
  abortController: AbortController;
  cancelActiveOperation?: () => void;
  cancelDelay?: () => void;
  completion: Promise<void>;
  isCancelled: boolean;
  resolveCompletion: () => void;
  status: MacroRunStatus;
  terminalStatus?: MacroRunStatus;
}

const MACRO_TARGET_OPERATION_TIMEOUT_MS = 10_000;
const SIBLING_FAILURE_MESSAGE = "Cancelled because another assigned role failed.";

class MacroRunCancelledError extends Error {
  constructor() {
    super("Macro run cancelled.");
    this.name = "MacroRunCancelledError";
  }
}

export class MacroMutationBusyError extends Error {
  constructor() {
    super("Stop affected macros before importing.");
    this.name = "MacroMutationBusyError";
  }
}

export class MacroManager extends EventEmitter<MacroManagerEvents> {
  private readonly terminalStatuses = new Map<string, MacroRunStatus>();
  private readonly macroMutationTails = new Map<string, Promise<void>>();
  private readonly runs = new Map<string, MacroRun>();

  constructor(
    private readonly browserManager: Pick<BrowserManager, "getAutomationSession"> &
      Partial<Pick<BrowserManager, "setMacroActiveRoleIds">>,
    private readonly macroStore: Pick<MacroStore, "getMacro">
  ) {
    super();
  }

  listStatuses(): MacroRunStatus[] {
    const activeRunKeys = new Set(this.runs.keys());
    return [
      ...[...this.runs.values()].map((run) => run.status),
      ...[...this.terminalStatuses.entries()]
        .filter(([key]) => !activeRunKeys.has(key))
        .map(([, status]) => status)
    ];
  }

  start(macroId: string): Promise<MacroRunStatus[]> {
    return this.withMacroMutationLock(macroId, () => this.startUnlocked(macroId));
  }

  startForRole(macroId: string, roleId: string): Promise<MacroRunStatus[]> {
    return this.withMacroMutationLock(macroId, () => this.startUnlocked(macroId, roleId));
  }

  stop(macroId: string): Promise<void> {
    return this.withMacroMutationLock(macroId, () => this.stopMacroRunsUnlocked(macroId, true));
  }

  stopForRole(macroId: string, roleId: string): Promise<void> {
    return this.withMacroMutationLock(macroId, async () => {
      const macro = await this.macroStore.getMacro(macroId);
      this.assertMacroAssignedToRole(macro, roleId);
      await this.stopMacroRunsUnlocked(macroId, true);
    });
  }

  runStoppedMutation<T>(macroId: string, operation: () => Promise<T>): Promise<T> {
    return this.withMacroMutationLock(macroId, async () => {
      if (this.hasActiveMacroRun(macroId)) {
        throw new Error("Stop the macro before editing it.");
      }

      const result = await operation();
      this.clearTerminalStatuses((status) => status.macroId === macroId);
      return result;
    });
  }

  runStoppedMutations<T>(macroIds: string[], operation: () => Promise<T>): Promise<T> {
    const ids = [...new Set(macroIds)].sort();
    const acquire = (index: number): Promise<T> => {
      const macroId = ids[index];
      if (!macroId) {
        return operation();
      }
      return this.withMacroMutationLock(macroId, async () => {
        if (this.hasActiveMacroRun(macroId)) {
          throw new MacroMutationBusyError();
        }
        return acquire(index + 1);
      });
    };
    return acquire(0);
  }

  stopAndRunMutation<T>(macroId: string, operation: () => Promise<T>): Promise<T> {
    return this.withMacroMutationLock(macroId, async () => {
      await this.stopMacroRunsUnlocked(macroId, true);
      return operation();
    });
  }

  async stopRole(roleId: string): Promise<void> {
    const macroIds = new Set<string>();
    this.runs.forEach((run) => {
      if (run.status.roleId === roleId) {
        macroIds.add(run.status.macroId);
      }
    });
    this.terminalStatuses.forEach((status) => {
      if (status.roleId === roleId) {
        macroIds.add(status.macroId);
      }
    });

    await Promise.all(
      [...macroIds].map((macroId) =>
        this.withMacroMutationLock(macroId, () => this.stopMacroRunsUnlocked(macroId, true))
      )
    );
  }

  private async startUnlocked(macroId: string, requestingRoleId?: string): Promise<MacroRunStatus[]> {
    const macro = await this.macroStore.getMacro(macroId);
    if (requestingRoleId) {
      this.assertMacroAssignedToRole(macro, requestingRoleId);
    }
    const sessions = macro.roleIds.flatMap((roleId) => {
      const key = createRunKey(roleId, macroId);
      if (this.runs.has(key)) {
        throw new Error("Macro is already running for this role.");
      }

      const session = this.browserManager.getAutomationSession(roleId);
      if (!session) {
        return [];
      }

      return [{ key, roleId, target: session.target }];
    });

    if (sessions.length === 0) {
      throw new Error("Launch at least one assigned role before running a macro.");
    }

    this.clearTerminalStatuses((status) => status.macroId === macroId, false);
    const now = new Date().toISOString();
    const runItems = sessions.map(({ key, roleId, target }) => {
      let resolveCompletion: () => void = () => undefined;
      const completion = new Promise<void>((resolve) => {
        resolveCompletion = resolve;
      });
      const run: MacroRun = {
        abortController: new AbortController(),
        completion,
        isCancelled: false,
        resolveCompletion,
        status: {
          roleId,
          macroId,
          state: "running" as const,
          startedAt: now,
          updatedAt: now
        }
      };
      return { key, run, target };
    });

    runItems.forEach(({ key, run }) => this.runs.set(key, run));
    await this.syncResourceOverrides();
    this.emitChange();

    runItems.forEach(({ key, run, target }) => {
      void this.runMacro(key, run, macro, target)
        .catch((error) => {
          if (!(error instanceof MacroRunCancelledError) && !run.isCancelled) {
            this.handleRunFailure(key, run, error);
          }
        })
        .finally(async () => {
          if (this.runs.get(key) === run) {
            this.runs.delete(key);
          }
          if (run.terminalStatus) {
            this.terminalStatuses.set(key, run.terminalStatus);
          }
          await this.syncResourceOverrides();
          run.resolveCompletion();
          this.emitChange();
        });
    });

    return runItems.map(({ run }) => run.status);
  }

  private async stopMacroRunsUnlocked(macroId: string, clearFailures: boolean): Promise<void> {
    const runs = [...this.runs.values()].filter((run) => run.status.macroId === macroId);
    this.cancelRuns(runs);
    await Promise.all(runs.map((run) => run.completion));

    if (clearFailures) {
      this.clearTerminalStatuses((status) => status.macroId === macroId);
    }
  }

  private cancelRuns(
    runs: MacroRun[],
    terminal?: Pick<MacroRunStatus, "state" | "error">
  ): void {
    let didChange = false;
    const now = new Date().toISOString();
    runs.forEach((run) => {
      if (run.isCancelled) {
        return;
      }
      run.isCancelled = true;
      if (terminal) {
        run.terminalStatus = {
          ...run.status,
          ...terminal,
          updatedAt: now
        };
      }
      run.status = { ...run.status, state: "stopping", updatedAt: now };
      run.abortController.abort();
      run.cancelActiveOperation?.();
      run.cancelDelay?.();
      didChange = true;
    });

    if (didChange) {
      this.emitChange();
    }
  }

  private handleRunFailure(key: string, run: MacroRun, error: unknown): void {
    const now = new Date().toISOString();
    const failureStatus: MacroRunStatus = {
      ...run.status,
      state: "failed",
      updatedAt: now,
      error: error instanceof Error ? error.message : "Macro execution failed."
    };
    run.status = failureStatus;
    run.terminalStatus = failureStatus;

    const siblingRuns = [...this.runs.entries()]
      .filter(([siblingKey, sibling]) => siblingKey !== key && sibling.status.macroId === run.status.macroId)
      .map(([, sibling]) => sibling);
    this.cancelRuns(siblingRuns, { state: "cancelled", error: SIBLING_FAILURE_MESSAGE });
    this.emitChange();
    console.warn("Macro execution failed.", error);
  }

  private hasActiveMacroRun(macroId: string): boolean {
    return [...this.runs.values()].some((run) => run.status.macroId === macroId);
  }

  private async syncResourceOverrides(): Promise<void> {
    await this.browserManager.setMacroActiveRoleIds?.(
      [...this.runs.values()]
        .filter((run) => run.status.state === "running" || run.status.state === "stopping")
        .map((run) => run.status.roleId)
    );
  }

  private assertMacroAssignedToRole(macro: Macro, roleId: string): void {
    if (!macro.roleIds.includes(roleId)) {
      throw new Error("This macro is not assigned to the current role.");
    }
  }

  private clearTerminalStatuses(
    predicate: (status: MacroRunStatus) => boolean,
    emitChange = true
  ): void {
    let didChange = false;
    this.terminalStatuses.forEach((status, key) => {
      if (predicate(status)) {
        this.terminalStatuses.delete(key);
        didChange = true;
      }
    });

    if (didChange && emitChange) {
      this.emitChange();
    }
  }

  private async runMacro(
    runKey: string,
    run: MacroRun,
    macro: Macro,
    target: BrowserAutomationTarget
  ): Promise<void> {
    do {
      for (const step of macro.steps) {
        this.throwIfCancelled(run);
        await this.executeStep(run, target, step);
      }

      if (macro.repeat.type !== "loop") {
        break;
      }

      await this.delay(run, Math.max(1, macro.repeat.intervalMs));
    } while (!run.isCancelled && this.runs.get(runKey) === run);
  }

  private async executeStep(
    run: MacroRun,
    target: BrowserAutomationTarget,
    step: MacroStep
  ): Promise<void> {
    switch (step.type) {
      case "key":
        await this.executeTargetOperation(run, () => target.dispatchKey(step.code, run.abortController.signal));
        return;
      case "click":
        await this.executeTargetOperation(
          run,
          () => target.dispatchClick(step.xPercent, step.yPercent, run.abortController.signal)
        );
        return;
      case "delay":
        await this.delay(run, step.ms);
        return;
    }
  }

  private async executeTargetOperation(run: MacroRun, operation: () => Promise<void>): Promise<void> {
    this.throwIfCancelled(run);
    let rejectInterruption: (error: Error) => void = () => undefined;
    const interruption = new Promise<never>((_resolve, reject) => {
      rejectInterruption = reject;
    });
    const timeout = setTimeout(() => {
      run.abortController.abort();
      rejectInterruption(new Error(`Macro input timed out after ${MACRO_TARGET_OPERATION_TIMEOUT_MS} ms.`));
    }, MACRO_TARGET_OPERATION_TIMEOUT_MS);
    const cancelActiveOperation = () => rejectInterruption(new MacroRunCancelledError());
    run.cancelActiveOperation = cancelActiveOperation;

    try {
      await Promise.race([Promise.resolve().then(operation), interruption]);
    } finally {
      clearTimeout(timeout);
      if (run.cancelActiveOperation === cancelActiveOperation) {
        run.cancelActiveOperation = undefined;
      }
    }
    this.throwIfCancelled(run);
  }

  private async delay(run: MacroRun, ms: number): Promise<void> {
    this.throwIfCancelled(run);
    if (ms === 0) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        run.cancelDelay = undefined;
        resolve();
      }, ms);

      run.cancelDelay = () => {
        clearTimeout(timer);
        run.cancelDelay = undefined;
        reject(new MacroRunCancelledError());
      };
    });
    this.throwIfCancelled(run);
  }

  private throwIfCancelled(run: MacroRun): void {
    if (run.isCancelled) {
      throw new MacroRunCancelledError();
    }
  }

  private withMacroMutationLock<T>(macroId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.macroMutationTails.get(macroId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(() => undefined, () => undefined);
    this.macroMutationTails.set(macroId, tail);
    void tail.finally(() => {
      if (this.macroMutationTails.get(macroId) === tail) {
        this.macroMutationTails.delete(macroId);
      }
    });
    return result;
  }

  private emitChange(): void {
    this.emit("change", this.listStatuses());
  }
}

function createRunKey(roleId: string, macroId: string): string {
  return `${roleId}:${macroId}`;
}
