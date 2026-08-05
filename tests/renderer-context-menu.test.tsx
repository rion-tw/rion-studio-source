// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from "../src/renderer/src/components/ui/context-menu";
import { useNativeContextMenuSuppression } from "../src/renderer/src/hooks/useNativeContextMenuSuppression";

afterEach(() => {
  cleanup();
});

describe("renderer context menus", () => {
  it("suppresses native context menus for the mounted Studio renderer and cleans up on unmount", () => {
    const { unmount } = render(<NativeContextMenuSuppressionHarness />);

    const whileMounted = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    expect(document.body.dispatchEvent(whileMounted)).toBe(false);
    expect(whileMounted.defaultPrevented).toBe(true);

    unmount();

    const afterUnmount = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    expect(document.body.dispatchEvent(afterUnmount)).toBe(true);
    expect(afterUnmount.defaultPrevented).toBe(false);
  });

  it("opens a collision-aware menu from the contextmenu pointer event and runs its action", () => {
    const onEdit = vi.fn();
    render(
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div data-testid="list-item">List item</div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={onEdit}>Edit</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );

    const opened = fireEvent.contextMenu(screen.getByTestId("list-item"), { clientX: 216, clientY: 128 });

    expect(opened).toBe(false);
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Edit" })).toBeTruthy();

    fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    expect(onEdit).toHaveBeenCalledOnce();
  });
});

function NativeContextMenuSuppressionHarness(): null {
  useNativeContextMenuSuppression();
  return null;
}
