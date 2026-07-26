// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  getPointerDragTargetId,
  usePointerDrag
} from "../src/renderer/src/hooks/usePointerDrag";

beforeAll(() => {
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: vi.fn()
  });
});

afterEach(() => {
  cleanup();
  document.body.classList.remove("pointer-drag-active");
  vi.mocked(document.elementFromPoint).mockReset();
  vi.restoreAllMocks();
});

describe("pointer drag controller", () => {
  it("keeps clicks below the movement threshold and drops after activation", () => {
    const onClick = vi.fn();
    const onDrop = vi.fn();
    render(<PointerDragHarness onClick={onClick} onDrop={onDrop} />);
    const source = screen.getByRole("button", { name: "Drag source" });
    const target = screen.getByTestId("drop-target");
    vi.mocked(document.elementFromPoint).mockReturnValue(target);

    fireEvent.pointerDown(source, pointerEvent(1, 10, 10));
    fireEvent.pointerMove(window, pointerEvent(1, 13, 10));
    fireEvent.pointerUp(window, pointerEvent(1, 13, 10));
    fireEvent.click(source);

    expect(onDrop).not.toHaveBeenCalled();
    expect(onClick).toHaveBeenCalledOnce();

    fireEvent.pointerDown(source, pointerEvent(2, 10, 10));
    fireEvent.pointerMove(window, pointerEvent(2, 20, 10));
    expect(source.getAttribute("data-dragging")).toBe("true");
    expect(document.body.classList.contains("pointer-drag-active")).toBe(true);
    fireEvent.pointerUp(window, pointerEvent(2, 20, 10));
    fireEvent.click(source);

    expect(onDrop).toHaveBeenCalledWith("source", "target");
    expect(onClick).toHaveBeenCalledOnce();
    expect(document.body.classList.contains("pointer-drag-active")).toBe(false);
  });

  it("cancels active dragging on Escape and pointer cancellation", () => {
    const onDrop = vi.fn();
    render(<PointerDragHarness onClick={vi.fn()} onDrop={onDrop} />);
    const source = screen.getByRole("button", { name: "Drag source" });
    const target = screen.getByTestId("drop-target");
    vi.mocked(document.elementFromPoint).mockReturnValue(target);

    fireEvent.pointerDown(source, pointerEvent(3, 10, 10));
    fireEvent.pointerMove(window, pointerEvent(3, 20, 10));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onDrop).not.toHaveBeenCalled();
    expect(source.getAttribute("data-dragging")).toBe("false");

    fireEvent.pointerDown(source, pointerEvent(4, 10, 10));
    fireEvent.pointerMove(window, pointerEvent(4, 20, 10));
    fireEvent.pointerCancel(window, pointerEvent(4, 20, 10));
    expect(onDrop).not.toHaveBeenCalled();
    expect(document.body.classList.contains("pointer-drag-active")).toBe(false);
  });

  it("ignores disabled, secondary, non-primary, and targetless gestures", () => {
    const onDrop = vi.fn();
    const { rerender } = render(
      <PointerDragHarness disabled onClick={vi.fn()} onDrop={onDrop} />
    );
    const source = screen.getByRole("button", { name: "Drag source" });
    const target = screen.getByTestId("drop-target");
    vi.mocked(document.elementFromPoint).mockReturnValue(target);

    pointerDrag(source, 6, { button: 0, isPrimary: true });
    rerender(<PointerDragHarness onClick={vi.fn()} onDrop={onDrop} />);
    pointerDrag(source, 7, { button: 2, isPrimary: true });
    pointerDrag(source, 8, { button: 0, isPrimary: false });
    vi.mocked(document.elementFromPoint).mockReturnValue(null);
    pointerDrag(source, 9, { button: 0, isPrimary: true });

    expect(onDrop).not.toHaveBeenCalled();
  });

  it("auto-scrolls the configured container near its edge", () => {
    let scheduledFrame: FrameRequestCallback | undefined;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      scheduledFrame = callback;
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    render(<PointerDragHarness onClick={vi.fn()} onDrop={vi.fn()} />);
    const source = screen.getByRole("button", { name: "Drag source" });
    const target = screen.getByTestId("drop-target");
    const scrollContainer = screen.getByTestId("scroll-container");
    vi.mocked(document.elementFromPoint).mockReturnValue(target);
    setBounds(scrollContainer, 0, 0, 100, 100);
    scrollContainer.scrollTop = 10;

    fireEvent.pointerDown(source, pointerEvent(5, 50, 50));
    fireEvent.pointerMove(window, pointerEvent(5, 50, 99));
    scheduledFrame?.(0);

    expect(scrollContainer.scrollTop).toBeGreaterThan(10);
    fireEvent.pointerUp(window, pointerEvent(5, 50, 99));
  });
});

function PointerDragHarness({
  disabled = false,
  onClick,
  onDrop
}: {
  disabled?: boolean;
  onClick: () => void;
  onDrop: (sourceId: string, targetId: string) => void;
}) {
  const drag = usePointerDrag<string>({
    disabled,
    getScrollContainer: () => document.querySelector<HTMLElement>("[data-testid='scroll-container']"),
    getTargetId: (clientX, clientY) =>
      getPointerDragTargetId(clientX, clientY, "data-pointer-drag-target"),
    onDrop
  });

  return (
    <div data-testid="scroll-container">
      <button
        aria-label="Drag source"
        data-dragging={drag.isDragging}
        type="button"
        onClick={onClick}
        onPointerDown={(event) => drag.start(event, "source")}
      />
      <div data-pointer-drag-target="target" data-testid="drop-target" />
    </div>
  );
}

function pointerEvent(pointerId: number, clientX: number, clientY: number) {
  return {
    button: 0,
    clientX,
    clientY,
    isPrimary: true,
    pointerId
  };
}

function pointerDrag(
  source: HTMLElement,
  pointerId: number,
  options: { button: number; isPrimary: boolean }
): void {
  fireEvent.pointerDown(source, {
    ...pointerEvent(pointerId, 10, 10),
    ...options
  });
  fireEvent.pointerMove(window, {
    ...pointerEvent(pointerId, 20, 10),
    ...options
  });
  fireEvent.pointerUp(window, {
    ...pointerEvent(pointerId, 20, 10),
    ...options
  });
}

function setBounds(element: HTMLElement, left: number, top: number, width: number, height: number): void {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      bottom: top + height,
      height,
      left,
      right: left + width,
      top,
      width,
      x: left,
      y: top,
      toJSON: () => ({})
    })
  });
}
