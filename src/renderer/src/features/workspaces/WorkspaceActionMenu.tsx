import { Copy, type LucideIcon, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { type JSX, type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";

import { Button } from "../../components/ui/button";
import {
  ContextMenuContent,
  ContextMenuItem
} from "../../components/ui/context-menu";
import { Surface } from "../../components/ui/patterns";
import type { Translator } from "../../i18n";
import { cn } from "../../lib/utils";

interface WorkspaceActionMenuProps {
  canReorder: boolean;
  isDragging: boolean;
  isBusy: boolean;
  onCopy: () => void;
  onDelete: () => void;
  onEdit: () => void;
  onReorderPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
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
  isBusy,
  isDragging,
  onCopy,
  onDelete,
  onReorderPointerDown,
  onEdit,
  t
}: WorkspaceActionMenuProps): JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const actions = createWorkspaceActions({ isBusy, onCopy, onDelete, onEdit, t });

  useEffect(() => {
    if (isDragging) {
      setIsOpen(false);
    }
  }, [isDragging]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    function handlePointerDown(event: PointerEvent): void {
      if (menuRef.current?.contains(event.target as Node)) {
        return;
      }

      setIsOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    }

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  function run(action: () => void): void {
    setIsOpen(false);
    action();
  }

  return (
    <div ref={menuRef} className="relative shrink-0">
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
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((current) => !current)}
        onPointerDown={canReorder ? onReorderPointerDown : undefined}
      >
        <MoreHorizontal size={14} />
      </Button>

      {isOpen ? (
        <Surface
          className="absolute right-0 top-8 z-[var(--layer-popover)] min-w-32 overflow-hidden text-popover-foreground"
          padding="xs"
          variant="popover"
          role="menu"
        >
          {actions.map(({ Icon, id, isDestructive, isDisabled, label, onSelect }) => (
            <button
              key={id}
              className={cn(
                "flex h-7 w-full items-center gap-1.5 rounded-sm px-2 text-left text-xs font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
                isDestructive
                  ? "text-destructive hover:bg-destructive/10"
                  : "text-foreground hover:bg-accent/45 hover:text-accent-foreground"
              )}
              type="button"
              role="menuitem"
              disabled={isDisabled}
              onClick={() => run(onSelect)}
            >
              <Icon size={14} />
              <span>{label}</span>
            </button>
          ))}
        </Surface>
      ) : null}
    </div>
  );
}

export function WorkspaceContextMenuContent({
  isBusy,
  onCopy,
  onDelete,
  onEdit,
  t
}: Omit<WorkspaceActionMenuProps, "canReorder" | "isDragging" | "onReorderPointerDown">): JSX.Element {
  const actions = createWorkspaceActions({ isBusy, onCopy, onDelete, onEdit, t });

  return (
    <ContextMenuContent>
      {actions.map(({ Icon, id, isDestructive, isDisabled, label, onSelect }) => (
        <ContextMenuItem
          key={id}
          className={cn("gap-1.5", isDestructive && "text-destructive")}
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
