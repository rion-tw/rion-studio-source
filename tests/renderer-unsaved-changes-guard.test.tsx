// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type JSX } from "react";
import { createMemoryRouter, RouterProvider, useNavigate } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ConfirmationProvider } from "../src/renderer/src/components/ConfirmationDialog";
import { useUnsavedChangesGuard } from "../src/renderer/src/hooks/useUnsavedChangesGuard";

const confirmationOptions = {
  cancelLabel: "Keep editing",
  confirmLabel: "Discard changes",
  description: "Your changes will be lost if you leave this editor.",
  title: "Discard unsaved changes?",
  tone: "destructive" as const
};

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
  cleanup();
  Reflect.deleteProperty(window, "rionStudio");
  vi.restoreAllMocks();
});

describe("useUnsavedChangesGuard", () => {
  it("does not intercept window close when the editor is clean", () => {
    renderGuard({ dirty: false });

    const event = dispatchBeforeUnload();

    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps the window open when the user continues editing", async () => {
    const user = userEvent.setup();
    const requestCurrentWindowClose = installBridge();
    renderGuard({ dirty: true });

    const event = dispatchBeforeUnload();
    await user.click(await screen.findByRole("button", { name: "Keep editing" }));

    expect(event.defaultPrevented).toBe(true);
    expect(requestCurrentWindowClose).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("requests one native close after discarding and suppresses duplicate prompts", async () => {
    const user = userEvent.setup();
    const requestCurrentWindowClose = installBridge();
    renderGuard({ dirty: true });

    const firstEvent = dispatchBeforeUnload();
    const repeatedEvent = dispatchBeforeUnload();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Discard changes" }));

    expect(firstEvent.defaultPrevented).toBe(true);
    expect(repeatedEvent.defaultPrevented).toBe(true);
    expect(requestCurrentWindowClose).toHaveBeenCalledOnce();
  });

  it("blocks native close without offering discard while a save is in progress", () => {
    const requestCurrentWindowClose = installBridge();
    renderGuard({ dirty: true, locked: true });

    const event = dispatchBeforeUnload();

    expect(event.defaultPrevented).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(requestCurrentWindowClose).not.toHaveBeenCalled();
  });

  it("preserves the existing confirmation flow for router navigation", async () => {
    const user = userEvent.setup();
    const requestCurrentWindowClose = installBridge();
    renderGuard({ dirty: true, includeNextRoute: true });

    await user.click(screen.getByRole("button", { name: "Leave editor" }));
    await user.click(await screen.findByRole("button", { name: "Keep editing" }));
    expect(screen.getByText("Editor")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Leave editor" }));
    await user.click(await screen.findByRole("button", { name: "Discard changes" }));

    expect(await screen.findByText("Next route")).toBeTruthy();
    expect(requestCurrentWindowClose).not.toHaveBeenCalled();
  });
});

function GuardHarness({ dirty, locked = false }: { dirty: boolean; locked?: boolean }): JSX.Element {
  const navigate = useNavigate();
  useUnsavedChangesGuard(dirty, confirmationOptions, locked);

  return (
    <div>
      <span>Editor</span>
      <button type="button" onClick={() => navigate("/next")}>Leave editor</button>
    </div>
  );
}

function renderGuard({
  dirty,
  includeNextRoute = false,
  locked = false
}: {
  dirty: boolean;
  includeNextRoute?: boolean;
  locked?: boolean;
}): void {
  const routes = [{
    path: "/",
    element: (
      <ConfirmationProvider>
        <GuardHarness dirty={dirty} locked={locked} />
      </ConfirmationProvider>
    )
  }];

  if (includeNextRoute) {
    routes.push({ path: "/next", element: <span>Next route</span> });
  }

  const router = createMemoryRouter(routes, { initialEntries: ["/"] });
  render(<RouterProvider router={router} />);
}

function dispatchBeforeUnload(): Event {
  const event = new Event("beforeunload", { cancelable: true });
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
}

function installBridge() {
  const requestCurrentWindowClose = vi.fn();
  Object.defineProperty(window, "rionStudio", {
    configurable: true,
    value: { requestCurrentWindowClose }
  });
  return requestCurrentWindowClose;
}
