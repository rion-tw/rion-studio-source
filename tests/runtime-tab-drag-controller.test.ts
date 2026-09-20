import { describe, expect, it, vi } from "vitest";
import { RuntimeTabDragController } from "../src/electron/main/runtimeTabDragController";
import type { CoreCommand, CoreAppSnapshotRecord } from "../src/shared/generated";
import type { ElectronCoreCommandPort } from "../src/electron/main/coreApiDispatcher";
import type { ChromiumRuntimeExecutorSnapshot } from "../src/electron/main/chromiumRuntimeSnapshot";
import type { RuntimeTabDragHostPort } from "../src/electron/main/runtimeTabDragHost";

function harness(single = false) {
  type Window = CoreAppSnapshotRecord["logicalWindows"][number];
  const window = (windowId: string, ids: string[]) => ({ windowId, windowGeneration: 1, revision: 1,
    tabs: ids.map(id => ({ id })) }) as Window;
  const windows = [window("source", single ? ["a"] : ["a", "b"]), window("target", ["c"])];
  const commands: CoreCommand[] = [];
  const errors: unknown[] = [];
  const ports = new Map<string, RuntimeTabDragHostPort>();
  const bounds = { x: 0, y: 0, width: 800, height: 600 };
  let floating: string | undefined = single ? "source" : undefined;
  let moveStatus = "applied";
  let provisionGate: Promise<void> | undefined;
  const host = (id: string) => {
    if (!ports.has(id)) ports.set(id, {
      contains: p => p.y < 40 && (id === "source" ? p.x < 300 : id === "target" && p.x > 700),
      before: () => undefined, anchor: () => ({ x: 100, y: 20 }),
      position: vi.fn(), release: vi.fn()
    });
    return ports.get(id)!;
  };
  const core = { invoke: async (command: CoreCommand) => {
    commands.push(command);
    switch (command.type) {
      case "embeddedWindowsShow": return {};
      case "appSnapshot": return { logicalWindows: windows };
      case "runtimeTabDrag":
        if (command.event.floatingWindowId) floating = command.event.floatingWindowId;
        return { sessionId: command.event.sessionId, sequence: command.event.sequence,
          status: "applied", terminal: ["end", "cancel", "fail"].includes(command.event.phase),
          singleTab: single, floatingWindowId: floating,
          currentWindowId: windows.find(w => w.tabs.some(t => t.id === "a"))?.windowId };
      case "embeddedWindowProvisionForTabMove":
        await provisionGate;
        windows.push(window("floating", []));
        return { target: { ...command.target, windowId: "floating" }, windowGeneration: 1 };
      case "embeddedTabMove": {
        if (moveStatus !== "applied") return { status: moveStatus };
        const source = windows.find(w => w.windowId === command.sourceWindowId)!;
        const target = windows.find(w => w.windowId === command.targetWindowId)!;
        const tab = source.tabs.find(t => t.id === command.tabId)!;
        source.tabs = source.tabs.filter(t => t !== tab); target.tabs.push(tab);
        source.revision++; target.revision++;
        return { status: "applied" };
      }
      case "embeddedWindowRetireProvision": windows.splice(windows.findIndex(w => w.windowId === command.windowId), 1); return null;
      default: throw new Error(`Unexpected command: ${command.type}`);
    }
  } } as ElectronCoreCommandPort;
  const controller = new RuntimeTabDragController({ core, platform: "win32", epoch: () => 1,
    native: () => ({ windows: windows.map(w => ({ windowId: w.windowId, windowGeneration: 1,
      tabIds: w.tabs.map(t => t.id), bounds, visible: true, presentation: "normal" })) }) as unknown as ChromiumRuntimeExecutorSnapshot,
    displays: () => ({ revision: 1, displays: [{ id: 1, isPrimary: true, scaleFactor: 1,
      bounds: { x: -1000, y: 0, width: 3000, height: 1500 }, workArea: { x: -1000, y: 0, width: 3000, height: 1500 } }] }) as never,
    host, onError: error => errors.push(error) });
  const start = () => controller.receive({ phase: "start", sessionId: "drag", sourceWindowId: "source", tabId: "a",
    point: { x: 100, y: 20 }, ratio: { x: 0.5, y: 0.5 } });
  const sample = (phase: "move" | "end" | "cancel", x = 450, y = 400) => controller.receive({ phase, sessionId: "drag", point: { x, y } });
  return { controller, commands, errors, windows, host, start, sample,
    moveStatus: (status: string) => { moveStatus = status; },
    gate: (promise: Promise<void>) => { provisionGate = promise; } };
}

describe("Core-admitted live tab tearout", () => {
  it("creates one transient host, transfers the same tab back and forth, and retires the empty preview", async () => {
    const h = harness(); h.start(); await h.controller.settle();
    const tab = h.windows[0]!.tabs[0];
    h.sample("move"); await h.controller.settle();
    expect(h.windows.find(w => w.windowId === "floating")!.tabs[0]).toBe(tab);
    h.sample("move", 800, 20); await h.controller.settle();
    expect(h.windows.find(w => w.windowId === "target")!.tabs).toContain(tab);
    h.sample("move"); await h.controller.settle();
    h.sample("end", 100, 20); await h.controller.settle();
    expect(h.windows.find(w => w.windowId === "source")!.tabs).toContain(tab);
    expect(h.windows.some(w => w.windowId === "floating")).toBe(false);
    expect(h.commands.filter(c => c.type === "embeddedWindowProvisionForTabMove")).toHaveLength(1);
    expect(h.commands.some(c => c.type === "gameWindowSaveRuntime")).toBe(false);
    expect(h.errors).toEqual([]);
  });
  it("moves a single-tab source without changing its identity or creating another window", async () => {
    const h = harness(true); h.start(); await h.controller.settle();
    h.sample("end"); await h.controller.settle();
    expect(h.host("source").position).toHaveBeenCalledWith("drag", expect.any(Object), false);
    expect(h.commands.some(c => c.type === "embeddedWindowProvisionForTabMove")).toBe(false);
    expect(h.errors).toEqual([]);
  });
  it("cancellation during provisioning cleans the empty host without moving the tab", async () => {
    const h = harness(); let release!: () => void;
    h.gate(new Promise<void>(resolve => { release = resolve; }));
    h.start(); await h.controller.settle(); h.sample("move");
    await vi.waitFor(() => expect(h.commands.some(c => c.type === "embeddedWindowProvisionForTabMove")).toBe(true));
    h.sample("cancel"); release(); await h.controller.settle();
    expect(h.commands.some(c => c.type === "embeddedTabMove")).toBe(false);
    expect(h.windows.some(w => w.windowId === "floating")).toBe(false);
    expect(h.errors).toEqual([]);
  });
  it("coalesces motion but preserves the terminal sample and ignores late callbacks", async () => {
    const h = harness(); h.start();
    for (let i = 0; i < 30; i++) h.sample("move", i, 500);
    h.sample("end", -300, 700); h.sample("move", 700, 900);
    await h.controller.settle();
    expect(h.host("floating").position).toHaveBeenLastCalledWith("drag", expect.objectContaining({ x: -400, y: 680 }), false);
    expect(h.commands.filter(c => c.type === "runtimeTabDrag" && c.event.phase === "sample")).toHaveLength(1);
    expect(h.errors).toEqual([]);
  });
  it("cancels an event-bound geometry wait without another paint or a timeout", async () => {
    const h = harness();
    const ready = vi.fn((_id: string, signal: AbortSignal) => new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })));
    h.host("floating").ready = ready;
    h.start(); await h.controller.settle(); h.sample("move");
    await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce());
    h.sample("cancel"); await h.controller.settle();
    expect(h.host("floating").position).not.toHaveBeenCalled();
    expect(h.windows.find(w => w.windowId === "floating")!.tabs.map(t => t.id)).toEqual(["a"]);
    expect(h.errors).toEqual([]);
  });
  it("quietly terminates superseded native work and cleans a failed uncommitted provision", async () => {
    for (const status of ["superseded", "failed"]) {
      const h = harness(); h.moveStatus(status);
      h.start(); await h.controller.settle(); h.sample("end"); await h.controller.settle();
      expect(h.windows.some(w => w.windowId === "floating")).toBe(false);
      expect(h.windows[0]!.tabs.map(t => t.id)).toEqual(["a", "b"]);
      expect(h.errors).toHaveLength(status === "failed" ? 1 : 0);
      expect(h.commands.filter(c => c.type === "embeddedTabMove")).toHaveLength(1);
    }
  });
  it("releases every host immediately when the authoritative event stream fails", async () => {
    const h = harness(); h.start(); await h.controller.settle(); h.sample("move"); await h.controller.settle();
    h.controller.failEventStream();
    expect(h.host("source").release).toHaveBeenCalledWith("drag");
    expect(h.host("floating").release).toHaveBeenCalledWith("drag");
    h.sample("move"); await h.controller.dispose();
    expect(h.errors).toEqual([]);
  });

  it("never retires an unrelated empty host that only participated in hit testing", async () => {
    const h = harness(); h.windows[1]!.tabs = [];
    h.start(); await h.controller.settle(); h.sample("move"); await h.controller.settle();
    h.sample("end", 100, 20); await h.controller.settle();
    expect(h.windows.some(w => w.windowId === "target")).toBe(true);
    expect(h.windows.some(w => w.windowId === "floating")).toBe(false);
  });

});
