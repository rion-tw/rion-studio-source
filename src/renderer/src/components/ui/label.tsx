import { type LabelHTMLAttributes, forwardRef } from "react";

import { cn } from "../../lib/utils";

export const Label = forwardRef<HTMLLabelElement, LabelHTMLAttributes<HTMLLabelElement>>(
  ({ className, ...props }, ref) => (
    <label
      ref={ref}
      className={cn("grid gap-1.5 text-body font-semibold leading-none text-foreground", className)}
      {...props}
    />
  )
);

Label.displayName = "Label";
