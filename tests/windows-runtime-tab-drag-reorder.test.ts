import { describe, expect, it, vi } from "vitest";

import type { ElectronCoreCommandPort } from "../src/electron/main/coreApiDispatcher";
import type { ChromiumRuntimeExecutorSnapshot } from "../src/electron/main/chromiumRuntimeSnapshot";
import { RuntimeTabDragController } from "../src/electron/main/runtimeTabDragController";
import { createRuntimeTabDragHost, type RuntimeTabDragHostPort } from "../src/electron/main/runtimeTabDragHost";
import type { CoreCommand } from "../src/shared/generated";
import {
  documentUrl, harness, projection, secondTabId, tabId, windowId
} from "./support/windowsRuntimeHostChromeControllerHarness";

const sessionId = "40000000-0000-4000-8000-000000000001";
const floatingWindowId = "10000000-0000-4000-8000-000000000009";
const tabWidth = 180;
const frame = { x: 92, y: 49, width: 976, height: 719 };

/** Every promise-driven step has run; only a later IPC delivery remains. */
const nextMacrotask = () => new Promise<void>((resolve) => { setImmediate(resolve); });

function scenario() {
  const subject = harness(() => ({ x: 200, y: 100 }));
  const chrome = subject.controller;
  const windows = [{ windowId, revision: 1, tabIds: [tabId, secondTabId] }];
  const source = windows[0]!;
  const coreProjection = () => ({
    ...projection(tabId),
    topologyRevision: source.revision,
    tabs: source.tabIds.map((id) => ({
      active: id === tabId, audioMuted: false, hidden: false,
      name: id === tabId ? "Role A" : "Role B", phase: "ready" as const, tabId: id
    }))
  });
  // Content origin (100, 80): Role A spans x 160..340, Role B 340..520, row y 80..120.
  const paint = () => {
    const published = subject.send.mock.calls.at(-1)![1];
    return chrome.handleCommand(documentUrl, {
      type: "tabDragGeometry", windowId, projectionRevision: published.projectionRevision,
      row: { x: 60, y: 0, width: 700, height: 40 },
      tabs: published.tabs.filter((tab) => !tab.hidden).map((tab, index) => ({
        tabId: tab.tabId, bounds: { x: 60 + index * tabWidth, y: 5, width: tabWidth, height: 30 }
      }))
    });
  };
  let onReorder: () => void = () => undefined;
  let floating: string | undefined;
  const commands: CoreCommand[] = [];
  const core = { invoke: async (command: CoreCommand) => {
    commands.push(command);
    switch (command.type) {
      case "appSnapshot": return { logicalWindows: windows.map((window) => ({
        windowId: window.windowId, windowGeneration: 1, revision: window.revision,
        tabs: window.tabIds.map((id) => ({ id }))
      })) };
      case "runtimeTabDrag":
        if (command.event.floatingWindowId) floating = command.event.floatingWindowId;
        return { sessionId: command.event.sessionId, sequence: command.event.sequence, status: "applied",
          terminal: ["end", "cancel", "fail"].includes(command.event.phase), singleTab: false,
          floatingWindowId: floating,
          currentWindowId: windows.find((window) => window.tabIds.includes(tabId))?.windowId };
      case "embeddedTabMove": {
        const from = windows.find((window) => window.windowId === command.sourceWindowId)!;
        const to = windows.find((window) => window.windowId === command.targetWindowId)!;
        from.tabIds = from.tabIds.filter((id) => id !== command.tabId);
        const index = command.beforeTabId ? to.tabIds.indexOf(command.beforeTabId) : to.tabIds.length;
        to.tabIds.splice(index, 0, command.tabId);
        from.revision += 1;
        if (to !== from) to.revision += 1;
        // The executor applies the Core chrome projection inside the effect.
        await chrome.applyCoreProjection(coreProjection());
        if (to === from) onReorder();
        return { status: "applied" };
      }
      case "embeddedWindowProvisionForTabMove":
        windows.push({ windowId: floatingWindowId, revision: 1, tabIds: [] });
        return { target: { ...command.target, windowId: floatingWindowId }, windowGeneration: 1 };
      case "embeddedWindowsShow": return {};
      case "embeddedWindowRetireProvision": return null;
      default: throw new Error(`Unexpected command: ${command.type}`);
    }
  } } as unknown as ElectronCoreCommandPort;
  const sourcePort = createRuntimeTabDragHost({
    native: { getNormalBounds: () => frame, setBounds: vi.fn(), setIgnoreMouseEvents: vi.fn(),
      showInactive: vi.fn(), hide: vi.fn(), isDestroyed: () => false },
    ready: chrome.tabDragGeometry.ready, contains: chrome.tabDragGeometry.contains,
    anchor: chrome.tabDragGeometry.anchor, before: chrome.tabDragGeometry.before
  });
  const floatingPort: RuntimeTabDragHostPort = {
    contains: () => false, before: () => undefined, anchor: () => ({ x: 80, y: 20 }),
    ready: async () => undefined, position: vi.fn(), release: vi.fn(), park: vi.fn()
  };
  const errors: unknown[] = [];
  const drag = new RuntimeTabDragController({ core, platform: "win32", epoch: () => 3,
    native: () => ({ windows: windows.map((window) => ({
      windowId: window.windowId, windowGeneration: 1, tabIds: [...window.tabIds],
      bounds: frame, visible: true, presentation: "normal"
    })) }) as unknown as ChromiumRuntimeExecutorSnapshot,
    displays: () => ({ revision: 1, displays: [{ id: 1, isPrimary: true, scaleFactor: 1,
      bounds: { x: 0, y: 0, width: 2000, height: 1200 },
      workArea: { x: 0, y: 0, width: 2000, height: 1160 } }] }) as never,
    host: (id) => id === windowId ? sourcePort : floatingPort,
    onError: (error) => errors.push(error) });
  return {
    chrome, commands, drag, errors, paint, source,
    async load() {
      await chrome.applyCoreProjection(coreProjection());
      chrome.documentLoaded(documentUrl);
      await paint();
    },
    nextSampleDuringReorder(phase: "move" | "end", x: number) {
      onReorder = () => {
        onReorder = () => undefined;
        drag.receive({ sessionId, phase, point: { x, y: 100 } });
      };
    }
  };
}

describe("Windows tab drag reorder against a republished tab strip", () => {
  it.each(["move", "end"] as const)(
    "keeps a %s sample inside the strip after a same-window reorder",
    async (phase) => {
      const subject = scenario();
      await subject.load();
      subject.drag.receive({ phase: "start", sessionId, sourceWindowId: windowId, tabId,
        point: { x: 200, y: 100 }, ratio: { x: 0.2, y: 0.5 } });
      await subject.drag.settle();
      // Crossing Role B's midpoint reorders; the next OS sample arrives while
      // the reordered strip is published but not yet painted by the host.
      subject.nextSampleDuringReorder(phase, 475);
      subject.drag.receive({ sessionId, phase: "move", point: { x: 470, y: 100 } });
      await nextMacrotask();
      await subject.paint();
      await subject.drag.settle();
      if (phase === "move") {
        subject.drag.receive({ sessionId, phase: "end", point: { x: 475, y: 100 } });
        await subject.drag.settle();
      }
      expect(subject.commands.filter((command) =>
        command.type === "embeddedWindowProvisionForTabMove")).toEqual([]);
      expect(subject.commands.filter((command) => command.type === "embeddedTabMove")).toEqual([
        expect.objectContaining({ sourceWindowId: windowId, targetWindowId: windowId, tabId })
      ]);
      expect(subject.source.tabIds).toEqual([secondTabId, tabId]);
      expect(subject.commands.filter((command) => command.type === "embeddedWindowsShow"))
        .toEqual([{ type: "embeddedWindowsShow", windowId }]);
      expect(subject.errors).toEqual([]);
    }
  );
});
