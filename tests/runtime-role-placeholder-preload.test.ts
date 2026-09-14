// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  RUNTIME_ROLE_PLACEHOLDER_CHANNEL,
  RUNTIME_ROLE_PLACEHOLDER_STATE_CHANNEL
} from "../src/shared/runtimeRolePlaceholder";

const ipc = vi.hoisted(() => ({ on: vi.fn(), invoke: vi.fn(), send: vi.fn() }));
vi.mock("electron", () => ({ ipcRenderer: ipc }));

describe("visible Role placeholder", () => {
  it("retains the selected wording and sends an absent-owner claim once through state updates", async () => {
    document.body.innerHTML = '<h1 id="role-name"></h1><p id="message"></p><button id="claim"></button><p id="error" hidden></p>';
    document.body.setAttribute("data-rion-runtime-role-placeholder", "");
    const state = {
      blocked: true, generation: 1, ownerGeneration: null, ownerTabName: null,
      placeholderId: "role-placeholder:target:slot", roleId: "role", roleName: "里優",
      slotId: "slot", tabId: "target", topologyRevision: 2, windowGeneration: 1,
      windowId: "window"
    };
    let rejectClaim!: (error: unknown) => void;
    ipc.invoke.mockResolvedValueOnce(state).mockImplementationOnce(() => new Promise(
      (_resolve, reject) => { rejectClaim = reject; }
    ));
    await import("../src/electron/preload/workspaceWebChrome");
    window.dispatchEvent(new Event("DOMContentLoaded"));
    await Promise.resolve();
    const button = document.querySelector<HTMLButtonElement>("#claim")!;
    expect(document.querySelector("#message")?.textContent).toBe('This role is open in “another tab”.');
    expect(button.textContent).toBe("Stop there and open here");
    button.click();
    expect(ipc.invoke).toHaveBeenLastCalledWith(RUNTIME_ROLE_PLACEHOLDER_CHANNEL, {
      type: "claim", generation: 1, ownerGeneration: null,
      placeholderId: state.placeholderId, roleId: "role", slotId: "slot", tabId: "target",
      topologyRevision: 2, windowGeneration: 1, windowId: "window"
    });
    const receive = ipc.on.mock.calls.find(([channel]) => channel === RUNTIME_ROLE_PLACEHOLDER_STATE_CHANNEL)![1];
    receive({}, { ...state, topologyRevision: 3 });
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("Opening…");
    button.click();
    expect(ipc.invoke).toHaveBeenCalledTimes(2);
    rejectClaim(new Error("load failed"));
    await Promise.resolve();
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe("Stop there and open here");
    expect(document.querySelector<HTMLElement>("#error")?.hidden).toBe(false);
    ipc.invoke.mockResolvedValueOnce({});
    button.click();
    expect(ipc.invoke.mock.calls.at(-1)?.[1]).toMatchObject({ topologyRevision: 3 });
  });
});
