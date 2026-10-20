// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { type JSX, useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { LegalDocumentDialog } from "../src/renderer/src/features/legal/LegalDocumentDialog";
import type { Translator } from "../src/renderer/src/i18n";
import en from "../src/renderer/src/i18n/en.json";

const t: Translator = (key) => en[key];

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

describe("legal document dialog", () => {
  it("opens as a native modal, keeps focus inside, and returns focus to its opener", () => {
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Terms of Use" });
    opener.focus();
    fireEvent.click(opener);

    const dialog = screen.getByRole("dialog", { name: "Terms of Use" });
    expect(dialog.tagName).toBe("DIALOG");
    expect(dialog.hasAttribute("open")).toBe(true);
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement?.getAttribute("role")).toBe("region");

    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("closes from the backdrop but not from clicks inside the document", () => {
    const onClose = vi.fn();
    render(<LegalDocumentDialog kind="terms" language="en" t={t} onClose={onClose} />);
    const dialog = screen.getByRole("dialog", { name: "Terms of Use" });

    fireEvent.click(screen.getByRole("region", { name: "Terms of Use" }));
    expect(onClose).not.toHaveBeenCalled();
    // Selecting text inside the document and releasing over the backdrop.
    fireEvent.pointerDown(screen.getByRole("region", { name: "Terms of Use" }));
    fireEvent.click(dialog);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(dialog);
    fireEvent.click(dialog);
    expect(onClose).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Close legal document" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

function Harness(): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Terms of Use</button>
      {open ? <LegalDocumentDialog kind="terms" language="en" t={t} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
