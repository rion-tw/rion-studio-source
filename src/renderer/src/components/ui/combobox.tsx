import { Combobox as ComboboxPrimitive } from "@base-ui/react";
import { Check, ChevronDown, X } from "lucide-react";
import { type ComponentPropsWithRef, type JSX } from "react";

import { cn } from "../../lib/utils";

export function Combobox<Value, Multiple extends boolean | undefined = false>(
  props: ComboboxPrimitive.Root.Props<Value, Multiple>
): JSX.Element {
  return <ComboboxPrimitive.Root {...props} />;
}

export function ComboboxValue(props: ComboboxPrimitive.Value.Props): JSX.Element {
  return <ComboboxPrimitive.Value data-slot="combobox-value" {...props} />;
}

export function ComboboxTrigger({
  children,
  className,
  ...props
}: ComboboxPrimitive.Trigger.Props): JSX.Element {
  return (
    <ComboboxPrimitive.Trigger
      data-slot="combobox-trigger"
      className={cn(
        "inline-flex size-[var(--control-min-size)] shrink-0 items-center justify-center rounded-xs text-muted-foreground transition-colors hover:bg-accent/45 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/25 disabled:pointer-events-none disabled:opacity-45",
        className
      )}
      {...props}
    >
      {children}
      <ChevronDown className="size-3.5" aria-hidden="true" />
    </ComboboxPrimitive.Trigger>
  );
}

export function ComboboxClear({
  className,
  ...props
}: ComboboxPrimitive.Clear.Props): JSX.Element {
  return (
    <ComboboxPrimitive.Clear
      data-slot="combobox-clear"
      className={cn(
        "inline-flex size-[var(--control-min-size)] shrink-0 items-center justify-center rounded-xs text-muted-foreground transition-colors hover:bg-accent/45 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/25 disabled:pointer-events-none disabled:opacity-45",
        className
      )}
      {...props}
    >
      <X className="size-3.5" aria-hidden="true" />
    </ComboboxPrimitive.Clear>
  );
}

interface ComboboxInputProps extends ComboboxPrimitive.Input.Props {
  showClear?: boolean;
  showTrigger?: boolean;
}

export function ComboboxInput({
  className,
  disabled = false,
  showClear = false,
  showTrigger = true,
  ...props
}: ComboboxInputProps): JSX.Element {
  return (
    <div
      className={cn(
        "glass-control flex h-[var(--control-height)] min-h-[var(--control-min-size)] min-w-[var(--control-min-size)] w-full items-center rounded-sm px-1.5 focus-within:border-ring/30 focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring/25",
        className
      )}
    >
      <ComboboxPrimitive.Input
        className="min-w-0 flex-1 bg-transparent px-1 text-control leading-none text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
        disabled={disabled}
        {...props}
      />
      {showClear ? <ComboboxClear disabled={disabled} /> : null}
      {showTrigger ? <ComboboxTrigger disabled={disabled} /> : null}
    </div>
  );
}

export function ComboboxContent({
  align = "start",
  alignOffset = 0,
  anchor,
  className,
  side = "bottom",
  sideOffset = 6,
  ...props
}: ComboboxPrimitive.Popup.Props &
  Pick<
    ComboboxPrimitive.Positioner.Props,
    "align" | "alignOffset" | "anchor" | "side" | "sideOffset"
  >): JSX.Element {
  return (
    <ComboboxPrimitive.Portal>
      <ComboboxPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        anchor={anchor}
        className="z-[var(--layer-tooltip)]"
        side={side}
        sideOffset={sideOffset}
      >
        <ComboboxPrimitive.Popup
          data-selection-ignore
          data-slot="combobox-content"
          className={cn(
            "glass-popover relative w-[var(--anchor-width)] min-w-[var(--anchor-width)] max-w-[min(var(--available-width),calc(100vw-1rem))] overflow-hidden rounded-sm border border-border/60 text-control text-popover-foreground shadow-md outline-none transition-opacity data-[ending-style]:opacity-0 data-[starting-style]:opacity-0",
            className
          )}
          {...props}
        />
      </ComboboxPrimitive.Positioner>
    </ComboboxPrimitive.Portal>
  );
}

export function ComboboxList({
  className,
  ...props
}: ComboboxPrimitive.List.Props): JSX.Element {
  return (
    <ComboboxPrimitive.List
      data-slot="combobox-list"
      className={cn("max-h-[min(18rem,var(--available-height))] overflow-y-auto overscroll-contain p-1", className)}
      {...props}
    />
  );
}

export function ComboboxItem({
  children,
  className,
  ...props
}: ComboboxPrimitive.Item.Props): JSX.Element {
  return (
    <ComboboxPrimitive.Item
      data-slot="combobox-item"
      className={cn(
        "relative flex min-h-[var(--control-min-size)] w-full cursor-default select-none items-center gap-2 rounded-sm py-1.5 pl-2 pr-7 outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-45 data-[highlighted]:bg-accent/60 data-[highlighted]:text-accent-foreground",
        className
      )}
      {...props}
    >
      {children}
      <ComboboxPrimitive.ItemIndicator className="absolute right-2 inline-flex size-3.5 items-center justify-center text-activity">
        <Check className="size-3.5" aria-hidden="true" />
      </ComboboxPrimitive.ItemIndicator>
    </ComboboxPrimitive.Item>
  );
}

export function ComboboxGroup({
  className,
  ...props
}: ComboboxPrimitive.Group.Props): JSX.Element {
  return (
    <ComboboxPrimitive.Group
      data-slot="combobox-group"
      className={cn("[&:not(:first-child)]:mt-1", className)}
      {...props}
    />
  );
}

export function ComboboxLabel({
  className,
  ...props
}: ComboboxPrimitive.GroupLabel.Props): JSX.Element {
  return (
    <ComboboxPrimitive.GroupLabel
      data-slot="combobox-label"
      className={cn("px-2 py-1.5 text-caption font-semibold text-muted-foreground", className)}
      {...props}
    />
  );
}

export function ComboboxCollection(props: ComboboxPrimitive.Collection.Props): JSX.Element {
  return <ComboboxPrimitive.Collection data-slot="combobox-collection" {...props} />;
}

export function ComboboxEmpty({
  className,
  ...props
}: ComboboxPrimitive.Empty.Props): JSX.Element {
  return (
    <ComboboxPrimitive.Empty
      data-slot="combobox-empty"
      className={cn(
        "px-3 py-6 text-center text-control text-muted-foreground empty:p-0",
        className
      )}
      {...props}
    />
  );
}

export function ComboboxSeparator({
  className,
  ...props
}: ComboboxPrimitive.Separator.Props): JSX.Element {
  return (
    <ComboboxPrimitive.Separator
      data-slot="combobox-separator"
      className={cn("glass-divider -mx-1 my-1 h-px bg-border/50", className)}
      {...props}
    />
  );
}

export function ComboboxChips({
  className,
  ...props
}: ComponentPropsWithRef<typeof ComboboxPrimitive.Chips> &
  ComboboxPrimitive.Chips.Props): JSX.Element {
  return (
    <ComboboxPrimitive.Chips
      data-slot="combobox-chips"
      className={cn(
        "glass-control flex min-h-[var(--control-height)] w-full flex-wrap items-center gap-1.5 rounded-sm px-2 py-1.5 text-control text-foreground focus-within:border-ring/30 focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring/25 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-45",
        className
      )}
      {...props}
    />
  );
}

interface ComboboxChipProps extends ComboboxPrimitive.Chip.Props {
  removeLabel?: string;
  showRemove?: boolean;
}

export function ComboboxChip({
  children,
  className,
  removeLabel,
  showRemove = true,
  ...props
}: ComboboxChipProps): JSX.Element {
  return (
    <ComboboxPrimitive.Chip
      data-slot="combobox-chip"
      className={cn(
        "glass-control-selected inline-flex h-6 max-w-full items-center gap-1 rounded-xs border border-[hsl(var(--glass-border))] pl-2 pr-1 text-caption font-semibold text-foreground transition-[background-color,border-color,color,box-shadow] duration-150 has-[:disabled]:pointer-events-none has-[:disabled]:opacity-45",
        className
      )}
      {...props}
    >
      <span className="min-w-0 truncate">{children}</span>
      {showRemove ? (
        <ComboboxPrimitive.ChipRemove
          aria-label={removeLabel}
          className="inline-flex size-4 shrink-0 items-center justify-center rounded-xs text-muted-foreground transition-colors hover:bg-accent/45 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25 disabled:pointer-events-none aria-disabled:pointer-events-none aria-disabled:opacity-45"
          data-slot="combobox-chip-remove"
          type="button"
        >
          <X className="size-3" aria-hidden="true" />
        </ComboboxPrimitive.ChipRemove>
      ) : null}
    </ComboboxPrimitive.Chip>
  );
}

export function ComboboxChipsInput({
  className,
  ...props
}: ComboboxPrimitive.Input.Props): JSX.Element {
  return (
    <ComboboxPrimitive.Input
      data-slot="combobox-chip-input"
      className={cn(
        "h-6 min-w-24 flex-1 bg-transparent px-0.5 text-control leading-none text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed",
        className
      )}
      {...props}
    />
  );
}
