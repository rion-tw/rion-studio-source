import { EventEmitter } from "node:events";

import { findUnassignedMacroDependency } from "../../shared/macroDependencies";
import { DEFAULT_MACRO_SETTINGS } from "../../shared/macroSettings";
import type { Macro, MacroRunStatus, MacroSettings, MacroStep } from "../../shared/types";
import type { MacroKeyInput } from "../../shared/macroKeys";
import type { BrowserManager } from "../browser/BrowserManager";
import type { BrowserAutomationTarget } from "../browser/ElectronAutomationTarget";
import type { MacroStore } from "./MacroStore";
import type { MacroSettingsStore } from "./MacroSettingsStore";

export interface MacroManagerEvents {
  change: [MacroRunStatus[]];
}

interface MacroRun {
  abortController: AbortController;
  cancelActiveOperation?: () => void;
  cancelDelay?: () => void;
  cancelHoldWait?: () => void;
  completion: Promise<void>;
  heldKeySteps: Map<string, { input: MacroKeyInput | string; ownerId: string }>;
  inputOwnerId: string;
  invocationId: string;
  isCancelled: boolean;
  resolveCompletion: () => void;
  status: MacroRunStatus;
  terminalStatus?: MacroRunStatus;
}

type MacroInvocationOutcome =
  | { state: "completed" }
  | { state: "failed"; error: Error }
  | { state: "cancelled"; error: Error };

type MacroInvocationMode = "configured" | "single_iteration";

interface MacroStepBarrier {
  arrivedRunKeys: Set<string>;
  promise: Promise<void>;
  reject: (error: Error) => void;
  resolve: () => void;
  started: boolean;
}

interface MacroInvocation {
  appliesConfiguredTiming: boolean;
  ancestry: string[];
  barriers: Map<string, MacroStepBarrier>;
  childStartCompletions: Set<Promise<void>>;
  childInvocationIds: Set<string>;
  completion: Promise<MacroInvocationOutcome>;
  firstIterationCompleted: boolean;
  firstIterationCompletion: Promise<void>;
  firstIterationRunKeys: Set<string>;
  id: string;
  macroId: string;
  outcome?: MacroInvocationOutcome;
  remainingRunKeys: Set<string>;
  resolveCompletion: (outcome: MacroInvocationOutcome) => void;
  resolveFirstIterationCompletion: () => void;
  runKeys: Set<string>;
  settings: MacroSettings;
  stopAfterFirstIteration: boolean;
}

interface StartedMacroInvocation {
  invocation: MacroInvocation;
  statuses: MacroRunStatus[];
}

interface HeldTriggerLease {
  invocationId: string;
  macroId: string;
  pressId: string;
  sourceRoleId: string;
}

export type HeldTriggerReleaseMode = "complete_first_iteration" | "immediate";

const MACRO_TARGET_OPERATION_TIMEOUT_MS = 10_000;
const SIBLING_FAILURE_MESSAGE = "Cancelled because another assigned role failed.";
const CHILD_CANCELLED_MESSAGE = "Cancelled because a called macro was stopped.";
const UNASSIGNED_WORKFLOW_MESSAGE =
  "Assign a role to this macro and every called macro before running it.";

class MacroRunCancelledError extends Error {
  constructor(message = "Macro run cancelled.") {
    super(message);
    this.name = "MacroRunCancelledError";
  }
}

class ChildMacroCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChildMacroCancelledError";
  }
}

export class MacroMutationBusyError extends Error {
  constructor() {
    super("Stop affected macros before importing.");
    this.name = "MacroMutationBusyError";
  }
}

export class MacroManager extends EventEmitter<MacroManagerEvents> {
  private readonly heldTriggerLeases = new Map<string, HeldTriggerLease>();
  private readonly invocations = new Map<string, MacroInvocation>();
  private readonly macroMutationTails = new Map<string, Promise<void>>();
  private readonly roleInputPreparationTails = new Map<string, Promise<void>>();
  private readonly runs = new Map<string, MacroRun>();
  private readonly terminalStatuses = new Map<string, MacroRunStatus>();
  private readonly releasedPressIds = new Map<string, HeldTriggerReleaseMode>();
  private nextInvocationId = 1;

  constructor(
    private readonly browserManager: Pick<BrowserManager, "getAutomationSession"> &
      Partial<Pick<BrowserManager, "setMacroActiveRoleIds">>,
    private readonly macroStore: Pick<MacroStore, "getMacro" | "listMacros">,
    private readonly macroSettingsStore: Pick<MacroSettingsStore, "getSettings"> = {
      getSettings: async () => ({ ...DEFAULT_MACRO_SETTINGS })
    }
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
    return this.withMacroMutationLock(macroId, async () =>
      (await this.startInvocationUnlocked(macroId)).statuses
    );
  }

  startForRole(macroId: string, roleId: string): Promise<MacroRunStatus[]> {
    return this.withMacroMutationLock(macroId, async () =>
      (await this.startInvocationUnlocked(macroId, roleId)).statuses
    );
  }

  pressForRole(macroId: string, roleId: string, pressId: string): Promise<MacroRunStatus[]> {
    return this.withMacroMutationLock(macroId, async () => {
      this.assertPressId(pressId);
      const releasedKey = createHeldTriggerLeaseKey(roleId, macroId, pressId);
      const earlyReleaseMode = this.releasedPressIds.get(releasedKey);
      this.releasedPressIds.delete(releasedKey);
      if (earlyReleaseMode === "immediate") {
        return [];
      }

      const sourceKey = createHeldTriggerSourceKey(roleId, macroId);
      const existing = this.heldTriggerLeases.get(sourceKey);
      if (existing) {
        if (existing.pressId === pressId) {
          return this.listStatuses().filter((status) => status.macroId === macroId);
        }
        throw new Error("Macro shortcut is already held for this role.");
      }

      const macro = await this.macroStore.getMacro(macroId);
      this.assertMacroAssignedToRole(macro, roleId);
      if ((macro.activationMode ?? "toggle") !== "while_held") {
        throw new Error("This macro does not use tap-or-hold activation.");
      }

      const started = await this.startInvocationUnlocked(macroId, roleId);
      this.heldTriggerLeases.set(sourceKey, {
        invocationId: started.invocation.id,
        macroId,
        pressId,
        sourceRoleId: roleId
      });
      if (earlyReleaseMode === "complete_first_iteration") {
        started.invocation.stopAfterFirstIteration = true;
      }
      return started.statuses;
    });
  }

  async releaseForRole(
    macroId: string,
    roleId: string,
    pressId: string,
    mode: HeldTriggerReleaseMode = "complete_first_iteration"
  ): Promise<void> {
    let completion: Promise<MacroInvocationOutcome> | undefined;
    await this.withMacroMutationLock(macroId, async () => {
      this.assertPressId(pressId);
      const sourceKey = createHeldTriggerSourceKey(roleId, macroId);
      const lease = this.heldTriggerLeases.get(sourceKey);
      if (!lease || lease.pressId !== pressId) {
        this.rememberReleasedPressId(
          createHeldTriggerLeaseKey(roleId, macroId, pressId),
          mode
        );
        return;
      }

      const invocation = this.invocations.get(lease.invocationId);
      if (!invocation) {
        this.heldTriggerLeases.delete(sourceKey);
        return;
      }

      if (mode === "immediate" || invocation.firstIterationCompleted) {
        this.heldTriggerLeases.delete(sourceKey);
        await this.cancelInvocationAndWait(invocation);
        return;
      }

      invocation.stopAfterFirstIteration = true;
      completion = invocation.completion;
    });

    await completion;
  }

  async releaseHeldTriggersForRole(roleId: string): Promise<void> {
    const leases = [...this.heldTriggerLeases.values()].filter(
      (lease) => lease.sourceRoleId === roleId
    );
    await Promise.all(
      leases.map((lease) =>
        this.releaseForRole(lease.macroId, roleId, lease.pressId, "immediate")
      )
    );
  }

  stop(macroId: string): Promise<void> {
    return this.withMacroMutationLock(macroId, async () => {
      this.clearHeldTriggerLeases((lease) => lease.macroId === macroId);
      await this.stopMacroRunsUnlocked(macroId, true);
    });
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
    return this.withMacroMutationLocks(macroIds, async () => {
      if (macroIds.some((macroId) => this.hasActiveMacroRun(macroId))) {
        throw new MacroMutationBusyError();
      }
      return operation();
    });
  }

  stopAndRunMutation<T>(macroId: string, operation: () => Promise<T>): Promise<T> {
    return this.withMacroMutationLock(macroId, async () => {
      await this.stopMacroRunsUnlocked(macroId, true);
      return operation();
    });
  }

  stopAndRunMutations<T>(macroIds: string[], operation: () => Promise<T>): Promise<T> {
    return this.withMacroMutationLocks(macroIds, async () => {
      for (const macroId of macroIds) {
        await this.stopMacroRunsUnlocked(macroId, true);
      }
      return operation();
    });
  }

  async stopRole(roleId: string): Promise<void> {
    const invocationIds = new Set<string>();
    this.runs.forEach((run) => {
      if (run.status.roleId === roleId) {
        invocationIds.add(run.invocationId);
      }
    });

    await Promise.all(
      [...invocationIds].map((invocationId) => {
        const invocation = this.invocations.get(invocationId);
        return invocation ? this.cancelInvocationAndWait(invocation) : Promise.resolve();
      })
    );
    this.clearTerminalStatuses((status) => status.roleId === roleId);
  }

  private async startInvocationUnlocked(
    macroId: string,
    requestingRoleId?: string,
    parentAncestry: string[] = [],
    inheritedSettings?: MacroSettings,
    invocationMode: MacroInvocationMode = "configured"
  ): Promise<StartedMacroInvocation> {
    if (parentAncestry.includes(macroId)) {
      throw new Error("Macro dependency cycle detected while running a called macro.");
    }

    const [macro, settings] = await Promise.all([
      this.macroStore.getMacro(macroId),
      inheritedSettings ?? this.macroSettingsStore.getSettings()
    ]);
    if (requestingRoleId) {
      this.assertMacroAssignedToRole(macro, requestingRoleId);
    }
    if (!macro.enabled) {
      throw new Error("Enable this macro before running it.");
    }
    if (parentAncestry.length === 0) {
      const macros = await this.macroStore.listMacros();
      if (findUnassignedMacroDependency(macros, macroId)) {
        throw new Error(UNASSIGNED_WORKFLOW_MESSAGE);
      }
    }
    if (parentAncestry.length > 0 && this.hasActiveMacroRun(macroId)) {
      throw new Error(`Called macro "${macro.name}" is already running.`);
    }

    const sessions = macro.roleIds.flatMap((roleId) => {
      const key = createRunKey(roleId, macroId);
      if (this.runs.has(key)) {
        throw new Error("Macro is already running for this role.");
      }

      const session = this.browserManager.getAutomationSession(roleId);
      return session ? [{ key, roleId, target: session.target }] : [];
    });

    if (sessions.length === 0) {
      throw new Error("Launch at least one assigned role before running a macro.");
    }

    await Promise.all(sessions.map(({ roleId, target }) => this.prepareRoleInput(roleId, target)));

    this.clearTerminalStatuses((status) => status.macroId === macroId, false);
    const invocation = this.createInvocation(
      macroId,
      sessions.map(({ key }) => key),
      [...parentAncestry, macroId],
      settings,
      Boolean(macro.trigger),
      invocationMode
    );
    const now = new Date().toISOString();
    const runItems = sessions.map(({ key, roleId, target }) => {
      let resolveCompletion: () => void = () => undefined;
      const completion = new Promise<void>((resolve) => {
        resolveCompletion = resolve;
      });
      const run: MacroRun = {
        abortController: new AbortController(),
        completion,
        heldKeySteps: new Map(),
        inputOwnerId: `${invocation.id}:${roleId}`,
        invocationId: invocation.id,
        isCancelled: false,
        resolveCompletion,
        status: {
          roleId,
          macroId,
          state: "running",
          iteration: 0,
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
      void this.runMacro(key, run, invocation, macro, target)
        .catch((error) => {
          if (error instanceof ChildMacroCancelledError && !run.isCancelled) {
            this.handleRunCancellation(key, run, error);
          } else if (!(error instanceof MacroRunCancelledError) && !run.isCancelled) {
            this.handleRunFailure(key, run, error);
          }
        })
        .finally(async () => {
          await this.releaseHeldKeys(run, target);
          if (this.runs.get(key) === run) {
            this.runs.delete(key);
          }
          if (run.terminalStatus) {
            this.terminalStatuses.set(key, run.terminalStatus);
          }
          await this.syncResourceOverrides();
          run.resolveCompletion();
          this.finishInvocationRun(invocation, key);
          this.emitChange();
        });
    });

    return { invocation, statuses: runItems.map(({ run }) => run.status) };
  }

  private createInvocation(
    macroId: string,
    runKeys: string[],
    ancestry: string[],
    settings: MacroSettings,
    appliesConfiguredTiming: boolean,
    mode: MacroInvocationMode
  ): MacroInvocation {
    let resolveCompletion: (outcome: MacroInvocationOutcome) => void = () => undefined;
    const completion = new Promise<MacroInvocationOutcome>((resolve) => {
      resolveCompletion = resolve;
    });
    let resolveFirstIterationCompletion: () => void = () => undefined;
    const firstIterationCompletion = new Promise<void>((resolve) => {
      resolveFirstIterationCompletion = resolve;
    });
    const invocation: MacroInvocation = {
      appliesConfiguredTiming,
      ancestry,
      barriers: new Map(),
      childStartCompletions: new Set(),
      childInvocationIds: new Set(),
      completion,
      firstIterationCompleted: false,
      firstIterationCompletion,
      firstIterationRunKeys: new Set(),
      id: `macro-invocation-${this.nextInvocationId++}`,
      macroId,
      remainingRunKeys: new Set(runKeys),
      resolveCompletion,
      resolveFirstIterationCompletion,
      runKeys: new Set(runKeys),
      settings: { ...settings },
      stopAfterFirstIteration: mode === "single_iteration"
    };
    this.invocations.set(invocation.id, invocation);
    return invocation;
  }

  private async prepareRoleInput(roleId: string, target: BrowserAutomationTarget): Promise<void> {
    const previous = this.roleInputPreparationTails.get(roleId) ?? Promise.resolve();
    const preparation = previous
      .catch(() => undefined)
      .then(async () => {
        await target.ensureInputFocus();
      });
    this.roleInputPreparationTails.set(roleId, preparation);

    try {
      await preparation;
    } finally {
      if (this.roleInputPreparationTails.get(roleId) === preparation) {
        this.roleInputPreparationTails.delete(roleId);
      }
    }
  }

  private async stopMacroRunsUnlocked(macroId: string, clearFailures: boolean): Promise<void> {
    const invocationIds = new Set(
      [...this.runs.values()]
        .filter((run) => run.status.macroId === macroId)
        .map((run) => run.invocationId)
    );
    const invocations = [...invocationIds]
      .map((id) => this.invocations.get(id))
      .filter((invocation): invocation is MacroInvocation => Boolean(invocation));
    await Promise.all(invocations.map((invocation) => this.cancelInvocationAndWait(invocation)));

    if (clearFailures) {
      this.clearTerminalStatuses((status) => status.macroId === macroId);
    }
  }

  private async cancelInvocationAndWait(
    invocation: MacroInvocation,
    terminal?: Pick<MacroRunStatus, "state" | "error">
  ): Promise<void> {
    this.settleInvocation(invocation, {
      state: "cancelled",
      error: new MacroRunCancelledError(terminal?.error)
    });
    const barriers = [...invocation.barriers.values()];
    barriers.forEach((barrier) => barrier.reject(new MacroRunCancelledError(terminal?.error)));

    const runs = [...invocation.runKeys]
      .map((key) => this.runs.get(key))
      .filter((run): run is MacroRun => run?.invocationId === invocation.id);
    this.cancelRuns(runs, terminal);

    await Promise.all(invocation.childStartCompletions);
    const children = [...invocation.childInvocationIds]
      .map((id) => this.invocations.get(id))
      .filter((child): child is MacroInvocation => Boolean(child));
    await Promise.all([
      ...runs.map((run) => run.completion),
      ...children.map((child) => this.cancelInvocationAndWait(child))
    ]);
  }

  private cancelRuns(
    runs: MacroRun[],
    terminal?: Pick<MacroRunStatus, "state" | "error">
  ): void {
    let didChange = false;
    const now = new Date().toISOString();
    runs.forEach((run) => {
      if (run.isCancelled) return;
      run.isCancelled = true;
      if (terminal) {
        run.terminalStatus = { ...run.status, ...terminal, updatedAt: now };
      }
      run.status = { ...run.status, state: "stopping", updatedAt: now };
      run.abortController.abort();
      run.cancelActiveOperation?.();
      run.cancelDelay?.();
      run.cancelHoldWait?.();
      didChange = true;
    });
    if (didChange) this.emitChange();
  }

  private handleRunFailure(key: string, run: MacroRun, error: unknown): void {
    const failureError = error instanceof Error ? error : new Error("Macro execution failed.");
    const now = new Date().toISOString();
    const failureStatus: MacroRunStatus = {
      ...run.status,
      state: "failed",
      updatedAt: now,
      error: failureError.message
    };
    run.status = failureStatus;
    run.terminalStatus = failureStatus;

    const invocation = this.invocations.get(run.invocationId);
    if (invocation) {
      this.settleInvocation(invocation, { state: "failed", error: failureError });
      invocation.barriers.forEach((barrier) => barrier.reject(failureError));
      this.cancelInvocationSiblings(key, invocation, {
        state: "cancelled",
        error: SIBLING_FAILURE_MESSAGE
      });
      void this.cancelOwnedChildInvocations(invocation);
    }
    this.emitChange();
    console.warn("Macro execution failed.", error);
  }

  private handleRunCancellation(key: string, run: MacroRun, error: ChildMacroCancelledError): void {
    const terminal = { state: "cancelled" as const, error: error.message };
    run.status = { ...run.status, ...terminal, updatedAt: new Date().toISOString() };
    run.terminalStatus = run.status;

    const invocation = this.invocations.get(run.invocationId);
    if (invocation) {
      this.settleInvocation(invocation, { state: "cancelled", error });
      invocation.barriers.forEach((barrier) => barrier.reject(error));
      this.cancelInvocationSiblings(key, invocation, terminal);
      void this.cancelOwnedChildInvocations(invocation);
    }
    this.emitChange();
  }

  private cancelInvocationSiblings(
    runKey: string,
    invocation: MacroInvocation,
    terminal: Pick<MacroRunStatus, "state" | "error">
  ): void {
    const siblings = [...invocation.runKeys]
      .filter((key) => key !== runKey)
      .map((key) => this.runs.get(key))
      .filter((run): run is MacroRun => run?.invocationId === invocation.id);
    this.cancelRuns(siblings, terminal);
  }

  private async cancelOwnedChildInvocations(invocation: MacroInvocation): Promise<void> {
    await Promise.all(invocation.childStartCompletions);
    const children = [...invocation.childInvocationIds]
      .map((id) => this.invocations.get(id))
      .filter((child): child is MacroInvocation => Boolean(child));
    await Promise.all(children.map((child) => this.cancelInvocationAndWait(child)));
  }

  private settleInvocation(invocation: MacroInvocation, outcome: MacroInvocationOutcome): void {
    if (invocation.outcome) return;
    invocation.outcome = outcome;
    invocation.resolveFirstIterationCompletion();
    invocation.resolveCompletion(outcome);
  }

  private finishInvocationRun(invocation: MacroInvocation, runKey: string): void {
    invocation.remainingRunKeys.delete(runKey);
    if (invocation.remainingRunKeys.size === 0) {
      this.clearHeldTriggerLeases((lease) => lease.invocationId === invocation.id);
      const completedNaturally = invocation.outcome === undefined;
      this.settleInvocation(invocation, { state: "completed" });
      if (completedNaturally) {
        invocation.childInvocationIds.clear();
      }
      this.invocations.delete(invocation.id);
    }
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
    if (didChange && emitChange) this.emitChange();
  }

  private async runMacro(
    runKey: string,
    run: MacroRun,
    invocation: MacroInvocation,
    macro: Macro,
    target: BrowserAutomationTarget
  ): Promise<void> {
    if (invocation.appliesConfiguredTiming) {
      await this.delay(run, invocation.settings.startupDelayMs);
    }
    let iteration = 0;
    do {
      for (const step of macro.steps) {
        this.throwIfCancelled(run);
        await this.executeStep(runKey, run, invocation, iteration, target, step);
      }
      iteration += 1;
      run.status = {
        ...run.status,
        iteration,
        updatedAt: new Date().toISOString()
      };
      this.emitChange();

      if (iteration === 1) {
        this.completeFirstIteration(invocation, runKey);
        await invocation.firstIterationCompletion;
        this.throwIfCancelled(run);
        if (invocation.stopAfterFirstIteration) break;
      }

      if (macro.repeat.type !== "loop") break;
      await this.delay(run, macro.repeat.intervalMs);
    } while (!run.isCancelled && this.runs.get(runKey) === run);

    if (
      macro.repeat.type === "once" &&
      run.heldKeySteps.size > 0 &&
      !invocation.stopAfterFirstIteration
    ) {
      await this.waitForStop(run);
    }
  }

  private completeFirstIteration(invocation: MacroInvocation, runKey: string): void {
    if (invocation.firstIterationCompleted) return;
    invocation.firstIterationRunKeys.add(runKey);
    if (invocation.firstIterationRunKeys.size === invocation.runKeys.size) {
      invocation.firstIterationCompleted = true;
      invocation.resolveFirstIterationCompletion();
    }
  }

  private async executeStep(
    runKey: string,
    run: MacroRun,
    invocation: MacroInvocation,
    iteration: number,
    target: BrowserAutomationTarget,
    step: MacroStep
  ): Promise<void> {
    switch (step.type) {
      case "key": {
        const input: MacroKeyInput | string = step.modifiers?.length
          ? { code: step.code, modifiers: [...step.modifiers] }
          : step.code;
        if (step.action === "hold_until_stop") {
          if (run.heldKeySteps.has(step.id)) return;
          const ownerId = `${run.inputOwnerId}:${step.id}`;
          run.heldKeySteps.set(step.id, { input, ownerId });
          try {
            await this.executeTargetOperation(run, () =>
              target.holdKey(input, ownerId, {
                ...(invocation.appliesConfiguredTiming
                  ? { postDelayMs: invocation.settings.postInputDelayMs }
                  : {}),
                signal: run.abortController.signal
              })
            );
          } catch (error) {
            await target.releaseKey(input, ownerId).catch(() => undefined);
            run.heldKeySteps.delete(step.id);
            throw error;
          }
          return;
        }
        await this.executeTargetOperation(run, () =>
          target.dispatchKey(input, {
            ...(invocation.appliesConfiguredTiming
              ? {
                  holdMs: invocation.settings.keyHoldMs,
                  postDelayMs: invocation.settings.postInputDelayMs
                }
              : {}),
            signal: run.abortController.signal
          })
        );
        return;
      }
      case "click":
        await this.executeTargetOperation(run, () => {
          const options = {
            ...(invocation.appliesConfiguredTiming
              ? { postDelayMs: invocation.settings.postInputDelayMs }
              : {}),
            onClick: () => this.markClickStep(run, step.id),
            signal: run.abortController.signal
          };
          if (target.dispatchClickAnchored) {
            return target.dispatchClickAnchored(
              step.anchor,
              step.unit === "px" ? "px" : "percent",
              step.unit === "px" ? step.xPx : step.xPercent,
              step.unit === "px" ? step.yPx : step.yPercent,
              options
            );
          }
          if (step.anchor && step.anchor !== "top-left") {
            throw new Error("Anchored click input is not supported by this browser target.");
          }
          if (step.unit === "px") {
            if (!target.dispatchClickPixels) {
              throw new Error("Pixel click input is not supported by this browser target.");
            }
            return target.dispatchClickPixels(step.xPx, step.yPx, options);
          }
          return target.dispatchClick(step.xPercent, step.yPercent, options);
        });
        return;
      case "delay":
        await this.delay(run, step.ms);
        return;
      case "macro":
        if (step.callMode === "trigger") {
          this.triggerCalledMacro(invocation, step.macroId);
          return;
        }
        await this.enterMacroBarrier(runKey, run, invocation, iteration, step);
    }
  }

  private markClickStep(run: MacroRun, stepId: string): void {
    run.status = {
      ...run.status,
      lastClick: {
        sequence: (run.status.lastClick?.sequence ?? 0) + 1,
        stepId
      },
      updatedAt: new Date().toISOString()
    };
    this.emitChange();
  }

  private async enterMacroBarrier(
    runKey: string,
    run: MacroRun,
    invocation: MacroInvocation,
    iteration: number,
    step: Extract<MacroStep, { type: "macro" }>
  ): Promise<void> {
    const barrierKey = `${iteration}:${step.id}`;
    let barrier = invocation.barriers.get(barrierKey);
    if (!barrier) {
      let resolve: () => void = () => undefined;
      let reject: (error: Error) => void = () => undefined;
      const promise = new Promise<void>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      barrier = { arrivedRunKeys: new Set(), promise, reject, resolve, started: false };
      invocation.barriers.set(barrierKey, barrier);
    }

    barrier.arrivedRunKeys.add(runKey);
    if (!barrier.started && barrier.arrivedRunKeys.size === invocation.runKeys.size) {
      barrier.started = true;
      void this.runCalledMacro(invocation, step.macroId)
        .then(barrier.resolve, barrier.reject)
        .finally(() => {
          if (invocation.barriers.get(barrierKey) === barrier) {
            invocation.barriers.delete(barrierKey);
          }
        });
    }

    await barrier.promise;
    this.throwIfCancelled(run);
  }

  private async runCalledMacro(parent: MacroInvocation, macroId: string): Promise<void> {
    let resolveChildStart: () => void = () => undefined;
    const childStartCompletion = new Promise<void>((resolve) => {
      resolveChildStart = resolve;
    });
    parent.childStartCompletions.add(childStartCompletion);

    let started: StartedMacroInvocation;
    try {
      started = await this.withMacroMutationLock(macroId, () =>
        this.startInvocationUnlocked(
          macroId,
          undefined,
          parent.ancestry,
          parent.settings,
          "single_iteration"
        )
      );
      parent.childInvocationIds.add(started.invocation.id);
    } finally {
      resolveChildStart();
      parent.childStartCompletions.delete(childStartCompletion);
    }

    if (parent.outcome) {
      await this.cancelInvocationAndWait(started.invocation);
      throw new MacroRunCancelledError();
    }

    const outcome = await started.invocation.completion;
    parent.childInvocationIds.delete(started.invocation.id);
    if (outcome.state === "failed") throw outcome.error;
    if (outcome.state === "cancelled") {
      throw new ChildMacroCancelledError(CHILD_CANCELLED_MESSAGE);
    }
  }

  private triggerCalledMacro(parent: MacroInvocation, macroId: string): void {
    let resolveChildStart: () => void = () => undefined;
    const childStartCompletion = new Promise<void>((resolve) => {
      resolveChildStart = resolve;
    });
    parent.childStartCompletions.add(childStartCompletion);

    const start = this.withMacroMutationLock(macroId, async () => {
      if (this.hasActiveMacroRun(macroId)) {
        return;
      }

      const started = await this.startInvocationUnlocked(
        macroId,
        undefined,
        parent.ancestry,
        undefined,
        "configured"
      );
      if (parent.outcome?.state === "completed") {
        return;
      }

      parent.childInvocationIds.add(started.invocation.id);
      void started.invocation.completion.then(() => {
        parent.childInvocationIds.delete(started.invocation.id);
      });
    });

    void start
      .catch((error) => {
        console.warn("Asynchronous macro trigger failed.", error);
      })
      .finally(() => {
        resolveChildStart();
        parent.childStartCompletions.delete(childStartCompletion);
      });
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

  private async waitForStop(run: MacroRun): Promise<void> {
    this.throwIfCancelled(run);
    await new Promise<void>((_resolve, reject) => {
      run.cancelHoldWait = () => {
        run.cancelHoldWait = undefined;
        reject(new MacroRunCancelledError());
      };
    });
  }

  private async releaseHeldKeys(run: MacroRun, target: BrowserAutomationTarget): Promise<void> {
    const heldKeys = [...run.heldKeySteps.values()].reverse();
    run.heldKeySteps.clear();
    for (const { input, ownerId } of heldKeys) {
      await target.releaseKey(input, ownerId).catch((error) => {
        const code = typeof input === "string" ? input : input.code;
        console.warn(`Failed to release held macro key ${code}.`, error);
      });
    }
  }

  private assertPressId(pressId: string): void {
    if (!pressId || pressId.length > 160) {
      throw new Error("Macro shortcut press id is invalid.");
    }
  }

  private rememberReleasedPressId(key: string, mode: HeldTriggerReleaseMode): void {
    const currentMode = this.releasedPressIds.get(key);
    this.releasedPressIds.set(
      key,
      currentMode === "immediate" || mode === "immediate" ? "immediate" : mode
    );
    while (this.releasedPressIds.size > 256) {
      const oldest = this.releasedPressIds.keys().next().value as string | undefined;
      if (!oldest) break;
      this.releasedPressIds.delete(oldest);
    }
  }

  private clearHeldTriggerLeases(predicate: (lease: HeldTriggerLease) => boolean): void {
    this.heldTriggerLeases.forEach((lease, key) => {
      if (predicate(lease)) {
        this.heldTriggerLeases.delete(key);
      }
    });
  }

  private throwIfCancelled(run: MacroRun): void {
    if (run.isCancelled) throw new MacroRunCancelledError();
  }

  private withMacroMutationLocks<T>(macroIds: string[], operation: () => Promise<T>): Promise<T> {
    const ids = [...new Set(macroIds)].sort();
    const acquire = (index: number): Promise<T> => {
      const macroId = ids[index];
      return macroId
        ? this.withMacroMutationLock(macroId, () => acquire(index + 1))
        : operation();
    };
    return acquire(0);
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

function createHeldTriggerSourceKey(roleId: string, macroId: string): string {
  return `${roleId}:${macroId}`;
}

function createHeldTriggerLeaseKey(roleId: string, macroId: string, pressId: string): string {
  return `${roleId}:${macroId}:${pressId}`;
}
