import { EventEmitter } from "node:events";

import type { Macro, MacroRunStatus, MacroStep } from "../../shared/types";
import type { BrowserManager } from "../browser/BrowserManager";
import type { BrowserAutomationTarget } from "../browser/ElectronAutomationTarget";
import type { MacroStore } from "./MacroStore";

export interface MacroManagerEvents {
  change: [MacroRunStatus[]];
}

interface MacroRun {
  cancelDelay?: () => void;
  isCancelled: boolean;
  status: MacroRunStatus;
}

class MacroRunCancelledError extends Error {
  constructor() {
    super("Macro run cancelled.");
    this.name = "MacroRunCancelledError";
  }
}

export class MacroManager extends EventEmitter<MacroManagerEvents> {
  private readonly runs = new Map<string, MacroRun>();

  constructor(
    private readonly browserManager: Pick<BrowserManager, "getAutomationSession">,
    private readonly macroStore: Pick<MacroStore, "getMacro">
  ) {
    super();
  }

  listStatuses(): MacroRunStatus[] {
    return [...this.runs.values()].map((run) => run.status);
  }

  async start(roleId: string, macroId: string): Promise<MacroRunStatus> {
    const key = createRunKey(roleId, macroId);

    if (this.runs.has(key)) {
      throw new Error("Macro is already running for this role.");
    }

    const macro = await this.macroStore.getMacro(macroId);
    if (macro.roleId !== roleId) {
      throw new Error("Macro is not assigned to this role.");
    }

    const session = this.browserManager.getAutomationSession(roleId);
    if (!session) {
      throw new Error("Launch this role before running a macro.");
    }

    const now = new Date().toISOString();
    const run: MacroRun = {
      isCancelled: false,
      status: {
        roleId,
        macroId,
        state: "running",
        startedAt: now,
        updatedAt: now
      }
    };

    this.runs.set(key, run);
    this.emitChange();

    void this.runMacro(key, run, macro, session.target)
      .catch((error) => {
        if (!(error instanceof MacroRunCancelledError)) {
          console.warn("Macro execution failed.", error);
        }
      })
      .finally(() => {
        if (this.runs.get(key) === run) {
          this.runs.delete(key);
          this.emitChange();
        }
      });

    return run.status;
  }

  async stop(roleId: string, macroId: string): Promise<void> {
    const run = this.runs.get(createRunKey(roleId, macroId));
    if (!run) {
      return;
    }

    run.isCancelled = true;
    run.status = {
      ...run.status,
      state: "stopping",
      updatedAt: new Date().toISOString()
    };
    run.cancelDelay?.();
    this.emitChange();
  }

  async stopRole(roleId: string): Promise<void> {
    await Promise.all(
      this.listStatuses()
        .filter((status) => status.roleId === roleId)
        .map((status) => this.stop(status.roleId, status.macroId))
    );
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

      await this.delay(run, macro.repeat.intervalMs);
    } while (!run.isCancelled && this.runs.get(runKey) === run);
  }

  private async executeStep(
    run: MacroRun,
    target: BrowserAutomationTarget,
    step: MacroStep
  ): Promise<void> {
    switch (step.type) {
      case "key":
        await target.dispatchKey(step.code);
        return;
      case "click":
        await target.dispatchClick(step.xPercent, step.yPercent);
        return;
      case "delay":
        await this.delay(run, step.ms);
        return;
    }
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

  private emitChange(): void {
    this.emit("change", this.listStatuses());
  }
}

function createRunKey(roleId: string, macroId: string): string {
  return `${roleId}:${macroId}`;
}
