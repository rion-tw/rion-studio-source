import { Plus } from "lucide-react";
import { type ButtonHTMLAttributes, type JSX } from "react";

import { cn } from "../lib/utils";
import { Card } from "./ui/card";

interface CreateItemButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
}

export function CreateItemCard({ className, label, ...props }: CreateItemButtonProps): JSX.Element {
  return (
    <Card className={cn("group h-full overflow-hidden border-dashed", className)}>
      <button
        className="flex size-full min-h-40 flex-col items-center justify-center gap-3 bg-muted/10 px-5 py-8 text-center text-muted-foreground transition-[background-color,color] hover:bg-accent/20 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/30"
        type="button"
        {...props}
      >
        <span className="grid size-12 place-items-center rounded-full border border-dashed border-current/45 bg-background/20 transition-transform group-hover:scale-105">
          <Plus aria-hidden="true" size={24} strokeWidth={1.5} />
        </span>
        <span className="text-sm font-semibold leading-5">{label}</span>
      </button>
    </Card>
  );
}

export function CreateItemRow({ className, label, ...props }: CreateItemButtonProps): JSX.Element {
  return (
    <button
      className={cn(
        "group flex min-h-[52px] w-full items-center gap-2.5 rounded-md border border-dashed border-border/45 bg-background/10 px-2.5 py-2 text-left text-muted-foreground transition-[background-color,border-color,color] hover:border-border/65 hover:bg-background/25 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/30",
        className
      )}
      type="button"
      {...props}
    >
      <span className="grid size-[var(--control-height)] shrink-0 place-items-center rounded-full border border-dashed border-current/45 bg-background/20 transition-transform group-hover:scale-105">
        <Plus aria-hidden="true" size={15} strokeWidth={1.75} />
      </span>
      <span className="text-body font-semibold">{label}</span>
    </button>
  );
}
