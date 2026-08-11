// @vitest-environment jsdom

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EditorPage } from "../src/renderer/src/components/EditorPage";
import { PageFrame } from "../src/renderer/src/components/ui/patterns";

beforeEach(() => {
  document.documentElement.dataset.windowControlsScrolled = "false";
});

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.windowControlsScrolled;
});

describe("Windows caption control scroll state", () => {
  it("tracks restored and live PageFrame scroll positions and resets on unmount", () => {
    const scrollPositionRef = { current: 28 };
    const view = render(
      <PageFrame scrollPositionRef={scrollPositionRef}>
        <div>Page content</div>
      </PageFrame>
    );
    const page = view.container.querySelector<HTMLElement>(".app-page")!;

    expect(page.scrollTop).toBe(28);
    expect(document.documentElement.dataset.windowControlsScrolled).toBe("true");

    page.scrollTop = 0;
    fireEvent.scroll(page);
    expect(document.documentElement.dataset.windowControlsScrolled).toBe("false");

    page.scrollTop = 1;
    fireEvent.scroll(page);
    expect(document.documentElement.dataset.windowControlsScrolled).toBe("true");

    view.unmount();
    expect(document.documentElement.dataset.windowControlsScrolled).toBe("false");
  });

  it("tracks editor page scrolling and resets on unmount", () => {
    const view = render(
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
        title="Item"
        titleAriaLabel="Item name"
        titlePlaceholder="Untitled item"
      >
        <div>Editor content</div>
      </EditorPage>
    );
    const form = view.container.querySelector<HTMLFormElement>("#app-editor-form")!;

    expect(document.documentElement.dataset.windowControlsScrolled).toBe("false");
    form.scrollTop = 12;
    fireEvent.scroll(form);
    expect(document.documentElement.dataset.windowControlsScrolled).toBe("true");

    view.unmount();
    expect(document.documentElement.dataset.windowControlsScrolled).toBe("false");
  });
});
