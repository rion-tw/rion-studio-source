import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import { Check, ChevronRight } from "lucide-react";
import { forwardRef } from "react";

import { cn } from "../../lib/utils";

export function ContextMenu(props: React.ComponentProps<typeof ContextMenuPrimitive.Root>): React.ReactElement {
  return <ContextMenuPrimitive.Root {...props} />;
}

export const ContextMenuTrigger = forwardRef<
  React.ComponentRef<typeof ContextMenuPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Trigger>
>((props, ref) => (
  <ContextMenuPrimitive.Trigger ref={ref} {...props} />
));

ContextMenuTrigger.displayName = ContextMenuPrimitive.Trigger.displayName;

export const ContextMenuContent = forwardRef<
  React.ComponentRef<typeof ContextMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Content>
>(({ className, collisionPadding = 8, ...props }, ref) => (
  <ContextMenuPrimitive.Portal>
    <ContextMenuPrimitive.Content
      ref={ref}
      collisionPadding={collisionPadding}
      className={cn(
        "glass-popover relative z-[var(--layer-tooltip)] max-h-[var(--radix-context-menu-content-available-height)] min-w-32 overflow-hidden rounded-sm border border-border/60 bg-popover p-1 text-control text-popover-foreground shadow-md data-[state=closed]:opacity-0 data-[state=open]:opacity-100",
        className
      )}
      {...props}
    />
  </ContextMenuPrimitive.Portal>
));

ContextMenuContent.displayName = ContextMenuPrimitive.Content.displayName;

export const ContextMenuItem = forwardRef<
  React.ComponentRef<typeof ContextMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Item>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.Item
    ref={ref}
    className={cn(
      "relative flex min-h-[var(--control-min-size)] w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-45 data-[highlighted]:bg-accent/60 data-[highlighted]:text-accent-foreground",
      className
    )}
    {...props}
  />
));

ContextMenuItem.displayName = ContextMenuPrimitive.Item.displayName;

export function ContextMenuRadioGroup(
  props: React.ComponentProps<typeof ContextMenuPrimitive.RadioGroup>
): React.ReactElement {
  return <ContextMenuPrimitive.RadioGroup {...props} />;
}

export const ContextMenuRadioItem = forwardRef<
  React.ComponentRef<typeof ContextMenuPrimitive.RadioItem>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.RadioItem>
>(({ className, children, ...props }, ref) => (
  <ContextMenuPrimitive.RadioItem
    ref={ref}
    className={cn(
      "relative flex min-h-[var(--control-min-size)] w-full cursor-default select-none items-center overflow-hidden rounded-sm py-1.5 pl-7 pr-2 outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-45 data-[highlighted]:bg-accent/60 data-[highlighted]:text-accent-foreground",
      className
    )}
    {...props}
  >
    <span className="absolute left-2 flex size-3.5 items-center justify-center">
      <ContextMenuPrimitive.ItemIndicator>
        <Check className="size-3.5" aria-hidden="true" />
      </ContextMenuPrimitive.ItemIndicator>
    </span>
    <span className="min-w-0 flex-1 truncate">{children}</span>
  </ContextMenuPrimitive.RadioItem>
));

ContextMenuRadioItem.displayName = ContextMenuPrimitive.RadioItem.displayName;

export const ContextMenuLabel = forwardRef<
  React.ComponentRef<typeof ContextMenuPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Label>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.Label
    ref={ref}
    className={cn("px-2 py-1.5 text-caption font-semibold text-muted-foreground", className)}
    {...props}
  />
));

ContextMenuLabel.displayName = ContextMenuPrimitive.Label.displayName;

export const ContextMenuSeparator = forwardRef<
  React.ComponentRef<typeof ContextMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.Separator
    ref={ref}
    className={cn("glass-divider -mx-1 my-1 h-px bg-border/50", className)}
    {...props}
  />
));

ContextMenuSeparator.displayName = ContextMenuPrimitive.Separator.displayName;

export function ContextMenuSub(
  props: React.ComponentProps<typeof ContextMenuPrimitive.Sub>
): React.ReactElement {
  return <ContextMenuPrimitive.Sub {...props} />;
}

export const ContextMenuSubTrigger = forwardRef<
  React.ComponentRef<typeof ContextMenuPrimitive.SubTrigger>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubTrigger>
>(({ className, children, ...props }, ref) => (
  <ContextMenuPrimitive.SubTrigger
    ref={ref}
    className={cn(
      "relative flex min-h-[var(--control-min-size)] w-full cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 pr-7 outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-45 data-[highlighted]:bg-accent/60 data-[highlighted]:text-accent-foreground data-[state=open]:bg-accent/60 data-[state=open]:text-accent-foreground",
      className
    )}
    {...props}
  >
    <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate">{children}</span>
    <ChevronRight aria-hidden="true" className="absolute right-2 size-3.5" />
  </ContextMenuPrimitive.SubTrigger>
));

ContextMenuSubTrigger.displayName = ContextMenuPrimitive.SubTrigger.displayName;

export const ContextMenuSubContent = forwardRef<
  React.ComponentRef<typeof ContextMenuPrimitive.SubContent>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubContent>
>(({ className, collisionPadding = 8, ...props }, ref) => (
  <ContextMenuPrimitive.Portal>
    <ContextMenuPrimitive.SubContent
      ref={ref}
      collisionPadding={collisionPadding}
      className={cn(
        "glass-popover z-[var(--layer-tooltip)] max-h-[var(--radix-context-menu-content-available-height)] min-w-44 overflow-hidden rounded-sm border border-border/60 bg-popover p-1 text-control text-popover-foreground shadow-md data-[state=closed]:opacity-0 data-[state=open]:opacity-100",
        className
      )}
      {...props}
    />
  </ContextMenuPrimitive.Portal>
));

ContextMenuSubContent.displayName = ContextMenuPrimitive.SubContent.displayName;
