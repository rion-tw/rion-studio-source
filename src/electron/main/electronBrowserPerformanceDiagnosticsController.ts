import type { BrowserPerformanceDiagnosticOperation } from "../../shared/types";
import { RionBridgeError } from "../ipc/errors";

type ActivePhase = "sampling" | "waitingForFocus";

interface ActiveOperation {
  operationId: string;
  phase: BrowserPerformanceDiagnosticOperation["phase"];
  revision: number;
}

export interface ElectronBrowserPerformanceDiagnosticsControllerInput {
  publish: (operation: BrowserPerformanceDiagnosticOperation) => void;
}

function copyOperation(
  operation: ActiveOperation
): BrowserPerformanceDiagnosticOperation {
  return {
    operationId: operation.operationId,
    phase: operation.phase,
    revision: operation.revision
  };
}

function isActivePhase(
  phase: BrowserPerformanceDiagnosticOperation["phase"]
): phase is ActivePhase {
  return phase === "waitingForFocus" || phase === "sampling";
}

export class ElectronBrowserPerformanceDiagnosticsController {
  readonly #input: ElectronBrowserPerformanceDiagnosticsControllerInput;
  #current: ActiveOperation | null = null;
  #sequence = 0;

  constructor(input: ElectronBrowserPerformanceDiagnosticsControllerInput) {
    this.#input = input;
  }

  begin(): BrowserPerformanceDiagnosticOperation {
    if (this.#current && isActivePhase(this.#current.phase)) {
      this.#current.phase = "cancelled";
      this.#current.revision += 1;
      this.#input.publish(copyOperation(this.#current));
    }

    this.#sequence += 1;
    this.#current = {
      operationId: `performance-diagnostic-${this.#sequence}`,
      phase: "waitingForFocus",
      revision: this.#sequence
    };
    const accepted = copyOperation(this.#current);
    this.#input.publish(accepted);
    return accepted;
  }

  cancel(operationId: string): void {
    if (!this.#current || this.#current.operationId !== operationId) {
      throw new RionBridgeError({
        code: "ELECTRON_PERFORMANCE_DIAGNOSTIC_NOT_FOUND",
        message: "The browser performance diagnostic operation was not found."
      });
    }
    if (!isActivePhase(this.#current.phase)) return;

    this.#current.phase = "cancelled";
    this.#current.revision += 1;
    this.#input.publish(copyOperation(this.#current));
  }
}
