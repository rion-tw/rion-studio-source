import { type SelectHTMLAttributes, forwardRef } from "react";

import { cn } from "../../lib/utils";

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(
        "glass-control glass-select flex h-[30px] w-full rounded-md px-2.5 text-[12px] leading-none text-foreground transition-colors hover:text-foreground focus-visible:border-ring/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-45",
        className
      )}
      {...props}
    />
  )
);

Select.displayName = "Select";
