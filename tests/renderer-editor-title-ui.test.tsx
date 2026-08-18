// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
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
});
