import { cva, type VariantProps } from "class-variance-authority";
import { type HTMLAttributes } from "react";

import { cn } from "../../lib/utils";

const badgeVariants = cva(
  "ui-badge inline-flex h-5 max-w-full min-w-0 items-center overflow-hidden whitespace-nowrap rounded-full border px-2 text-caption leading-none text-ellipsis transition-colors [&>svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "border-primary-foreground/20 bg-primary/90 text-primary-foreground",
        secondary: "glass-control text-secondary-foreground shadow-none",
        outline: "glass-control text-foreground shadow-none",
        success: "border-success-foreground/15 bg-success/80 text-success-foreground",
        warning: "border-warning-foreground/15 bg-warning/80 text-warning-foreground",
        muted: "glass-inset text-muted-foreground shadow-none",
        activity: "border-activity/25 bg-activity/12 text-activity",
        destructive:
          "border-destructive-foreground/15 bg-destructive/90 text-destructive-foreground"
      }
    },
    defaultVariants: {
      variant: "default"
    }
  }
);

interface BadgeProps extends HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ className, variant }))} {...props} />;
}
