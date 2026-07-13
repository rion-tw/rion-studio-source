import { type TextareaHTMLAttributes, forwardRef } from "react";

import { cn } from "../../lib/utils";

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        "glass-control flex min-h-20 w-full resize-y rounded-md px-2.5 py-2 text-[12px] leading-5 text-foreground transition-colors placeholder:text-muted-foreground hover:text-foreground focus-visible:border-ring/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-45",
        className
      )}
      {...props}
    />
  )
);

Textarea.displayName = "Textarea";
