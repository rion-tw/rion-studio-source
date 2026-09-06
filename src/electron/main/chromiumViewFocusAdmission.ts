import type { ChromiumViewAttachmentCoordinator } from "./chromiumViewAttachmentCoordinator";
import { validChromiumViewInputObservation } from "./chromiumViewTrustedInputValidation";
import type { ChromiumNativeTrustedInputRequest as Request,
  ChromiumNativeTrustedInputReceipt as Receipt } from "./chromiumTrustedInputCoordinator";
import type { WindowsChromiumTrustedInputDeadlinePort } from "./windowsChromiumTrustedInputAdapter";

type Target = NonNullable<ReturnType<ChromiumViewAttachmentCoordinator["resolveFocusTarget"]>>;

/** Core's focus admission fence; hidden Views never acquire focus. */
export class ChromiumViewFocusAdmission {
  readonly #pending = new Map<string, () => void>();
  #disposed = false;
  constructor(private readonly options: {
    attachments: ChromiumViewAttachmentCoordinator;
    deadlines: WindowsChromiumTrustedInputDeadlinePort;
    nowMs: () => number;
    activateParent: (target: Target) => void;
  }) {}

  focus(request: Request): Promise<Receipt> {
    const { attachments, nowMs, deadlines } = this.options;
    const receipt = (status: Receipt["status"], errorCode: string | null): Receipt => ({
      requestId: request.requestId, roleId: request.roleId, inputEpoch: request.inputEpoch,
      surfaceGeneration: request.surfaceGeneration, completedAtMs: nowMs(), status,
      errorCode, errorMessage: errorCode ? "The exact Chromium View did not acknowledge focus admission." : null,
      confirmedInputNeutrality: request.expectedInputNeutralityBefore
    });
    const target = attachments.resolveFocusTarget(request.roleId, request.surfaceGeneration);
    const now = nowMs();
    if (this.#disposed || !target || request.action.type !== "focus" ||
        !Number.isSafeInteger(request.scheduledAtMs) || request.scheduledAtMs < 1 ||
        !Number.isSafeInteger(request.deadlineMs) || request.deadlineMs <= request.scheduledAtMs ||
        !Number.isSafeInteger(now) || now < 1 || now >= request.deadlineMs) {
      return Promise.resolve(receipt("failed", "ELECTRON_VIEW_FOCUS_REQUEST_INVALID"));
    }
    if (this.#pending.has(request.roleId)) return Promise.resolve(receipt("failed", "ELECTRON_VIEW_FOCUS_CONFLICT"));
    try {
      if (!target.view.getVisible()) {
        return Promise.resolve(validChromiumViewInputObservation(target.observe(), target.identity, "background")
          ? receipt("applied", null) : receipt("failed", "ELECTRON_VIEW_BACKGROUND_FOCUS_INVALID"));
      }
    } catch { return Promise.resolve(receipt("superseded", "ELECTRON_VIEW_FOCUS_SUPERSEDED")); }

    return new Promise(resolve => {
      let terminal = false;
      const cleanup: Array<() => void> = [];
      const finish = (status: Receipt["status"], code: string | null) => {
        if (terminal) return;
        terminal = true;
        this.#pending.delete(request.roleId);
        for (const dispose of cleanup.splice(0)) dispose();
        resolve(receipt(status, code));
      };
      // Subscription APIs may synchronously deliver retirement. Dispose the
      // newly returned subscription even when terminality preceded its return.
      const own = (dispose: () => void) => { if (terminal) dispose(); else cleanup.push(dispose); };
      const cancel = () => finish("superseded", "ELECTRON_VIEW_FOCUS_SUPERSEDED");
      this.#pending.set(request.roleId, cancel);
      const check = () => {
        if (terminal) return;
        try {
          const current = attachments.resolveFocusTarget(request.roleId, request.surfaceGeneration);
          if (current?.input !== target.input || !target.view.getVisible()) { cancel(); return; }
          if (nowMs() >= request.deadlineMs) { finish("failed", "SYSTEM_TRUSTED_INPUT_FOREGROUND_DEADLINE"); return; }
          if (validChromiumViewInputObservation(target.observe(), target.identity, "foreground")) finish("applied", null);
        } catch { cancel(); }
      };
      try {
        own(attachments.subscribeInvalidation((roleId, generation) => {
          if (roleId === request.roleId && generation === request.surfaceGeneration) cancel();
        }));
        own(attachments.subscribePresentation(event => {
          if (event.roleId === request.roleId && event.surfaceGeneration === request.surfaceGeneration) check();
        }));
        own(target.binding.subscribe(event => { if (event === "closed") cancel(); else check(); }));
        for (const event of ["focus", "blur", "destroyed"] as const) {
          if (terminal) break;
          target.view.webContents.on(event, check);
          own(() => { target.view.webContents.removeListener(event, check); });
        }
        if (terminal) return;
        const timer = deadlines.schedule(() => finish("failed", "SYSTEM_TRUSTED_INPUT_FOREGROUND_DEADLINE"), request.deadlineMs - now);
        own(() => deadlines.cancel(timer));
        if (terminal) return;
        if (!target.view.webContents.focus || !target.view.webContents.isFocused) throw new Error("View focus API unavailable.");
        this.options.activateParent(target);
        if (terminal) return;
        target.view.webContents.focus();
        check();
      } catch { finish("failed", "ELECTRON_VIEW_FOCUS_FAILED"); }
    });
  }

  dispose(): void {
    this.#disposed = true;
    for (const cancel of [...this.#pending.values()]) cancel();
  }
}
