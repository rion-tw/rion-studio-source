import { Check, Monitor } from "lucide-react";
import { type JSX, useEffect, useRef, useState } from "react";

import { Button } from "../../components/ui/button";
import { Surface } from "../../components/ui/patterns";
import type { Translator } from "../../i18n";
import { cn } from "../../lib/utils";
import type { WorkspaceDisplayLaunchOption, WorkspaceLaunchResult } from "../../../../shared/types";
import {
  formatWorkspaceDisplayLabel,
  getFirstAvailableWorkspaceDisplayId,
  hasAvailableWorkspaceDisplay
} from "./workspaceDisplayUtils";

export interface WorkspaceDisplaySelectionRequest {
  displays: WorkspaceDisplayLaunchOption[];
  reason: Extract<WorkspaceLaunchResult, { kind: "display_selection_required" }>["reason"];
  workspaceName: string;
}

interface WorkspaceDisplayPickerDialogProps {
  onCancel: () => void;
  onSelect: (displayId: number) => void;
  request: WorkspaceDisplaySelectionRequest | null;
  t: Translator;
}

export function WorkspaceDisplayPickerDialog({
  onCancel,
  onSelect,
  request,
  t
}: WorkspaceDisplayPickerDialogProps): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const [selectedDisplayId, setSelectedDisplayId] = useState<number | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }

    if (request) {
      setSelectedDisplayId(getFirstAvailableWorkspaceDisplayId(request.displays));
      if (!dialog.open) {
        dialog.showModal();
      }
      window.setTimeout(() => cancelButtonRef.current?.focus(), 0);
    } else if (dialog.open) {
      dialog.close();
    }
  }, [request]);

  const hasAvailableDisplay = request ? hasAvailableWorkspaceDisplay(request.displays) : false;

  return (
    <dialog
      ref={dialogRef}
      aria-describedby="workspace-display-picker-description"
      aria-labelledby="workspace-display-picker-title"
      className="confirmation-dialog m-auto w-[min(560px,calc(100vw-2rem))] max-w-none border-0 bg-transparent p-0 text-foreground"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      {request ? (
        <Surface className="grid max-h-[min(620px,calc(100vh-2rem))] gap-4 overflow-hidden p-5" radius="lg" variant="modal">
          <div className="grid gap-1.5">
            <h2 id="workspace-display-picker-title" className="text-base font-semibold leading-6">
              {t("workspaces.displayPicker.title").replace("{name}", request.workspaceName)}
            </h2>
            <p id="workspace-display-picker-description" className="text-xs font-medium leading-5 text-muted-foreground">
              {t(
                request.reason === "target_occupied"
                  ? "workspaces.displayPicker.occupiedDescription"
                  : "workspaces.displayPicker.unavailableDescription"
              )}
            </p>
          </div>

          <div className="grid gap-2 overflow-auto pr-1">
            {request.displays.map((display, index) => {
              const isOccupied = Boolean(display.occupiedByWorkspace);
              const isSelected = selectedDisplayId === display.id;
              return (
                <button
                  key={display.id}
                  type="button"
                  aria-pressed={isSelected}
                  className={cn(
                    "glass-control flex min-w-0 items-center gap-3 rounded-lg px-3 py-2.5 text-left",
                    isSelected && "glass-control-selected border-primary/45",
                    isOccupied && "cursor-not-allowed opacity-55"
                  )}
                  disabled={isOccupied}
                  onClick={() => setSelectedDisplayId(display.id)}
                >
                  <span className="grid size-9 shrink-0 place-items-center rounded-md border border-border/60 bg-background/40">
                    <Monitor size={18} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-semibold">
                      {formatWorkspaceDisplayLabel(display, index, t)}
                    </span>
                    <span className={cn("mt-0.5 block text-[11px] font-medium", isOccupied ? "text-destructive" : "text-muted-foreground")}>
                      {display.occupiedByWorkspace
                        ? t("workspaces.displayPicker.occupiedBy").replace(
                            "{name}",
                            display.occupiedByWorkspace.name
                          )
                        : t("workspaces.displayPicker.available")}
                    </span>
                  </span>
                  {isSelected ? <Check className="shrink-0 text-primary" size={17} /> : null}
                </button>
              );
            })}
          </div>

          {!hasAvailableDisplay ? (
            <p className="rounded-md border border-border/60 bg-background/35 px-3 py-2 text-xs leading-5 text-muted-foreground">
              {t("workspaces.displayPicker.noAvailable")}
            </p>
          ) : null}

          <div className="flex justify-end gap-2">
            <Button ref={cancelButtonRef} type="button" variant="outline" onClick={onCancel}>
              {t("workspaces.displayPicker.cancel")}
            </Button>
            {hasAvailableDisplay ? (
              <Button
                type="button"
                disabled={selectedDisplayId === null}
                onClick={() => {
                  if (selectedDisplayId !== null) {
                    onSelect(selectedDisplayId);
                  }
                }}
              >
                {t("workspaces.displayPicker.launch")}
              </Button>
            ) : null}
          </div>
        </Surface>
      ) : null}
    </dialog>
  );
}
