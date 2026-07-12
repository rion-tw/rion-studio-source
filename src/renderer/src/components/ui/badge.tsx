import { cva, type VariantProps } from "class-variance-authority";
import { type HTMLAttributes } from "react";

import { cn } from "../../lib/utils";

const badgeVariants = cva(
  "inline-flex h-5 items-center rounded-full border px-2 text-[11px] font-semibold leading-none transition-colors backdrop-blur-xl",
  {
    variants: {
      variant: {
        default: "border-white/20 bg-primary/90 text-primary-foreground",
        secondary: "glass-control text-secondary-foreground shadow-none",
        outline: "glass-control text-foreground shadow-none",
        success: "border-success-foreground/15 bg-success/80 text-success-foreground",
        warning: "border-warning-foreground/15 bg-warning/80 text-warning-foreground",
        muted: "glass-inset text-muted-foreground shadow-none",
        destructive:
          "border-white/15 bg-destructive/90 text-destructive-foreground"
      }
    },
    defaultVariants: {
      variant: "default"
    }
  }
);

export interface BadgeProps extends HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ className, variant }))} {...props} />;
}
