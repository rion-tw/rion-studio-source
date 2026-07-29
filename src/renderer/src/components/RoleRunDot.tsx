import { type JSX } from "react";

import { cn } from "../lib/utils";

interface RoleRunDotProps {
  className?: string;
  isActive: boolean;
  label: string;
}

export function RoleRunDot({ className, isActive, label }: RoleRunDotProps): JSX.Element {
  return (
    <span
      aria-label={label}
      className={cn(
        "inline-flex size-2 shrink-0 rounded-full",
        isActive ? "bg-activity" : "bg-muted-foreground/45",
        className
      )}
      role="img"
      title={label}
    />
  );
}
