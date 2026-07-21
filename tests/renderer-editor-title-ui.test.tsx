// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EditorPage } from "../src/renderer/src/components/EditorPage";

afterEach(cleanup);

describe("editor page title", () => {
  it("keeps an empty localized title visible and clickable", () => {
    render(
      <EditorPage
        backActionLabel="Back"
        backLabel="Back to list"
        description="Edit this item"
        isSaving={false}
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
        onTitleChange={vi.fn()}
        saveIcon={null}
        saveLabel="Save"
        title=""
        titleAriaLabel="Item name"
        titlePlaceholder="Untitled item"
      >
        <div>Editor content</div>
      </EditorPage>
    );

    const title = screen.getByRole("textbox", { name: "Item name" });

    expect(title.getAttribute("aria-placeholder")).toBe("Untitled item");
    expect(title.getAttribute("data-placeholder")).toBe("Untitled item");
    expect(title.getAttribute("data-empty")).toBe("true");
    expect(title.className).toContain("min-w-48");
  });
});
