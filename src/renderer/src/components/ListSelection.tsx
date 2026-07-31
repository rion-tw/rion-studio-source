import { Loader2, Trash2, X } from "lucide-react";
import { createPortal } from "react-dom";
import type { JSX, MouseEvent, ReactNode } from "react";

import type { Translator } from "../i18n";
import type { SelectionRect } from "../hooks/useListSelection";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Surface } from "./ui/patterns";

interface SelectionToggleProps {
  alwaysVisible?: boolean;
  className?: string;
  isSelected: boolean;
  label: string;
  onToggle: () => void;
}

export function SelectionCardOverlay({ isSelected }: { isSelected: boolean }): JSX.Element | null {
  if (!isSelected) {
    return null;
  }

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-[var(--layer-selection)] rounded-[inherit] bg-activity/10 outline outline-1 outline-offset-[-1px] outline-activity/90"
      data-selection-overlay
    />
  );
}

export function SelectionToggle({
  alwaysVisible = false,
  className,
  isSelected,
  label,
  onToggle
}: SelectionToggleProps): JSX.Element {
  function handleClick(event: MouseEvent<HTMLButtonElement>): void {
    event.preventDefault();
    event.stopPropagation();
    onToggle();
  }

  return (
    <Checkbox
      aria-label={label}
      checked={isSelected}
      className={cn(
        "selection-toggle transition-opacity",
        isSelected
          ? "opacity-100"
          : alwaysVisible
            ? "opacity-100"
            : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
        className
      )}
      data-selection-control
      onClick={handleClick}
      onPointerDown={(event) => event.stopPropagation()}
    />
  );
}

interface SelectionActionBarProps {
  actions?: ReactNode;
  isBusy: boolean;
  onClear: () => void;
  onDelete: () => void;
  onSelectAll: () => void;
  selectedCount: number;
  t: Translator;
  totalCount: number;
}

export function SelectionActionBar({
  actions,
  isBusy,
  onClear,
  onDelete,
  onSelectAll,
  selectedCount,
  t,
  totalCount
}: SelectionActionBarProps): JSX.Element {
  const host = document.querySelector<HTMLElement>(".app-content");
  const toolbar = (
    <Surface
      aria-label={t("selection.count").replace("{count}", String(selectedCount))}
      className={cn(
        host ? "absolute" : "fixed",
        "bottom-5 left-1/2 z-[var(--layer-toast)] flex w-fit max-w-[calc(100%-1rem)] -translate-x-1/2 flex-nowrap items-center gap-1.5 overflow-x-auto px-2 py-1.5 shadow-lg"
      )}
      role="toolbar"
      variant="strong"
    >
      <span className="whitespace-nowrap px-1.5 text-xs font-semibold">
        {t("selection.count").replace("{count}", String(selectedCount))}
      </span>
      {selectedCount < totalCount ? (
        <Button type="button" size="sm" variant="ghost" disabled={isBusy} onClick={onSelectAll}>
          {t("selection.selectAllVisible")}
        </Button>
      ) : null}
      {actions}
      <Button type="button" size="sm" variant="destructive" disabled={isBusy} onClick={onDelete}>
        {isBusy ? <Loader2 className="spin" size={14} /> : <Trash2 size={14} />}
        {t("selection.deleteCount").replace("{count}", String(selectedCount))}
      </Button>
      <Button
        aria-label={t("selection.clear")}
        title={t("selection.clear")}
        type="button"
        size="icon"
        variant="ghost"
        disabled={isBusy}
        onClick={onClear}
      >
        <X size={14} />
      </Button>
    </Surface>
  );
  return createPortal(toolbar, host ?? document.body);
}

export function SelectionMarquee({
  container,
  rect
}: {
  container: HTMLElement | null;
  rect: SelectionRect | null;
}): JSX.Element | null {
  if (!container || !rect) {
    return null;
  }
  return createPortal(
    <div
      aria-hidden="true"
      className="pointer-events-none absolute z-[var(--layer-modal)] rounded-xs border border-activity/80 bg-activity/15 shadow-[0_0_0_1px_hsl(var(--background)/0.35)]"
      data-selection-marquee
      style={{ height: rect.height, left: rect.left, top: rect.top, width: rect.width }}
    />,
    container
  );
}
