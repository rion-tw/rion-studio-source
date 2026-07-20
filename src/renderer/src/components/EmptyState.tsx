import { type JSX } from "react";
import { type LucideIcon } from "lucide-react";

import { Button } from "./ui/button";
import { IconTile } from "./ui/patterns";
import { cn } from "../lib/utils";

interface EmptyStateProps {
  actionLabel?: string;
  className?: string;
  description?: string;
  icon: LucideIcon;
  onAction?: () => void;
  onSecondaryAction?: () => void;
  secondaryActionDisabled?: boolean;
  secondaryActionLabel?: string;
  title: string;
}

export function EmptyState({
  actionLabel,
  className,
  description,
  icon: Icon,
  onAction,
  onSecondaryAction,
  secondaryActionDisabled = false,
  secondaryActionLabel,
  title
}: EmptyStateProps): JSX.Element {
  return (
    <div className={cn("grid min-h-[420px] place-items-center text-center", className)}>
      <div className="max-w-sm">
        <IconTile className="mx-auto" size="lg">
          <Icon size={22} />
        </IconTile>
        <h2 className="mt-4 text-[17px] font-semibold leading-6 tracking-normal">{title}</h2>
        {description ? <p className="mt-2 text-[13px] leading-6 text-muted-foreground">{description}</p> : null}
        {actionLabel && onAction ? (
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            <Button type="button" variant="outline" onClick={onAction}>
              {actionLabel}
            </Button>
            {secondaryActionLabel && onSecondaryAction ? (
              <Button
                type="button"
                variant="secondary"
                disabled={secondaryActionDisabled}
                onClick={onSecondaryAction}
              >
                {secondaryActionLabel}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
