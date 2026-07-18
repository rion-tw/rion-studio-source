import { type ButtonHTMLAttributes, forwardRef } from "react";

import { cn } from "../../lib/utils";

export interface SwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> {
  checked: boolean;
  onCheckedChange?: (checked: boolean) => void;
}

export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(
  ({ checked, className, disabled, onCheckedChange, onClick, type = "button", ...props }, ref) => (
    <button
      {...props}
      ref={ref}
      aria-checked={checked}
      className={cn(
        "inline-grid h-[var(--control-min-size)] min-w-9 shrink-0 place-items-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-45",
        className
      )}
      data-state={checked ? "checked" : "unchecked"}
      disabled={disabled}
      role="switch"
      type={type}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) {
          onCheckedChange?.(!checked);
        }
      }}
    >
      <span
        aria-hidden="true"
        className={cn(
          "inline-flex h-5 w-9 items-center rounded-full border p-0.5 transition-[background-color,border-color,box-shadow]",
          checked
            ? "border-blue-500/70 bg-blue-500 shadow-sm shadow-blue-500/15"
            : "border-border/65 bg-muted/75"
        )}
      >
        <span
          className={cn(
            "block size-3.5 rounded-full bg-white shadow-sm transition-transform",
            checked ? "translate-x-4" : "translate-x-0"
          )}
        />
      </span>
    </button>
  )
);

Switch.displayName = "Switch";
