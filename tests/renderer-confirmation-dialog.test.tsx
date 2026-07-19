// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type JSX } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { ConfirmationProvider } from "../src/renderer/src/components/ConfirmationDialog";
import { useConfirmation } from "../src/renderer/src/components/confirmation";

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

afterEach(cleanup);

describe("ConfirmationDialog", () => {
  it("renders structured targets and a destructive warning", async () => {
    const user = userEvent.setup();
    render(<ConfirmationProvider><OpenConfirmation /></ConfirmationProvider>);

    await user.click(screen.getByRole("button", { name: "Open" }));

    expect(screen.getByText("Embedded and external data")).toBeTruthy();
    expect(screen.getByText("The role will stop")).toBeTruthy();
    expect(screen.getByText("This cannot be undone")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
  });
});

function OpenConfirmation(): JSX.Element {
  const confirm = useConfirmation();
  return (
    <button
      type="button"
      onClick={() => void confirm({
        cancelLabel: "Cancel",
        confirmLabel: "Clear data",
        description: "Clear this role's data.",
        details: ["Embedded and external data", "The role will stop"],
        title: "Clear data?",
        tone: "destructive",
        warning: "This cannot be undone"
      })}
    >
      Open
    </button>
  );
}
