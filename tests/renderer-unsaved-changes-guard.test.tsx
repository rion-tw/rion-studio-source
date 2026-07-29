// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type JSX, useState } from "react";
import { createMemoryRouter, RouterProvider, useNavigate } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ConfirmationProvider } from "../src/renderer/src/components/ConfirmationDialog";
import { ApplicationQuitGuardProvider } from "../src/renderer/src/components/ApplicationQuitGuard";
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
    const bridge = installBridge();
    renderGuard({ dirty: true });

    const event = dispatchBeforeUnload();
    await user.click(await screen.findByRole("button", { name: "Keep editing" }));

    expect(event.defaultPrevented).toBe(true);
    expect(bridge.requestCurrentWindowClose).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("requests one native close after discarding and suppresses duplicate prompts", async () => {
    const user = userEvent.setup();
    const bridge = installBridge();
    renderGuard({ dirty: true });

    const firstEvent = dispatchBeforeUnload();
    const repeatedEvent = dispatchBeforeUnload();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Discard changes" }));

    expect(firstEvent.defaultPrevented).toBe(true);
    expect(repeatedEvent.defaultPrevented).toBe(true);
    expect(bridge.requestCurrentWindowClose).toHaveBeenCalledOnce();
  });

  it("blocks native close without offering discard while a save is in progress", () => {
    const bridge = installBridge();
    renderGuard({ dirty: true, locked: true });

    const event = dispatchBeforeUnload();

    expect(event.defaultPrevented).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(bridge.requestCurrentWindowClose).not.toHaveBeenCalled();
  });

  it("preserves the existing confirmation flow for router navigation", async () => {
    const user = userEvent.setup();
    const bridge = installBridge();
    renderGuard({ dirty: true, includeNextRoute: true });

    await user.click(screen.getByRole("button", { name: "Leave editor" }));
    await user.click(await screen.findByRole("button", { name: "Keep editing" }));
    expect(screen.getByText("Editor")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Leave editor" }));
    await user.click(await screen.findByRole("button", { name: "Discard changes" }));

    expect(await screen.findByText("Next route")).toBeTruthy();
    expect(bridge.requestCurrentWindowClose).not.toHaveBeenCalled();
  });

  it("confirms a native application quit immediately when the editor is clean", async () => {
    const bridge = installBridge();
    renderGuard({ dirty: false });

    act(() => bridge.requestApplicationQuit());

    await vi.waitFor(() => {
      expect(bridge.confirmApplicationQuit).toHaveBeenCalledOnce();
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("uses one discard prompt for repeated native quit requests", async () => {
    const user = userEvent.setup();
    const bridge = installBridge();
    renderGuard({ dirty: true });

    act(() => {
      bridge.requestApplicationQuit();
      bridge.requestApplicationQuit();
    });
    expect(await screen.findAllByRole("dialog")).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Keep editing" }));

    expect(bridge.confirmApplicationQuit).not.toHaveBeenCalled();
  });

  it("waits for an active save before reevaluating the native quit request", async () => {
    const user = userEvent.setup();
    const bridge = installBridge();
    renderGuard({ dirty: true, locked: true });

    act(() => bridge.requestApplicationQuit());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(bridge.confirmApplicationQuit).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Finish saving" }));
    await user.click(await screen.findByRole("button", { name: "Discard changes" }));

    expect(bridge.confirmApplicationQuit).toHaveBeenCalledOnce();
  });
});

function GuardHarness({ dirty, locked = false }: { dirty: boolean; locked?: boolean }): JSX.Element {
  const navigate = useNavigate();
  const [isLocked, setIsLocked] = useState(locked);
  useUnsavedChangesGuard(dirty, confirmationOptions, isLocked);

  return (
    <div>
      <span>Editor</span>
      <button type="button" onClick={() => navigate("/next")}>Leave editor</button>
      {isLocked ? (
        <button type="button" onClick={() => setIsLocked(false)}>Finish saving</button>
      ) : null}
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
        <ApplicationQuitGuardProvider>
          <GuardHarness dirty={dirty} locked={locked} />
        </ApplicationQuitGuardProvider>
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

function installBridge(): {
  confirmApplicationQuit: ReturnType<typeof vi.fn>;
  requestApplicationQuit: () => void;
  requestCurrentWindowClose: ReturnType<typeof vi.fn>;
} {
  let applicationQuitRequested: (() => void) | null = null;
  const confirmApplicationQuit = vi.fn().mockResolvedValue(undefined);
  const requestCurrentWindowClose = vi.fn();
  Object.defineProperty(window, "rionStudio", {
    configurable: true,
    value: {
      confirmApplicationQuit,
      onApplicationQuitRequested: (callback: () => void) => {
        applicationQuitRequested = callback;
        return () => {
          applicationQuitRequested = null;
        };
      },
      requestCurrentWindowClose
    }
  });
  return {
    confirmApplicationQuit,
    requestApplicationQuit: () => applicationQuitRequested?.(),
    requestCurrentWindowClose
  };
}
