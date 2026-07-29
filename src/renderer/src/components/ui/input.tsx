import { type InputHTMLAttributes, forwardRef } from "react";

import { cn } from "../../lib/utils";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(
        "glass-control flex h-[var(--control-height)] min-h-[var(--control-min-size)] min-w-[var(--control-min-size)] w-full rounded-sm px-2.5 text-control leading-none text-foreground transition-colors placeholder:text-muted-foreground hover:text-foreground focus-visible:border-ring/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-45",
        className
      )}
      {...props}
    />
  )
);

Input.displayName = "Input";
