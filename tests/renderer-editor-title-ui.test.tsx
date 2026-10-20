// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EditorPage } from "../src/renderer/src/components/EditorPage";

afterEach(cleanup);

describe("editor page title", () => {
  it("renders a static heading without a contenteditable name control", () => {
    render(
      <EditorPage
        backActionLabel="Back"
        backLabel="Back to list"
        description="Edit this item"
        isSaving={false}
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
        saveIcon={null}
        saveLabel="Save"
        title="Edit item"
      >
        <div>Editor content</div>
      </EditorPage>
    );

    expect(screen.getByRole("heading", { level: 1, name: "Edit item" })).toBeTruthy();
    expect(document.querySelector("[contenteditable]")).toBeNull();
  });

  it("leaves only on an Escape that no open layer or IME composition consumed", () => {
    const onCancel = vi.fn();
    render(
      <EditorPage
        backActionLabel="Back"
        backLabel="Back to list"
        description="Edit this item"
        isSaving={false}
        onCancel={onCancel}
        onSubmit={vi.fn()}
        saveIcon={null}
        saveLabel="Save"
        title="Edit item"
      >
        <button type="button">Open list</button>
      </EditorPage>
    );
    const control = screen.getByRole("button", { name: "Open list" });
    const consume = (event: KeyboardEvent) => event.preventDefault();
    document.addEventListener("keydown", consume, { capture: true });
    fireEvent.keyDown(control, { key: "Escape" });
    document.removeEventListener("keydown", consume, { capture: true });
    fireEvent.keyDown(control, { key: "Escape", isComposing: true });
    fireEvent.keyDown(control, { key: "Escape", keyCode: 229 });
    expect(onCancel).not.toHaveBeenCalled();

    fireEvent.keyDown(control, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
