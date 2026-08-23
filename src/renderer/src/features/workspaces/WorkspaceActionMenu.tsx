import { Copy, type LucideIcon, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { type JSX, type PointerEvent as ReactPointerEvent, useEffect, useState } from "react";

import { Button } from "../../components/ui/button";
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator
} from "../../components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "../../components/ui/dropdown-menu";
import type { Translator } from "../../i18n";
import { cn } from "../../lib/utils";
import type {
  EmbeddedRuntimeState,
  GameWindow,
  RuntimeLaunchDestination
} from "../../../../shared/types";
import {
  RuntimeLaunchDestinationContextSubmenu,
  RuntimeLaunchDestinationDropdownSubmenu
} from "../game-windows/runtimeLaunchDestination";

interface WorkspaceActionMenuProps {
  canReorder: boolean;
  gameWindows: GameWindow[];
  isDragging: boolean;
  isBusy: boolean;
  isLaunchDisabled: boolean;
  onCopy: () => void;
  onDelete: () => void;
  onEdit: () => void;
  onLaunchDestination: (destination?: RuntimeLaunchDestination) => void;
  onReorderPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  runtime: EmbeddedRuntimeState;
  sourceId: string;
  t: Translator;
}

interface WorkspaceAction {
  Icon: LucideIcon;
  id: "copy" | "delete" | "edit";
  isDestructive?: boolean;
  isDisabled: boolean;
  label: string;
  onSelect: () => void;
}

export function WorkspaceActionMenu({
  canReorder,
  gameWindows,
  isBusy,
  isLaunchDisabled,
  isDragging,
  onCopy,
  onDelete,
  onLaunchDestination,
  onReorderPointerDown,
  onEdit,
  runtime,
  sourceId,
  t
}: WorkspaceActionMenuProps): JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const actions = createWorkspaceActions({ isBusy, onCopy, onDelete, onEdit, t });

  useEffect(() => {
    if (isDragging) {
      setIsOpen(false);
    }
  }, [isDragging]);

  return (
    <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          className={cn(
            "h-7 w-7 touch-none",
            canReorder && "cursor-grab active:cursor-grabbing",
            isDragging && "cursor-grabbing"
          )}
          type="button"
          variant="secondary"
          size="icon"
          title={t(canReorder ? "workspaces.actionsAndReorder" : "workspaces.actions")}
          aria-label={t(canReorder ? "workspaces.actionsAndReorder" : "workspaces.actions")}
          onPointerDown={canReorder ? onReorderPointerDown : undefined}
        >
          <MoreHorizontal size={14} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
          {actions.filter((action) => !action.isDestructive).map(({ Icon, id, isDisabled, label, onSelect }) => (
            <DropdownMenuItem
              key={id}
              className="gap-1.5"
              disabled={isDisabled}
              onSelect={onSelect}
            >
              <Icon size={14} />
              <span>{label}</span>
            </DropdownMenuItem>
          ))}
          <RuntimeLaunchDestinationDropdownSubmenu
            disabled={isLaunchDisabled}
            gameWindows={gameWindows}
            runtime={runtime}
            source={{ id: sourceId, type: "workspace" }}
            t={t}
            onSelect={onLaunchDestination}
          />
          <DropdownMenuSeparator />
          {actions.filter((action) => action.isDestructive).map(({ Icon, id, isDisabled, label, onSelect }) => (
            <DropdownMenuItem
              key={id}
              className="gap-1.5 text-destructive"
              disabled={isDisabled}
              onSelect={onSelect}
            >
              <Icon size={14} />
              <span>{label}</span>
            </DropdownMenuItem>
          ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function WorkspaceContextMenuContent({
  gameWindows,
  isBusy,
  isLaunchDisabled,
  onCopy,
  onDelete,
  onEdit,
  onLaunchDestination,
  runtime,
  sourceId,
  t
}: Omit<WorkspaceActionMenuProps, "canReorder" | "isDragging" | "onReorderPointerDown">): JSX.Element {
  const actions = createWorkspaceActions({ isBusy, onCopy, onDelete, onEdit, t });

  return (
    <ContextMenuContent>
      {actions.filter((action) => !action.isDestructive).map(({ Icon, id, isDisabled, label, onSelect }) => (
        <ContextMenuItem
          key={id}
          className="gap-1.5"
          disabled={isDisabled}
          onSelect={onSelect}
        >
          <Icon size={14} />
          <span>{label}</span>
        </ContextMenuItem>
      ))}
      <RuntimeLaunchDestinationContextSubmenu
        disabled={isLaunchDisabled}
        gameWindows={gameWindows}
        runtime={runtime}
        source={{ id: sourceId, type: "workspace" }}
        t={t}
        onSelect={onLaunchDestination}
      />
      <ContextMenuSeparator />
      {actions.filter((action) => action.isDestructive).map(({ Icon, id, isDisabled, label, onSelect }) => (
        <ContextMenuItem
          key={id}
          className="gap-1.5 text-destructive"
          disabled={isDisabled}
          onSelect={onSelect}
        >
          <Icon size={14} />
          <span>{label}</span>
        </ContextMenuItem>
      ))}
    </ContextMenuContent>
  );
}

function createWorkspaceActions({
  isBusy,
  onCopy,
  onDelete,
  onEdit,
  t
}: Pick<WorkspaceActionMenuProps, "isBusy" | "onCopy" | "onDelete" | "onEdit" | "t">): WorkspaceAction[] {
  return [
    { Icon: Pencil, id: "edit", isDisabled: false, label: t("workspaces.edit"), onSelect: onEdit },
    { Icon: Copy, id: "copy", isDisabled: isBusy, label: t("workspaces.copy"), onSelect: onCopy },
    {
      Icon: Trash2,
      id: "delete",
      isDestructive: true,
      isDisabled: isBusy,
      label: t("workspaces.delete"),
      onSelect: onDelete
    }
  ];
}
