// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { type JSX, useRef } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { useListSelection } from "../src/renderer/src/hooks/useListSelection";

beforeAll(() => {
  if (!("PointerEvent" in window)) {
    Object.defineProperty(window, "PointerEvent", {
      configurable: true,
      value: MouseEvent
    });
  }
  Object.defineProperties(HTMLElement.prototype, {
    hasPointerCapture: {
      configurable: true,
      value: () => false
    },
    releasePointerCapture: {
      configurable: true,
      value: () => undefined
    },
    setPointerCapture: {
      configurable: true,
      value: () => undefined
    }
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("list selection", () => {
  it("starts a marquee only after the drag threshold and selects intersecting items", () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    render(<SelectionHarness ids={["one", "two"]} />);
    setBounds(screen.getByTestId("one"), 10, 10, 40, 40);
    setBounds(screen.getByTestId("two"), 80, 10, 40, 40);
    const collection = screen.getByTestId("collection");

    fireEvent.pointerDown(collection, { button: 0, clientX: 0, clientY: 0, isPrimary: true, pointerId: 1 });
    fireEvent.pointerMove(collection, { clientX: 2, clientY: 2, isPrimary: true, pointerId: 1 });
    expect(screen.getByTestId("selected").textContent).toBe("");

    fireEvent.pointerMove(collection, { clientX: 55, clientY: 55, isPrimary: true, pointerId: 1 });
    expect(screen.getByTestId("selected").textContent).toBe("one");
    fireEvent.pointerUp(collection, { clientX: 55, clientY: 55, isPrimary: true, pointerId: 1 });
  });

  it("supports macOS Meta, Windows Ctrl, Shift ranges, select-all, and Escape", () => {
    render(<SelectionHarness ids={["one", "two", "three"]} />);

    fireEvent.click(screen.getByTestId("one"), { metaKey: true });
    fireEvent.click(screen.getByTestId("three"), { ctrlKey: true });
    expect(screen.getByTestId("selected").textContent).toBe("one,three");

    fireEvent.click(screen.getByTestId("two"), { shiftKey: true });
    expect(screen.getByTestId("selected").textContent).toBe("two,three");

    fireEvent.keyDown(window, { ctrlKey: true, key: "a" });
    expect(screen.getByTestId("selected").textContent).toBe("one,two,three");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByTestId("selected").textContent).toBe("");
  });

  it("preserves normal interactive clicks but consumes modifier clicks for selection", () => {
    const onAction = vi.fn();
    render(<SelectionHarness ids={["one"]} onAction={onAction} />);
    const action = screen.getByRole("button", { name: "Open one" });

    fireEvent.click(action);
    expect(onAction).toHaveBeenCalledOnce();
    expect(screen.getByTestId("selected").textContent).toBe("");

    fireEvent.click(action, { metaKey: true });
    expect(onAction).toHaveBeenCalledOnce();
    expect(screen.getByTestId("selected").textContent).toBe("one");
  });

  it("prunes selected ids when filtering changes the visible collection", () => {
    const { rerender } = render(<SelectionHarness ids={["one", "two"]} />);
    fireEvent.keyDown(window, { metaKey: true, key: "a" });
    expect(screen.getByTestId("selected").textContent).toBe("one,two");

    rerender(<SelectionHarness ids={["two"]} />);
    expect(screen.getByTestId("selected").textContent).toBe("two");
  });

  it("auto-scrolls the page when a marquee reaches the lower edge", () => {
    let nextFrame: FrameRequestCallback | undefined;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      nextFrame = callback;
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    render(<SelectionHarness ids={["one"]} />);
    const scrollContainer = screen.getByTestId("scroll-container");
    const collection = screen.getByTestId("collection");
    setBounds(scrollContainer, 0, 0, 200, 100);

    fireEvent.pointerDown(collection, { button: 0, clientX: 0, clientY: 20, isPrimary: true, pointerId: 2 });
    fireEvent.pointerMove(collection, { clientX: 20, clientY: 98, isPrimary: true, pointerId: 2 });
    nextFrame?.(0);

    expect(scrollContainer.scrollTop).toBeGreaterThan(0);
    fireEvent.pointerUp(collection, { clientX: 20, clientY: 98, isPrimary: true, pointerId: 2 });
  });
});

function SelectionHarness({ ids, onAction = () => undefined }: { ids: string[]; onAction?: () => void }): JSX.Element {
  const scrollContainerRef = useRef<HTMLElement | null>(null);
  const selection = useListSelection({ orderedIds: ids, scrollContainerRef });

  return (
    <section ref={scrollContainerRef} data-testid="scroll-container">
      <div data-testid="collection" {...selection.collectionProps}>
        {ids.map((id) => (
          <div
            key={id}
            ref={selection.registerItem(id)}
            data-selection-id={id}
            data-testid={id}
            onClickCapture={(event) => selection.handleItemClick(event, id)}
          >
            <button type="button" onClick={onAction}>Open {id}</button>
          </div>
        ))}
      </div>
      <output data-testid="selected">
        {ids.filter((id) => selection.selectedIds.has(id)).join(",")}
      </output>
    </section>
  );
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
