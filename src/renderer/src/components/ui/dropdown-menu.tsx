import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Check, ChevronRight } from "lucide-react";
import { forwardRef } from "react";

import { cn } from "../../lib/utils";

export function DropdownMenu(props: React.ComponentProps<typeof DropdownMenuPrimitive.Root>): React.ReactElement {
  return <DropdownMenuPrimitive.Root {...props} />;
}

export const DropdownMenuTrigger = forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Trigger
    ref={ref}
    className={cn("", className)}
    {...props}
  />
));

DropdownMenuTrigger.displayName = DropdownMenuPrimitive.Trigger.displayName;

export const DropdownMenuContent = forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <DropdownMenuPrimitive.Portal>
    <DropdownMenuPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        "glass-popover relative z-[var(--layer-tooltip)] max-h-[var(--radix-dropdown-menu-content-available-height)] min-w-32 overflow-hidden rounded-sm border border-border/60 bg-popover p-1 text-control text-popover-foreground shadow-md data-[state=closed]:opacity-0 data-[state=open]:opacity-100",
        className
      )}
      {...props}
    />
  </DropdownMenuPrimitive.Portal>
));

DropdownMenuContent.displayName = DropdownMenuPrimitive.Content.displayName;

export function DropdownMenuSub(
  props: React.ComponentProps<typeof DropdownMenuPrimitive.Sub>
): React.ReactElement {
  return <DropdownMenuPrimitive.Sub {...props} />;
}

export const DropdownMenuSubTrigger = forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.SubTrigger>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubTrigger>
>(({ className, children, ...props }, ref) => (
  <DropdownMenuPrimitive.SubTrigger
    ref={ref}
    className={cn(
      "relative flex min-h-[var(--control-min-size)] w-full cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 pr-7 outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-45 data-[highlighted]:bg-accent/60 data-[highlighted]:text-accent-foreground data-[state=open]:bg-accent/60 data-[state=open]:text-accent-foreground",
      className
    )}
    {...props}
  >
    <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate">{children}</span>
    <ChevronRight aria-hidden="true" className="absolute right-2 size-3.5" />
  </DropdownMenuPrimitive.SubTrigger>
));

DropdownMenuSubTrigger.displayName = DropdownMenuPrimitive.SubTrigger.displayName;

export const DropdownMenuSubContent = forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.SubContent>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubContent>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <DropdownMenuPrimitive.Portal>
    <DropdownMenuPrimitive.SubContent
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        "glass-popover z-[var(--layer-tooltip)] max-h-[var(--radix-dropdown-menu-content-available-height)] min-w-44 overflow-hidden rounded-sm border border-border/60 bg-popover p-1 text-control text-popover-foreground shadow-md data-[state=closed]:opacity-0 data-[state=open]:opacity-100",
        className
      )}
      {...props}
    />
  </DropdownMenuPrimitive.Portal>
));

DropdownMenuSubContent.displayName = DropdownMenuPrimitive.SubContent.displayName;

export const DropdownMenuItem = forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Item
    ref={ref}
    className={cn(
      "relative flex min-h-[var(--control-min-size)] w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-45 data-[highlighted]:bg-accent/60 data-[highlighted]:text-accent-foreground",
      className
    )}
    {...props}
  />
));

DropdownMenuItem.displayName = DropdownMenuPrimitive.Item.displayName;

const DropdownMenuCheckboxItem = forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.CheckboxItem>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.CheckboxItem>
>(({ className, children, ...props }, ref) => (
  <DropdownMenuPrimitive.CheckboxItem
    ref={ref}
    className={cn(
      "relative flex min-h-[var(--control-min-size)] w-full cursor-default select-none items-center rounded-sm px-7 py-1.5 outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-45 data-[highlighted]:bg-accent/60 data-[highlighted]:text-accent-foreground",
      className
    )}
    {...props}
  >
    <span className="absolute left-2 flex size-3.5 items-center justify-center">
      <DropdownMenuPrimitive.ItemIndicator>
        <Check className="size-3.5" />
      </DropdownMenuPrimitive.ItemIndicator>
    </span>
    {children}
  </DropdownMenuPrimitive.CheckboxItem>
));

DropdownMenuCheckboxItem.displayName = DropdownMenuPrimitive.CheckboxItem.displayName;

export function DropdownMenuRadioGroup(
  props: React.ComponentProps<typeof DropdownMenuPrimitive.RadioGroup>
): React.ReactElement {
  return <DropdownMenuPrimitive.RadioGroup {...props} />;
}

export const DropdownMenuRadioItem = forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.RadioItem>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.RadioItem>
>(({ className, children, ...props }, ref) => (
  <DropdownMenuPrimitive.RadioItem
    ref={ref}
    className={cn(
      "relative flex min-h-[var(--control-min-size)] w-full cursor-default select-none items-center overflow-hidden rounded-sm py-1.5 pl-7 pr-2 outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-45 data-[highlighted]:bg-accent/60 data-[highlighted]:text-accent-foreground",
      className
    )}
    {...props}
  >
    <span className="absolute left-2 flex size-3.5 items-center justify-center">
      <DropdownMenuPrimitive.ItemIndicator>
        <Check className="size-3.5" aria-hidden="true" />
      </DropdownMenuPrimitive.ItemIndicator>
    </span>
    <span className="min-w-0 flex-1 truncate">{children}</span>
  </DropdownMenuPrimitive.RadioItem>
));

DropdownMenuRadioItem.displayName = DropdownMenuPrimitive.RadioItem.displayName;

export const DropdownMenuLabel = forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Label
    ref={ref}
    className={cn("px-2 py-1.5 text-caption font-semibold text-muted-foreground", className)}
    {...props}
  />
));

DropdownMenuLabel.displayName = DropdownMenuPrimitive.Label.displayName;

export const DropdownMenuSeparator = forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Separator
    ref={ref}
    className={cn("glass-divider -mx-1 my-1 h-px bg-border/50", className)}
    {...props}
  />
));

DropdownMenuSeparator.displayName = DropdownMenuPrimitive.Separator.displayName;
