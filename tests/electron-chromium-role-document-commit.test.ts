// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { ChromiumCompatibleInputCommand } from
  "../src/electron/ipc/chromiumCompatibleInputProtocol";
import { ChromiumCdpInputTransport } from "../src/electron/main/chromiumCdpInputTransport";
import { ChromiumCompatibleInput } from "../src/electron/main/chromiumCompatibleInput";
import { ChromiumRoleOverlayCoordinator } from
  "../src/electron/main/chromiumRoleOverlayCoordinator";
import type { ChromiumRoleNavigationLifecycleEvent } from
  "../src/electron/main/chromiumRoleSurfaceRegistry";
import type { ChromiumNativeTrustedInputRequest } from
  "../src/electron/main/chromiumTrustedInputCoordinator";
import { type FakeWebContents, harness } from "./helpers/chromiumRoleSurfaceRegistryHarness";
import { installMacroOverlayTestLifecycle, installOverlay } from
  "./helpers/macroOverlayKeyboardHarness";

// Electron reports these with did-start-navigation and then only
// did-stop-loading: the page that started them keeps running.
const NON_COMMITTING = [
  ["a 204 No Content response", "https://game.test/ping"],
  ["a download response", "https://game.test/save.bin"]
] as const;

async function activeRole(platform: "darwin" | "win32" = "darwin") {
  const subject = harness(undefined, undefined, null, null, null, null, {}, platform);
  const creation = subject.registry.create(subject.input());
  const contents = subject.views[0].webContents;
  contents.finish("https://game.test/launch");
  await creation;
  return { registry: subject.registry, contents };
}

function startNavigation(contents: FakeWebContents, url: string): void {
  contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false, url });
}

function commitNavigation(contents: FakeWebContents, frameToken: string): void {
  contents.mainFrame = Object.freeze({ frameToken });
  contents.emit("did-navigate", {}, "https://game.test/next", 200, "OK");
}

async function settledNow(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
  return settled;
}

function keyRequest(
  phase: "rawKeyDown" | "keyUp",
  sequence: number
): ChromiumNativeTrustedInputRequest {
  const down = phase === "rawKeyDown";
  return {
    requestId: `request-${sequence}`, roleId: "role-1", inputEpoch: 1,
    intent: down ? "normal" : "cleanup", scheduledAtMs: Date.now(),
    deadlineMs: Date.now() + 60_000, surfaceGeneration: 1,
    expectedInputNeutralityBefore: !down, expectedInputNeutralityAfter: !down,
    action: { type: "key", code: "KeyJ", key: "J", modifiers: [], exactModifierCodes: [],
      phase: down ? "hold" : "release", ownerId: "owner", modifierOwnership: "synthetic",
      suppressOverlayShortcut: true },
    keyEffect: { code: "KeyJ", phase, autoRepeat: false, suppressShortcut: true,
      activeCodesBefore: down ? [] : ["KeyJ"], activeCodes: down ? ["KeyJ"] : [] }
  };
}

describe.each(["darwin", "win32"] as const)("%s navigation that stops before committing", (platform) => {
  async function observedRole() {
    const { registry, contents } = await activeRole(platform);
    const events: ChromiumRoleNavigationLifecycleEvent[] = [];
    registry.subscribeNavigationLifecycle((event) => { events.push(event); });
    const before = registry.currentOverlayFrame("role-1", 1);
    return { before, contents, events, registry };
  }

  it.each(NON_COMMITTING)("reports the running document as retained after %s", async (_case, url) => {
    const { before, contents, events, registry } = await observedRole();
    startNavigation(contents, url);
    // A loading subframe only delays the stop; it never starts a main-frame navigation.
    contents.emit("did-start-navigation", {
      isMainFrame: false, isSameDocument: false, url: "https://game.test/ad"
    });
    contents.emit("did-stop-loading");
    contents.emit("did-stop-loading");
    expect(events).toEqual([
      expect.objectContaining({ type: "navigation-started" }),
      {
        documentInstanceId: before.documentInstanceId,
        generation: 1,
        navigationSequence: 0,
        roleId: "role-1",
        tabId: "tab-1",
        type: "navigation-retained"
      }
    ]);
    expect(registry.currentOverlayFrame("role-1", 1).documentInstanceId)
      .toBe(before.documentInstanceId);
  });

  it("reports a controlled reload that beforeunload cancels before it starts", async () => {
    const { before, contents, events, registry } = await observedRole();
    const preparation = registry.acquireControlledReloadFence(
      registry.preflightControlledReload("role-1", 1),
      "reload-1"
    );
    registry.submitControlledReload(preparation, "reload-1");
    expect(contents.reloadCount).toBe(1);
    // Electron 44 emits only did-start-loading, will-prevent-unload and this.
    contents.emit("did-stop-loading");
    expect(events).toEqual([expect.objectContaining({
      documentInstanceId: before.documentInstanceId,
      navigationSequence: 0,
      type: "navigation-retained"
    })]);
    expect(registry.releaseControlledReloadFence(
      "role-1", 1, "reload-1", before.documentInstanceId
    )).toBe(true);
  });

  it("reports nothing for a stop after a commit or without a main-frame start", async () => {
    const { contents, events } = await observedRole();
    contents.emit("did-stop-loading");
    startNavigation(contents, "https://game.test/next");
    commitNavigation(contents, "frame-token-2");
    contents.emit("did-stop-loading");
    expect(events.map((event) => event.type))
      .toEqual(["navigation-started", "document-started"]);
  });
});

describe.each(["darwin", "win32"] as const)("%s Macro input across a main-frame navigation", (platform) => {
  installMacroOverlayTestLifecycle();

  async function compatibleRole() {
    const { registry, contents } = await activeRole();
    const delivered: ChromiumCompatibleInputCommand[] = [];
    const canvasEvents: string[] = [];
    const installPage = (frameToken: string) => {
      vi.stubGlobal("__rionStudioDocumentInstanceId", frameToken);
      document.body.replaceChildren();
      const canvas = document.createElement("canvas");
      canvas.tabIndex = 0;
      document.body.append(canvas);
      vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 640, 480));
      for (const type of ["keydown", "keyup"]) {
        canvas.addEventListener(type, (event) => canvasEvents.push(`${frameToken}:${event.type}`));
      }
      canvas.focus();
      return installOverlay();
    };
    // Isolated world 1004 is this jsdom page running the real overlay runtime.
    contents.executeJavaScriptInIsolatedWorld = async (_worldId, scripts) => {
      const source = scripts[0]!.code;
      delivered.push(JSON.parse(/const command = (.+);\n/u.exec(source)![1]!));
      return window.eval(source) as unknown;
    };
    const lane = new ChromiumCompatibleInput({
      platform,
      port: registry,
      nowMs: () => Date.now(),
      timers: { setTimeout: () => 0, cancel: () => undefined }
    });
    // The macOS and Windows trusted-input adapters retire the lane per event.
    registry.subscribeTrustedInputLifecycle((event) => lane.retire(event.roleId));
    let sequence = 0;
    const send = (phase: "rawKeyDown" | "keyUp") => lane.dispatch(
      keyRequest(phase, ++sequence),
      registry.currentTrustedInputFrame("role-1", 1),
      [],
      null,
      () => undefined
    );
    return { registry, contents, delivered, canvasEvents, installPage, send };
  }

  it.each(NON_COMMITTING)("still releases a held key after %s", async (_case, url) => {
    const role = await compatibleRole();
    role.installPage("frame-token-1");
    const documentInstanceId = role.registry.currentTrustedInputFrame("role-1", 1)
      .documentInstanceId;

    expect(await role.send("rawKeyDown")).toMatchObject({ status: "applied" });
    startNavigation(role.contents, url);
    // The surviving page accepts only an increasing sequence for one identity,
    // so this cleanup release proves neither was reset by the start.
    expect(await role.send("keyUp")).toMatchObject({
      status: "applied",
      confirmedInputNeutrality: true
    });
    expect(role.delivered.map((command) => [command.sequence, command.documentInstanceId]))
      .toEqual([[1, documentInstanceId], [2, documentInstanceId]]);
    expect(role.canvasEvents).toEqual(["frame-token-1:keydown", "frame-token-1:keyup"]);
  });

  it("restarts delivery for the document a commit installs", async () => {
    const role = await compatibleRole();
    const firstPage = role.installPage("frame-token-1");
    const first = role.registry.currentTrustedInputFrame("role-1", 1);
    expect(await role.send("rawKeyDown")).toMatchObject({ status: "applied" });

    commitNavigation(role.contents, "frame-token-2");
    firstPage.dispose();
    role.installPage("frame-token-2");
    const second = role.registry.currentTrustedInputFrame("role-1", 1);
    expect(second.documentInstanceId).not.toBe(first.documentInstanceId);
    expect(await role.send("rawKeyDown")).toMatchObject({ status: "applied" });
    expect(role.delivered.map((command) =>
      [command.frameToken, command.sequence, command.documentInstanceId]))
      .toEqual([
        ["frame-token-1", 1, first.documentInstanceId],
        ["frame-token-2", 1, second.documentInstanceId]
      ]);
  });
});

describe("Role overlay readiness across a main-frame navigation", () => {
  async function overlayRole() {
    const { registry, contents } = await activeRole();
    const overlays = new ChromiumRoleOverlayCoordinator({
      core: { overlayRequest: vi.fn() },
      surfaces: registry,
      runtime: { coordinateContext: vi.fn() }
    });
    const firstPage = { sender: contents, senderFrame: contents.mainFrame };
    await overlays.receive(firstPage, { frameToken: "frame-token-1", method: "ready" });
    return { contents, firstPage, overlays };
  }

  it.each(NON_COMMITTING)("keeps the running page ready after %s", async (_case, url) => {
    const { contents, firstPage, overlays } = await overlayRole();
    startNavigation(contents, url);
    expect(await settledNow(overlays.install(["role-1"], () => 1))).toBe(true);
    await expect(overlays.receive(firstPage, { frameToken: "frame-token-1", method: "ready" }))
      .resolves.toMatchObject({ status: "ready" });
    overlays.dispose();
  });

  it("waits for the committed document's own readiness", async () => {
    const { contents, firstPage, overlays } = await overlayRole();
    startNavigation(contents, "https://game.test/next");
    commitNavigation(contents, "frame-token-2");
    const install = overlays.install(["role-1"], () => 1);
    expect(await settledNow(install)).toBe(false);
    await expect(overlays.receive(firstPage, { frameToken: "frame-token-1", method: "ready" }))
      .resolves.toEqual({ status: "superseded" });
    await overlays.receive(
      { sender: contents, senderFrame: contents.mainFrame },
      { frameToken: "frame-token-2", method: "ready" }
    );
    await expect(install).resolves.toBeUndefined();
    overlays.dispose();
  });
});

describe.each(["darwin", "win32"] as const)("%s CDP Input across a main-frame navigation", (platform) => {
  async function cdpRole() {
    const { registry, contents } = await activeRole();
    let attached = false;
    const debuggerPort = {
      isAttached: () => attached,
      attach: vi.fn(() => { attached = true; }),
      detach: vi.fn(() => { attached = false; }),
      sendCommand: vi.fn(async () => Object.freeze({})),
      on: vi.fn(),
      removeListener: vi.fn()
    };
    Object.assign(contents, { id: 7, debugger: debuggerPort });
    const transport = new ChromiumCdpInputTransport({ platform, surfaces: registry });
    const terminal = vi.fn();
    transport.subscribeTerminal(terminal);
    const dispatch = () => transport.dispatchKey(
      registry.currentTrustedInputFrame("role-1", 1),
      keyRequest("rawKeyDown", 1).keyEffect!
    );
    return { contents, debuggerPort, dispatch, terminal, transport };
  }

  it.each(NON_COMMITTING)("keeps the exact session after %s", async (_case, url) => {
    const role = await cdpRole();
    await role.dispatch();
    startNavigation(role.contents, url);
    await expect(role.dispatch()).resolves.toMatchObject({ acceptedCommandCount: 1 });
    expect(role.debuggerPort.attach).toHaveBeenCalledOnce();
    expect(role.debuggerPort.sendCommand).toHaveBeenCalledTimes(2);
    expect(role.terminal).not.toHaveBeenCalled();
    role.transport.dispose();
  });

  it("terminalizes the session when a new document commits", async () => {
    const role = await cdpRole();
    await role.dispatch();
    startNavigation(role.contents, "https://game.test/next");
    expect(role.terminal).not.toHaveBeenCalled();
    commitNavigation(role.contents, "frame-token-2");
    expect(role.terminal).toHaveBeenCalledWith({
      identity: expect.objectContaining({ frameToken: "frame-token-1" }),
      reason: "document-replacing"
    });
    expect(role.debuggerPort.detach).toHaveBeenCalledOnce();
    role.transport.dispose();
  });
});
