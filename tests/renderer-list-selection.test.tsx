// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { type JSX, useCallback, useRef, useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { SelectionMarquee } from "../src/renderer/src/components/ListSelection";
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

  it("keeps the marquee in the scroll container and extends its selection while auto-scrolling", () => {
    let nextFrame: FrameRequestCallback | undefined;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      nextFrame = callback;
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    render(<SelectionHarness ids={["one", "two"]} />);
    const scrollContainer = screen.getByTestId("scroll-container");
    const collection = screen.getByTestId("collection");
    setBounds(scrollContainer, 100, 50, 200, 100);
    setScrollableBounds(screen.getByTestId("one"), scrollContainer, 10, 30, 40, 20);
    setScrollableBounds(screen.getByTestId("two"), scrollContainer, 10, 110, 40, 20);

    fireEvent.pointerDown(collection, { button: 0, clientX: 110, clientY: 70, isPrimary: true, pointerId: 2 });
    fireEvent.pointerMove(collection, { clientX: 150, clientY: 148, isPrimary: true, pointerId: 2 });
    expect(screen.getByTestId("selected").textContent).toBe("one");

    const marquee = document.querySelector<HTMLElement>("[data-selection-marquee]");
    expect(marquee?.parentElement).toBe(scrollContainer);
    expect(marquee?.className).toContain("absolute");
    expect(marquee?.className).not.toContain("fixed");
    expect(marquee?.style.top).toBe("20px");
    expect(marquee?.style.height).toBe("78px");

    act(() => nextFrame?.(0));

    expect(scrollContainer.scrollTop).toBeGreaterThan(0);
    expect(screen.getByTestId("selected").textContent).toBe("one,two");
    expect(marquee?.style.top).toBe("20px");
    expect(Number.parseFloat(marquee?.style.height ?? "0")).toBeGreaterThan(78);
    fireEvent.pointerUp(collection, { clientX: 150, clientY: 148, isPrimary: true, pointerId: 2 });
  });
});

function SelectionHarness({ ids, onAction = () => undefined }: { ids: string[]; onAction?: () => void }): JSX.Element {
  const scrollContainerRef = useRef<HTMLElement | null>(null);
  const [scrollContainer, setScrollContainer] = useState<HTMLElement | null>(null);
  const selection = useListSelection({ orderedIds: ids, scrollContainerRef });
  const setScrollContainerRef = useCallback((element: HTMLElement | null): void => {
    scrollContainerRef.current = element;
    setScrollContainer(element);
  }, []);

  return (
    <section ref={setScrollContainerRef} data-testid="scroll-container">
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
      <SelectionMarquee container={scrollContainer} rect={selection.selectionRect} />
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

function setScrollableBounds(
  element: HTMLElement,
  scrollContainer: HTMLElement,
  contentLeft: number,
  contentTop: number,
  width: number,
  height: number
): void {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => {
      const containerBounds = scrollContainer.getBoundingClientRect();
      const left = containerBounds.left + contentLeft - scrollContainer.scrollLeft;
      const top = containerBounds.top + contentTop - scrollContainer.scrollTop;
      return {
        bottom: top + height,
        height,
        left,
        right: left + width,
        top,
        width,
        x: left,
        y: top,
        toJSON: () => ({})
      };
    }
  });
}
