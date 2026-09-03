// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type JSX } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RionStudioApi } from "../src/shared/api";
import {
  hasBlockingQuickAccessDialog,
  useQuickAccessPresentation
} from "../src/renderer/src/features/quick-access/useQuickAccessPresentation";

const ignoreError = (): void => undefined;

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "rionStudio");
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("in-game Quick Access presentation", () => {
  it("ignores requests while onboarding or another blocking dialog is active", async () => {
    const bridge = installBridge({ pendingRequestId: "blocked-onboarding" });
    const { rerender } = render(<PresentationHarness enabled={false} />);
    await waitFor(() => expect(bridge.resolve).toHaveBeenCalledWith(
      "blocked-onboarding",
      "ignored"
    ));
    expect(bridge.present).not.toHaveBeenCalled();

    bridge.consume.mockResolvedValueOnce({ requestId: "blocked-modal" });
    rerender(<><dialog open /><PresentationHarness enabled /></>);
    await waitFor(() => expect(bridge.resolve).toHaveBeenCalledWith(
      "blocked-modal",
      "ignored"
    ));
    expect(screen.getByTestId("presentation-state").textContent).toBe("closed");
  });

  it.each([
    { button: "Cancel", resolution: "cancel" },
    { button: "Complete", resolution: "complete" }
  ] as const)("presents an accepted request and resolves $resolution without DOM focus restore", async ({
    button,
    resolution
  }) => {
    const bridge = installBridge({ pendingRequestId: `accepted-${resolution}` });
    render(<PresentationHarness enabled />);

    await waitFor(() => expect(screen.getByTestId("presentation-state").textContent).toBe("open"));
    expect(screen.getByTestId("managed-request-state").textContent).toBe("active");
    expect(bridge.present).toHaveBeenCalledWith(`accepted-${resolution}`);
    fireEvent.click(screen.getByRole("button", { name: button }));

    expect(screen.getByTestId("presentation-state").textContent).toBe("closed");
    expect(screen.getByTestId("managed-request-state").textContent).toBe("inactive");
    expect(screen.getByTestId("restore-focus").textContent).toBe("skip");
    expect(bridge.resolve).toHaveBeenCalledWith(`accepted-${resolution}`, resolution);
  });

  it("keeps a stale or superseded request from opening the palette", async () => {
    const bridge = installBridge({ pendingRequestId: "stale", presentResult: false });
    render(<PresentationHarness enabled />);

    await waitFor(() => expect(bridge.present).toHaveBeenCalledWith("stale"));
    expect(screen.getByTestId("presentation-state").textContent).toBe("closed");
    expect(screen.getByTestId("managed-request-state").textContent).toBe("inactive");
  });

  it("does not treat the Quick Access palette itself as a blocking dialog", () => {
    document.body.innerHTML = '<dialog data-testid="quick-access-palette" open></dialog>';
    expect(hasBlockingQuickAccessDialog(document)).toBe(false);
    document.body.insertAdjacentHTML("beforeend", '<div aria-modal="true"></div>');
    expect(hasBlockingQuickAccessDialog(document)).toBe(true);
  });
});

function PresentationHarness({ enabled }: { enabled: boolean }): JSX.Element {
  const presentation = useQuickAccessPresentation({
    enabled,
    hasBridge: true,
    onError: ignoreError
  });
  return (
    <>
      <output data-testid="presentation-state">
        {presentation.isOpen ? "open" : "closed"}
      </output>
      <output data-testid="restore-focus">
        {presentation.restoreDomFocusOnClose ? "restore" : "skip"}
      </output>
      <output data-testid="managed-request-state">
        {presentation.isManagedRequestActive() ? "active" : "inactive"}
      </output>
      <button type="button" onClick={() => presentation.close("cancel")}>Cancel</button>
      <button type="button" onClick={() => presentation.close("complete")}>Complete</button>
    </>
  );
}

function installBridge({
  pendingRequestId,
  presentResult = true
}: {
  pendingRequestId: string;
  presentResult?: boolean;
}): {
  consume: ReturnType<typeof vi.fn>;
  emitRequest: () => void;
  present: ReturnType<typeof vi.fn>;
  resolve: ReturnType<typeof vi.fn>;
} {
  let requested: (() => void) | undefined;
  const consume = vi.fn().mockResolvedValueOnce({ requestId: pendingRequestId });
  const present = vi.fn().mockResolvedValue(presentResult);
  const resolve = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(window, "rionStudio", {
    configurable: true,
    value: {
      consumePendingQuickAccessRequest: consume,
      onQuickAccessRequested: (callback: () => void) => {
        requested = callback;
        return () => {
          requested = undefined;
        };
      },
      presentQuickAccessRequest: present,
      resolveQuickAccessRequest: resolve
    } as unknown as RionStudioApi
  });
  return {
    consume,
    emitRequest: () => requested?.(),
    present,
    resolve
  };
}
