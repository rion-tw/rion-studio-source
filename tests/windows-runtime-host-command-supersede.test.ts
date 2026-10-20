import { describe, expect, it, vi } from "vitest";

import {
  documentUrl, harness, projection, secondTabId, tabId, windowId
} from "./support/windowsRuntimeHostChromeControllerHarness";

type Phase = ReturnType<typeof projection>["tabs"][number]["phase"] | "loading";

function coreProjection(
  topologyRevision: number,
  active: string,
  ids = [tabId, secondTabId],
  phases: Readonly<Record<string, Phase>> = {}
) {
  return {
    ...projection(active),
    topologyRevision,
    tabs: ids.map((id) => ({
      active: id === active, audioMuted: false, hidden: false,
      name: id === tabId ? "Role A" : "Role B", phase: phases[id] ?? "ready", tabId: id
    }))
  };
}

async function loaded() {
  const subject = harness();
  await subject.controller.applyCoreProjection(coreProjection(1, tabId));
  subject.controller.documentLoaded(documentUrl);
  return { subject, revision: subject.controller.readObservation().projectionRevision };
}

/** Core stops the Game Window, then retires this exact native host. */
function heldClose(subject: ReturnType<typeof harness>): () => void {
  let finish!: () => void;
  subject.requestWindowControl.mockImplementation(() => new Promise<undefined>((resolve) => {
    finish = () => { subject.state.destroyed = true; resolve(undefined); };
  }));
  return () => finish();
}

describe("Windows host-document command supersede", () => {
  it("joins repeated close clicks and OS close to the close already admitted", async () => {
    const { subject, revision } = await loaded();
    const finish = heldClose(subject);
    const close = { type: "closeWindow", windowId, projectionRevision: revision } as const;
    const first = subject.controller.handleCommand(documentUrl, close);
    await vi.waitFor(() => expect(subject.requestWindowControl).toHaveBeenCalledOnce());
    // The second click still carries the projection the user saw.
    const second = subject.controller.handleCommand(documentUrl, close);
    const osClose = subject.controller.requestNativeClose();
    finish();
    await expect(Promise.all([first, second, osClose])).resolves.toEqual([undefined, undefined, undefined]);
    // A click delivered after the host retired is an expected supersede too.
    await subject.controller.submitCommand(documentUrl, close);
    expect(subject.requestWindowControl).toHaveBeenCalledExactlyOnceWith("closeWindow");
    expect(subject.onCommandError).not.toHaveBeenCalled();
  });

  it("joins a close click to an OS close in flight even after the projection advanced", async () => {
    const { subject, revision } = await loaded();
    const finish = heldClose(subject);
    const osClose = subject.controller.requestNativeClose();
    await vi.waitFor(() => expect(subject.requestWindowControl).toHaveBeenCalledOnce());
    subject.controller.applyWindowName("Renamed while closing");
    const click = subject.controller.submitCommand(documentUrl, {
      type: "closeWindow", windowId, projectionRevision: revision
    });
    finish();
    await Promise.all([osClose, click]);
    expect(subject.requestWindowControl).toHaveBeenCalledOnce();
    expect(subject.onCommandError).not.toHaveBeenCalled();
  });

  it("drops a tab close queued behind another close that replaced the strip", async () => {
    const { subject, revision } = await loaded();
    // Core closes Role A; the executor publishes the reduced strip inside the effect.
    subject.requestTabControl.mockImplementationOnce(async () => {
      await subject.controller.applyCoreProjection(coreProjection(2, secondTabId, [secondTabId]));
      return undefined;
    });
    await Promise.all([tabId, secondTabId].map((id) => subject.controller.submitCommand(
      documentUrl, { type: "closeTab", tabId: id, windowId, projectionRevision: revision }
    )));
    expect(subject.requestTabControl).toHaveBeenCalledExactlyOnceWith(tabId, { type: "closeTab" });
    expect(subject.onCommandError).not.toHaveBeenCalled();
    // The supersede republishes the current strip without retiring clicks made on it.
    const current = subject.controller.readObservation().projectionRevision;
    expect(subject.send.mock.calls.at(-1)![1]).toMatchObject({
      projectionRevision: current, tabs: [{ tabId: secondTabId }]
    });
    expect(subject.send.mock.calls.filter(([, published]) =>
      published.projectionRevision === current)).toHaveLength(2);
  });

  it("drops a repeated activation of a tab that started loading", async () => {
    const { subject, revision } = await loaded();
    subject.requestTabControl.mockImplementationOnce(async () => {
      await subject.controller.applyCoreProjection(
        coreProjection(2, secondTabId, undefined, { [secondTabId]: "loading" })
      );
      return undefined;
    });
    const activate = { type: "activateTab", tabId: secondTabId, windowId, projectionRevision: revision } as const;
    await Promise.all([
      subject.controller.submitCommand(documentUrl, activate),
      subject.controller.submitCommand(documentUrl, activate)
    ]);
    expect(subject.requestTabControl).toHaveBeenCalledExactlyOnceWith(secondTabId, { type: "activateTab" });
    expect(subject.onCommandError).not.toHaveBeenCalled();
  });

  it("drops a native tab-menu selection captured before a newer projection", async () => {
    const { subject, revision } = await loaded();
    const popup = vi.fn();
    subject.controller.bindTabMenu(popup);
    await subject.controller.submitCommand(documentUrl, {
      type: "openTabMenu", tabId, windowId, projectionRevision: revision
    });
    await subject.controller.applyCoreProjection(
      coreProjection(2, tabId, undefined, { [secondTabId]: "loading" })
    );
    const submit = vi.spyOn(subject.controller, "submitCommand");
    const items = popup.mock.calls[0]![0] as import("electron").MenuItemConstructorOptions[];
    items.find((item) => item.id === "closeTab")!.click!({} as never, null!, {} as never);
    await submit.mock.results[0]!.value;
    expect(subject.requestTabControl).not.toHaveBeenCalled();
    expect(subject.onCommandError).not.toHaveBeenCalled();
  });

  it("still reports forged, foreign, malformed, and Core-refused commands", async () => {
    const { subject, revision } = await loaded();
    for (const [url, command] of [
      [documentUrl, { type: "closeWindow", windowId, projectionRevision: revision + 100 }],
      [documentUrl, { type: "closeWindow", windowId: "foreign", projectionRevision: revision }],
      ["file:///foreign.html", { type: "closeWindow", windowId, projectionRevision: revision }],
      [documentUrl, { type: "closeWindow", windowId }]
    ] as const) await subject.controller.submitCommand(url, command);
    const refused = Object.assign(new Error("Core refused the tab close."), { code: "CORE_REFUSED" });
    subject.requestTabControl.mockRejectedValueOnce(refused);
    await subject.controller.submitCommand(documentUrl, {
      type: "closeTab", tabId, windowId,
      projectionRevision: subject.controller.readObservation().projectionRevision
    });
    expect(subject.onCommandError.mock.calls.map(([error]) => (error as { code?: string }).code)).toEqual([
      ...Array<string>(4).fill("ELECTRON_WINDOWS_RUNTIME_COMMAND_FENCE_STALE"), "CORE_REFUSED"
    ]);
    expect(subject.requestWindowControl).not.toHaveBeenCalled();
  });
});
