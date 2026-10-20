// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Columns2 } from "lucide-react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { EditorPage } from "../src/renderer/src/components/EditorPage";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "../src/renderer/src/components/ui/select";

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
    scrollIntoView: {
      configurable: true,
      value: () => undefined
    },
    setPointerCapture: {
      configurable: true,
      value: () => undefined
    }
  });
});

afterEach(cleanup);

describe("select width constraints", () => {
  it("truncates long values and options without growing beyond its container", async () => {
    const user = userEvent.setup();

    render(
      <div className="w-48">
        <Select defaultValue="long">
          <SelectTrigger aria-label="Target display">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="long">
              <Columns2 className="size-4 shrink-0" aria-hidden="true" />
              <span className="truncate">Two columns with a long layout name</span>
            </SelectItem>
            <SelectItem value="display">
              Studio Display (2) · 5120×2880 · Primary display
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
    );

    const trigger = screen.getByRole("combobox", { name: "Target display" });
    expect([...trigger.classList]).toEqual(expect.arrayContaining([
      "min-h-[var(--control-min-size)]",
      "min-w-[var(--control-min-size)]",
      "max-w-full",
      "overflow-hidden"
    ]));
    expect([...trigger.classList]).toEqual(expect.arrayContaining([
      "[&_[data-slot=select-value]]:block",
      "[&_[data-slot=select-value]]:min-w-0",
      "[&_[data-slot=select-value]]:flex-1",
      "[&_[data-slot=select-value]]:truncate"
    ]));

    const selectedValue = trigger.querySelector("[data-slot=select-value]");
    const structuredContent = selectedValue?.querySelector("[data-slot=select-item-content]");
    expect(structuredContent?.querySelector("svg")).not.toBeNull();
    expect(structuredContent?.textContent).toContain("Two columns");
    expect([...structuredContent!.classList]).toEqual(expect.arrayContaining(["flex", "overflow-hidden"]));

    await user.click(trigger);

    expect([...screen.getByRole("listbox").classList]).toContain("max-w-[calc(100vw-1rem)]");

    const option = screen.getByRole("option", { name: /Two columns/ });
    expect([...option.classList]).toEqual(expect.arrayContaining(["max-w-full", "overflow-hidden"]));
    expect([...option.classList]).toContain("min-h-[var(--control-min-size)]");
    expect([...option.classList]).toContain("[&>span:last-child]:overflow-hidden");

    await user.click(screen.getByRole("option", { name: /Studio Display/ }));

    const plainTextContent = trigger.querySelector("[data-slot=select-item-content]");
    expect(plainTextContent?.textContent).toContain("Studio Display");
    expect([...plainTextContent!.classList]).toEqual(expect.arrayContaining(["block", "truncate"]));
  });

  it("closes an open Select with Escape without leaving its editor page", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();

    render(
      <EditorPage backActionLabel="Back" backLabel="Back to list" description="Edit this macro" isSaving={false} onCancel={onCancel}
        onSubmit={() => undefined} saveIcon={null} saveLabel="Save" title="Edit macro">
        <Select defaultValue="key">
          <SelectTrigger aria-label="Step type"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="key">Key</SelectItem>
            <SelectItem value="delay">Delay</SelectItem>
          </SelectContent>
        </Select>
      </EditorPage>
    );

    await user.click(screen.getByRole("combobox", { name: "Step type" }));
    expect(screen.getByRole("listbox")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onCancel).not.toHaveBeenCalled();

    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
