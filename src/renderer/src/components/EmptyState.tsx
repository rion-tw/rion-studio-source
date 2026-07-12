import { type JSX } from "react";
import { type LucideIcon } from "lucide-react";

import { Button } from "./ui/button";
import { IconTile, Surface } from "./ui/patterns";

interface EmptyStateProps {
  actionLabel: string;
  description: string;
  icon: LucideIcon;
  onAction: () => void;
  title: string;
}

export function EmptyState({ actionLabel, description, icon: Icon, onAction, title }: EmptyStateProps): JSX.Element {
  return (
    <Surface className="grid min-h-[420px] place-items-center border-dashed text-center" padding="lg">
      <div className="max-w-sm">
        <IconTile className="mx-auto" size="lg">
          <Icon size={22} />
        </IconTile>
        <h2 className="mt-4 text-[17px] font-semibold leading-6 tracking-normal">{title}</h2>
        <p className="mt-2 text-[13px] leading-6 text-muted-foreground">{description}</p>
        <Button className="mt-5" type="button" variant="outline" onClick={onAction}>
          {actionLabel}
        </Button>
      </div>
    </Surface>
  );
}
