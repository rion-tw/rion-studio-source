// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { MacroCommandImportDialog } from "../src/renderer/src/features/macros/MacroModal";
import en from "../src/renderer/src/i18n/en.json";
import type { Translator } from "../src/renderer/src/i18n";

const t: Translator = (key) => en[key] ?? key;

beforeAll(() => {
  Object.defineProperties(HTMLDialogElement.prototype, {
    close: {
      configurable: true,
      value: function close(this: HTMLDialogElement): void {
        this.removeAttribute("open");
      }
    },
    showModal: {
      configurable: true,
      value: function showModal(this: HTMLDialogElement): void {
        this.setAttribute("open", "");
      }
    }
  });
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("MacroCommandImportDialog", () => {
  it("previews supported steps and appends them only after confirmation", () => {
    const onImport = vi.fn();
    const onClose = vi.fn();

    render(
      <MacroCommandImportDialog
        existingStepCount={2}
        isOpen
        macros={[]}
        onClose={onClose}
        onImport={onImport}
        t={t}
      />
    );

    fireEvent.change(screen.getByLabelText("Macro command sequence"), {
      target: { value: "A>wait:10>click:25%,50%>say:unsupported" }
    });

    expect(screen.getByText("Key:A")).toBeTruthy();
    expect(screen.getByText("Delay:10ms")).toBeTruthy();
    expect(screen.getByText("Click:X 25%, Y 50%")).toBeTruthy();
    expect(screen.getByText('Unsupported command "say:unsupported" was skipped.')).toBeTruthy();
    expect(onImport).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Import 3 steps" }));

    expect(onImport).toHaveBeenCalledTimes(1);
    expect(onImport.mock.calls[0]?.[0]).toHaveLength(3);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes without changing steps when cancelled", () => {
    const onImport = vi.fn();
    const onClose = vi.fn();

    render(
      <MacroCommandImportDialog
        existingStepCount={0}
        isOpen
        macros={[]}
        onClose={onClose}
        onImport={onImport}
        t={t}
      />
    );

    fireEvent.change(screen.getByLabelText("Macro command sequence"), {
      target: { value: "A>wait:10" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onImport).not.toHaveBeenCalled();
  });

  it("disables confirmation when the combined list exceeds 100 steps", () => {
    render(
      <MacroCommandImportDialog
        existingStepCount={100}
        isOpen
        macros={[]}
        onClose={vi.fn()}
        onImport={vi.fn()}
        t={t}
      />
    );

    fireEvent.change(screen.getByLabelText("Macro command sequence"), {
      target: { value: "A" }
    });

    expect(screen.getByText("The import exceeds the 100-step limit. You can import at most 0 more steps.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Import 1 steps" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
