// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const identity = {
  blocked: true,
  ownerGeneration: 7,
  ownerTabName: "Source party",
  roleId: "role-1",
  roleName: "Knight",
  slotId: "slot-2",
  tabId: "tab-target"
};

function mountPlaceholder(): void {
  document.body.innerHTML = `
    <h1 id="role-name"></h1>
    <p id="message"></p>
    <button id="claim" type="button"></button>
    <p id="error" hidden></p>
  `;
  globalThis.__rionRoleSlotIdentity = identity;
}

describe("runtime role placeholder", () => {
  beforeEach(() => {
    vi.resetModules();
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
    mountPlaceholder();
  });

  it("shows the owner and disables the exact claim while it is pending", async () => {
    let finish!: () => void;
    invoke.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    await import("../src/renderer/runtime-shell/runtimeRolePlaceholder");

    const button = document.querySelector<HTMLButtonElement>("#claim")!;
    expect(document.querySelector("#role-name")?.textContent).toBe("Knight");
    expect(document.querySelector("#message")?.textContent).toContain("Source party");
    expect(button.textContent).toBe("Stop there and open here");
    expect(invoke).toHaveBeenCalledWith("rion_runtime_role_slot_ready", { action: identity });

    button.click();
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("Opening…");
    expect(invoke).toHaveBeenCalledWith("rion_runtime_role_slot_action", { action: identity });
    finish();
  });

  it("restores a retryable button and exposes a bounded error on failure", async () => {
    invoke.mockRejectedValue(new Error("rejected"));
    await import("../src/renderer/runtime-shell/runtimeRolePlaceholder");

    const button = document.querySelector<HTMLButtonElement>("#claim")!;
    button.click();
    await vi.waitFor(() => expect(button.disabled).toBe(false));
    expect(button.textContent).toBe("Stop there and open here");
    expect(document.querySelector<HTMLElement>("#error")?.hidden).toBe(false);
    expect(document.querySelector("#error")?.textContent).toBe(
      "Could not open the role. Try again."
    );
  });

  it("offers a direct open action when no owner exists", async () => {
    globalThis.__rionRoleSlotIdentity = {
      ...identity,
      blocked: false,
      ownerGeneration: undefined,
      ownerTabName: undefined
    };
    await import("../src/renderer/runtime-shell/runtimeRolePlaceholder");

    expect(document.querySelector("#message")?.textContent).toBe(
      "This role is currently stopped."
    );
    expect(document.querySelector("#claim")?.textContent).toBe("Open here");
  });

  it("keeps an unverified previous surface unavailable", async () => {
    globalThis.__rionRoleSlotIdentity = {
      ...identity,
      unavailable: true
    };
    await import("../src/renderer/runtime-shell/runtimeRolePlaceholder");

    expect(document.querySelector("#message")?.textContent).toBe(
      "The previous game page is still shutting down."
    );
    expect(document.querySelector<HTMLButtonElement>("#claim")?.disabled).toBe(true);
    const unavailableIdentity = { ...identity, unavailable: true };
    expect(invoke).toHaveBeenCalledWith("rion_runtime_role_slot_ready", {
      action: unavailableIdentity
    });
    expect(invoke).not.toHaveBeenCalledWith("rion_runtime_role_slot_action", {
      action: unavailableIdentity
    });
  });
});
