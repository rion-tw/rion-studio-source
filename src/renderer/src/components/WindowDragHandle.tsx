import { type HTMLAttributes, type JSX, type MouseEvent, type PointerEvent, type ReactNode } from "react";

import { cn } from "../lib/utils";

interface WindowDragHandleProps extends Omit<HTMLAttributes<HTMLDivElement>, "onMouseDown"> {
  children?: ReactNode;
}

export function WindowDragHandle({ children, className, ...props }: WindowDragHandleProps): JSX.Element {
  function handlePointerDown(event: PointerEvent<HTMLDivElement>): void {
    if (event.button === 0 && event.isPrimary !== false) {
      event.stopPropagation();
    }
  }

  function handleMouseDown(event: MouseEvent<HTMLDivElement>): void {
    if (event.button !== 0) return;

    event.preventDefault();
    event.stopPropagation();

    if (event.detail === 1) {
      void window.rionStudio.startCurrentWindowDrag()
        .catch((error) => console.error("Main window drag failed.", error));
      return;
    }

    if (event.detail === 2) {
      void window.rionStudio.toggleCurrentWindowMaximize()
        .catch((error) => console.error("Main window maximize toggle failed.", error));
    }
  }

  return (
    <div
      className={cn("app-no-drag", className)}
      data-selection-ignore
      data-window-drag-handle
      onMouseDown={handleMouseDown}
      onPointerDown={handlePointerDown}
      {...props}
    >
      {children}
    </div>
  );
}
