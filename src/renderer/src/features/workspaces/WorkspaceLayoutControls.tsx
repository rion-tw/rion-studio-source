// Focused implementation extracted from WorkspaceModal.tsx.
import { Globe2, GripHorizontal, GripVertical, Plus } from "lucide-react";

import { type JSX, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

import type { Translator } from "../../i18n";

import { cn } from "../../lib/utils";

import type { LaunchWorkspaceSlot, NormalizedRect, Role, WorkspaceLayoutTemplate } from "../../../../shared/types";

import { createWorkspaceSlotBackground, getWorkspaceHorizontalResizeHandles, getWorkspaceSplits, getWorkspaceVerticalResizeHandles, rectToPreviewStyle, type WorkspaceSplitAxis } from "./workspaceLayoutUtils";

import type { WorkspaceActiveResize } from "./WorkspaceModal";

export function WorkspaceHelpSection({ children, title }: { children: ReactNode; title: string }): JSX.Element {
  return (
    <section className="grid max-w-[72ch] gap-1 text-xs leading-5 text-muted-foreground">
      <h2 className="text-caption font-semibold text-foreground">{title}</h2>
      <ul className="grid list-disc gap-1 pl-4">{children}</ul>
    </section>
  );
}

interface WorkspaceSlotDropZoneProps {
  index: number;
  isDragging: boolean;
  isDropTarget: boolean;
  isSelected: boolean;
  isSaving: boolean;
  launchGameName?: string;
  onClick: () => void;
  onSlotPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  role?: Role;
  web?: LaunchWorkspaceSlot["web"];
  rect: NormalizedRect;
  resizeIndicator?: string;
  t: Translator;
}

export function WorkspaceSlotDropZone({
  index,
  isDragging,
  isDropTarget,
  isSelected,
  isSaving,
  launchGameName,
  onClick,
  onSlotPointerDown,
  role,
  web,
  rect,
  resizeIndicator,
  t
}: WorkspaceSlotDropZoneProps): JSX.Element {
  const resolvedLaunchGameName = launchGameName ?? role?.launchUrl ?? "";
  const slotInsetStyle = {
    top: rect.y > 0 ? 10 : 0,
    right: rect.x + rect.width < 0.999 ? 10 : 0,
    bottom: rect.y + rect.height < 0.999 ? 10 : 0,
    left: rect.x > 0 ? 10 : 0
  };

  return (
    <div
      className="absolute"
      style={rectToPreviewStyle(rect)}
    >
      <button
        className={cn(
          "group/slot absolute isolate flex min-h-0 flex-col justify-between overflow-hidden rounded-none border bg-cover bg-center p-3 text-left transition-[background-color,border-color,box-shadow,transform] duration-150 [--workspace-slot-radius:0px] [contain:paint]",
          role || web
            ? "border-border/70 bg-card/72 shadow-sm"
            : "border-border/40 bg-card/50 shadow-[inset_0_1px_0_hsl(var(--glass-highlight-muted))] hover:border-border/65 hover:bg-card/60",
          isSelected && cn("border-activity/60 shadow-none", (role || web) && "bg-activity/[0.035]"),
          isDropTarget && cn("border-activity/75 shadow-none", (role || web) && "bg-activity/10"),
          isDragging && "opacity-50"
        )}
        type="button"
        aria-pressed={isSelected}
        data-workspace-assigned-role-id={role?.id ?? ""}
        data-workspace-web-url={web?.startUrl ?? ""}
        data-workspace-slot-index={index}
        disabled={isSaving}
        style={{ ...slotInsetStyle, ...createWorkspaceSlotBackground(role) }}
        onClick={onClick}
      >
        {role?.coverImageDataUrl ? <div className="absolute inset-0 bg-media-black/10" /> : null}
        {resizeIndicator ? (
          <span
            className="glass-popover pointer-events-none absolute left-1/2 top-2.5 z-[var(--layer-selection)] -translate-x-1/2 whitespace-nowrap rounded-full border border-activity/35 px-2 py-1 text-micro font-semibold leading-none text-foreground shadow-md backdrop-blur-md"
            data-workspace-resize-indicator
          >
            {resizeIndicator}
          </span>
        ) : null}
        <div className="relative z-[var(--layer-selection)] flex min-w-0 items-start gap-2">
          <p className="rounded-sm border border-border/35 bg-background/45 px-2 py-1 text-caption font-semibold leading-none text-muted-foreground backdrop-blur-md">
            {t("workspaces.slot").replace("{index}", String(index + 1))}
          </p>
        </div>

        {role || web ? (
          <span
            data-workspace-slot-drag-handle
            className="glass-popover absolute right-2.5 top-2.5 z-[var(--layer-selection)] grid size-7 touch-none cursor-grab place-items-center rounded-sm text-muted-foreground opacity-0 shadow-sm transition-[opacity,color,transform] hover:text-foreground active:cursor-grabbing active:scale-95 group-hover/slot:opacity-100"
            onPointerDown={(event) => {
              event.stopPropagation();
              onSlotPointerDown(event);
            }}
          >
            <GripVertical size={14} />
          </span>
        ) : null}

        {role ? (
          <div className="workspace-slot-caption">
            <p className="workspace-slot-name-chip flex min-w-0 text-sm font-semibold">
              <span className="workspace-role-chip-text">
                <span className="min-w-0 truncate">{role.name}</span>
                <span className="workspace-role-game-label min-w-0 truncate">{resolvedLaunchGameName}</span>
              </span>
            </p>
          </div>
        ) : web ? (
          <div className="workspace-slot-caption">
            <p className="workspace-slot-name-chip flex min-w-0 items-center gap-2 text-sm font-semibold">
              <Globe2 className="size-4 shrink-0" aria-hidden="true" />
              <span className="workspace-role-chip-text">
                <span className="min-w-0 truncate">{web.name}</span>
                <span className="workspace-role-game-label min-w-0 truncate">
                  {(() => {
                    try {
                      return new URL(web.startUrl).origin;
                    } catch {
                      return web.startUrl;
                    }
                  })()}
                </span>
              </span>
            </p>
          </div>
        ) : (
          <div className="pointer-events-none absolute inset-0 grid place-items-center p-10 text-center">
            <div className="grid justify-items-center gap-2 text-muted-foreground/75 transition-colors group-hover/slot:text-muted-foreground">
              <span className="glass-control grid size-9 place-items-center rounded-full border-border/35 bg-background/25 shadow-none">
                <Plus size={17} />
              </span>
              <span className="text-xs font-semibold">{t("workspaces.emptySlot")}</span>
            </div>
          </div>
        )}
      </button>
    </div>
  );
}

interface WorkspaceResizeHandlesProps {
  activeResize: WorkspaceActiveResize | null;
  onResizeStart: (
    event: ReactPointerEvent<HTMLButtonElement>,
    axis: WorkspaceSplitAxis,
    splitIndex: number
  ) => void;
  slots: LaunchWorkspaceSlot[];
  t: Translator;
  template: WorkspaceLayoutTemplate;
}

export function WorkspaceResizeHandles({
  activeResize,
  onResizeStart,
  slots,
  t,
  template
}: WorkspaceResizeHandlesProps): JSX.Element | null {
  const splits = getWorkspaceSplits(template, slots);
  const verticalHandles = getWorkspaceVerticalResizeHandles(template, splits);
  const horizontalHandles = getWorkspaceHorizontalResizeHandles(template, splits);

  if (splits.vertical.length === 0 && splits.horizontal.length === 0) {
    return null;
  }

  return (
    <>
      {verticalHandles.map((handle) => {
        const isActive = activeResize?.axis === "vertical" && activeResize.splitIndex === handle.splitIndex;

        return (
          <button
            key={`vertical-${handle.splitIndex}`}
            className="group/resize absolute z-[var(--layer-selection)] grid h-12 w-[var(--control-hit-size)] touch-none -translate-x-1/2 -translate-y-1/2 cursor-col-resize place-items-center bg-transparent focus-visible:outline-none"
            type="button"
            aria-label={t("workspaces.resizeColumns").replace("{index}", String(handle.splitIndex + 1))}
            style={{ left: `${handle.x * 100}%`, top: `${handle.y * 100}%` }}
            onPointerDown={(event) => onResizeStart(event, "vertical", handle.splitIndex)}
          >
            <span
              className={cn(
                "glass-popover grid h-9 w-3.5 place-items-center rounded-full border-border/55 text-muted-foreground/80 shadow-sm transition-[border-color,color,transform,box-shadow] group-hover/resize:scale-105 group-hover/resize:border-activity/45 group-hover/resize:text-foreground group-focus-visible/resize:ring-2 group-focus-visible/resize:ring-ring/25",
                isActive && "scale-110 border-activity/70 text-foreground shadow-lg ring-2 ring-activity/20"
              )}
            >
              <GripVertical size={12} />
            </span>
          </button>
        );
      })}

      {horizontalHandles.map((handle, handleIndex) => {
        const isActive = activeResize?.axis === "horizontal" && activeResize.splitIndex === handle.splitIndex;

        return (
          <button
            key={`horizontal-${handle.splitIndex}-${handleIndex}`}
            className="group/resize absolute z-[var(--layer-selection)] grid h-[var(--control-hit-size)] w-12 touch-none -translate-x-1/2 -translate-y-1/2 cursor-row-resize place-items-center bg-transparent focus-visible:outline-none"
            type="button"
            aria-label={t("workspaces.resizeRows").replace("{index}", String(handle.splitIndex + 1))}
            style={{
              left: `${handle.x * 100}%`,
              top: `${handle.y * 100}%`
            }}
            onPointerDown={(event) => onResizeStart(event, "horizontal", handle.splitIndex)}
          >
            <span
              className={cn(
                "glass-popover grid h-3.5 w-9 place-items-center rounded-full border-border/55 text-muted-foreground/80 shadow-sm transition-[border-color,color,transform,box-shadow] group-hover/resize:scale-105 group-hover/resize:border-activity/45 group-hover/resize:text-foreground group-focus-visible/resize:ring-2 group-focus-visible/resize:ring-ring/25",
                isActive && "scale-110 border-activity/70 text-foreground shadow-lg ring-2 ring-activity/20"
              )}
            >
              <GripHorizontal size={12} />
            </span>
          </button>
        );
      })}
    </>
  );
}
