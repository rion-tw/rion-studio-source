import { type HTMLAttributes, type JSX, type ReactNode } from "react";

import { cn } from "../lib/utils";

interface WindowDragHandleProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "onDoubleClick" | "onMouseDown" | "onPointerDown"
> {
  children?: ReactNode;
}

export function WindowDragHandle({ children, className, ...props }: WindowDragHandleProps): JSX.Element {
  return (
    <div
      {...props}
      className={cn("app-drag", className)}
      data-selection-ignore
      data-window-drag-handle
    >
      {children}
    </div>
  );
}
