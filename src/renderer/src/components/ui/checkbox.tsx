import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check } from "lucide-react";
import { forwardRef } from "react";

import { cn } from "../../lib/utils";

export const Checkbox = forwardRef<
  React.ComponentRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      "group/checkbox peer inline-grid size-3.5 shrink-0 place-items-center rounded-[4px] text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/25 disabled:cursor-not-allowed disabled:opacity-45",
      className
    )}
    {...props}
  >
    <span
      aria-hidden="true"
      className="inline-flex size-3.5 items-center justify-center rounded-[4px] border border-input bg-background/70 transition-[background-color,border-color,box-shadow] group-data-[state=checked]/checkbox:border-blue-500 group-data-[state=checked]/checkbox:bg-blue-500"
      data-slot="checkbox-visual"
    >
      <CheckboxPrimitive.Indicator className="grid place-items-center">
        <Check className="size-2.5 stroke-[3]" />
      </CheckboxPrimitive.Indicator>
    </span>
  </CheckboxPrimitive.Root>
));

Checkbox.displayName = CheckboxPrimitive.Root.displayName;
