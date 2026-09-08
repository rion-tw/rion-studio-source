import { type HTMLAttributes, type JSX, type ReactNode } from "react";

import { cn } from "../lib/utils";

interface WindowDragHandleProps extends Omit<
  HTMLAttributes<HTMLElement>,
  "onDoubleClick" | "onMouseDown" | "onPointerDown"
> {
  as?: "aside" | "div";
  children?: ReactNode;
}

export function WindowDragHandle({
  as: Element = "div",
  children,
  className,
  ...props
}: WindowDragHandleProps): JSX.Element {
  // Electron owns native non-client gestures on both supported platforms.
  const usesNativeNonClientRegion =
    document.documentElement.dataset.windowGestureMode === "native-non-client";

  return (
    <Element
      {...props}
      className={cn(usesNativeNonClientRegion ? "app-drag" : "app-no-drag", className)}
      data-selection-ignore
      data-window-drag-handle
    >
      {children}
    </Element>
  );
}
