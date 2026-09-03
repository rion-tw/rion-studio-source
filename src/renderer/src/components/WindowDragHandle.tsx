import {
  type HTMLAttributes,
  type JSX,
  type MouseEvent,
  type PointerEvent,
  type ReactNode
} from "react";

import { cn } from "../lib/utils";

interface WindowDragHandleProps extends Omit<
  HTMLAttributes<HTMLElement>,
  "onDoubleClick" | "onMouseDown" | "onPointerDown"
> {
  as?: "aside" | "div";
  children?: ReactNode;
}

function isNestedNoDragTarget(
  target: EventTarget,
  currentTarget: HTMLElement
): boolean {
  return target instanceof Element
    && target.closest(".app-no-drag") !== currentTarget;
}

function acceptsWindowGesture(
  event: MouseEvent<HTMLElement> | PointerEvent<HTMLElement>
): boolean {
  return event.button === 0
    && document.documentElement.dataset.windowFullscreen !== "true"
    && !isNestedNoDragTarget(event.target, event.currentTarget);
}

export function WindowDragHandle({
  as: Element = "div",
  children,
  className,
  ...props
}: WindowDragHandleProps): JSX.Element {
  // Windows owns native non-client gestures. macOS keeps its typed AppKit gesture bridge.
  const usesNativeNonClientRegion =
    document.documentElement.dataset.windowGestureMode === "native-non-client";

  function handlePointerDown(event: PointerEvent<HTMLElement>): void {
    if (event.isPrimary !== false && acceptsWindowGesture(event)) {
      event.stopPropagation();
    }
  }

  function handleMouseDown(event: MouseEvent<HTMLElement>): void {
    if (!acceptsWindowGesture(event) || (event.detail !== 1 && event.detail !== 2)) return;

    event.preventDefault();
    event.stopPropagation();
    const request = event.detail === 2
      ? window.rionStudio.toggleCurrentWindowMaximize()
      : window.rionStudio.startCurrentWindowDrag();
    const action = event.detail === 2 ? "maximize toggle" : "drag";
    void request.catch((error) => console.error(`Main window ${action} failed.`, error));
  }

  return (
    <Element
      {...props}
      className={cn(usesNativeNonClientRegion ? "app-drag" : "app-no-drag", className)}
      data-selection-ignore
      data-window-drag-handle
      onMouseDown={usesNativeNonClientRegion ? undefined : handleMouseDown}
      onPointerDown={usesNativeNonClientRegion ? undefined : handlePointerDown}
    >
      {children}
    </Element>
  );
}
