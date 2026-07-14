import {
  type JSX,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState
} from "react";

import { Button } from "./ui/button";
import { Surface } from "./ui/patterns";
import { ConfirmationContext, type ConfirmationOptions, type Confirm } from "./confirmation";

interface PendingConfirmation extends ConfirmationOptions {
  resolve: (confirmed: boolean) => void;
}

export function ConfirmationProvider({ children }: { children: ReactNode }): JSX.Element {
  const [pending, setPending] = useState<PendingConfirmation | null>(null);
  const pendingRef = useRef<PendingConfirmation | null>(null);

  const confirm = useCallback<Confirm>((options) => {
    if (pendingRef.current) {
      return Promise.resolve(false);
    }

    return new Promise<boolean>((resolve) => {
      const nextPending = { ...options, resolve };
      pendingRef.current = nextPending;
      setPending(nextPending);
    });
  }, []);

  const settle = useCallback((confirmed: boolean): void => {
    const currentPending = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    currentPending?.resolve(confirmed);
  }, []);

  return (
    <ConfirmationContext.Provider value={confirm}>
      {children}
      <ConfirmationDialog pending={pending} onSettle={settle} />
    </ConfirmationContext.Provider>
  );
}

function ConfirmationDialog({
  onSettle,
  pending
}: {
  onSettle: (confirmed: boolean) => void;
  pending: PendingConfirmation | null;
}): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }

    if (pending && !dialog.open) {
      dialog.showModal();
      window.setTimeout(() => cancelButtonRef.current?.focus(), 0);
    } else if (!pending && dialog.open) {
      dialog.close();
    }
  }, [pending]);

  return (
    <dialog
      ref={dialogRef}
      aria-describedby="confirmation-dialog-description"
      aria-labelledby="confirmation-dialog-title"
      className="confirmation-dialog m-auto w-[min(420px,calc(100vw-2rem))] max-w-none border-0 bg-transparent p-0 text-foreground"
      onCancel={(event) => {
        event.preventDefault();
        onSettle(false);
      }}
    >
      {pending ? (
        <Surface className="grid gap-4 p-5" radius="lg" variant="modal">
          <div className="grid gap-1.5">
            <h2 id="confirmation-dialog-title" className="text-base font-semibold leading-6">
              {pending.title}
            </h2>
            <p id="confirmation-dialog-description" className="text-xs font-medium leading-5 text-muted-foreground">
              {pending.description}
            </p>
          </div>
          <div className="flex justify-end gap-2">
            <Button ref={cancelButtonRef} type="button" variant="outline" onClick={() => onSettle(false)}>
              {pending.cancelLabel}
            </Button>
            <Button
              type="button"
              disabled={pending.confirmDisabled}
              variant={pending.tone === "destructive" ? "destructive" : "default"}
              onClick={() => onSettle(true)}
            >
              {pending.confirmLabel}
            </Button>
          </div>
        </Surface>
      ) : null}
    </dialog>
  );
}
