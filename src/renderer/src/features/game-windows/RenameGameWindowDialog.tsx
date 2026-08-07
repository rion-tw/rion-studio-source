import { type JSX, useEffect, useRef, useState } from "react";

import type { GameWindow } from "../../../../shared/types";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Surface } from "../../components/ui/patterns";
import type { Translator } from "../../i18n";

const MAX_GAME_WINDOW_NAME_LENGTH = 80;

interface RenameGameWindowDialogProps {
  gameWindow: Pick<GameWindow, "id" | "name"> | null;
  isSaving: boolean;
  t: Translator;
  onCancel: () => void;
  onSave: (name: string) => Promise<boolean>;
}

export function RenameGameWindowDialog({
  gameWindow,
  isSaving,
  t,
  onCancel,
  onSave
}: RenameGameWindowDialogProps): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const normalizedName = name.trim();
  const normalizedNameLength = Array.from(normalizedName).length;
  const validationError = !normalizedName
    ? t("error.gameWindowNameRequired")
    : normalizedNameLength > MAX_GAME_WINDOW_NAME_LENGTH
      ? t("error.gameWindowNameTooLong")
      : undefined;
  const canSave = gameWindow !== null && !validationError && normalizedName !== gameWindow.name;
  const isBusy = isSaving || isSubmitting;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (!gameWindow) {
      if (dialog.open) dialog.close();
      return;
    }

    setName(gameWindow.name);
    if (!dialog.open) dialog.showModal();
    // event-topology: presentation
    window.setTimeout(() => {
      // event-topology: presentation
      window.setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 0);
    }, 0);
  }, [gameWindow]);

  async function submit(): Promise<void> {
    if (!canSave || isBusy) return;

    setIsSubmitting(true);
    try {
      if (await onSave(normalizedName)) onCancel();
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      aria-describedby="rename-game-window-dialog-description"
      aria-labelledby="rename-game-window-dialog-title"
      className="confirmation-dialog m-auto w-[min(480px,calc(100vw-2rem))] max-w-none border-0 bg-transparent p-0 text-foreground"
      onCancel={(event) => {
        event.preventDefault();
        if (!isBusy) onCancel();
      }}
    >
      {gameWindow ? (
        <Surface className="grid gap-4 p-5" radius="lg" variant="modal">
          <div className="grid gap-1.5">
            <h2 id="rename-game-window-dialog-title" className="text-title font-semibold">
              {t("gameWindows.rename.title").replace("{name}", gameWindow.name)}
            </h2>
            <p id="rename-game-window-dialog-description" className="text-control font-medium text-muted-foreground">
              {t("gameWindows.rename.description")}
            </p>
          </div>
          <form className="grid gap-4" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
            <label className="grid gap-2 text-body font-semibold" htmlFor="rename-game-window-name">
              {t("gameWindows.rename.name")}
              <Input
                ref={inputRef}
                aria-describedby={validationError
                  ? "rename-game-window-dialog-description rename-game-window-name-error"
                  : "rename-game-window-dialog-description"}
                aria-invalid={Boolean(validationError)}
                autoComplete="off"
                disabled={isBusy}
                id="rename-game-window-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            {validationError ? (
              <p id="rename-game-window-name-error" className="text-control font-medium text-destructive">
                {validationError}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button disabled={isBusy} type="button" variant="outline" onClick={onCancel}>
                {t("confirm.cancel")}
              </Button>
              <Button disabled={isBusy || !canSave} type="submit">
                {t("gameWindows.rename.save")}
              </Button>
            </div>
          </form>
        </Surface>
      ) : null}
    </dialog>
  );
}
