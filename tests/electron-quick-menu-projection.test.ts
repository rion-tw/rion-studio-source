import { describe, expect, it, vi } from "vitest";

import { ElectronQuickMenuController } from "../src/electron/main/electronQuickMenuController";
import type { ElectronQuickMenuEntry } from "../src/electron/main/electronQuickMenuModel";
import type { CoreAppSnapshotRecord, CoreEvent, LegalAcceptanceStatusRecord } from "../src/shared/generated";

function state(name?: string) {
  return {
    legal: { isAccepted: true } as LegalAcceptanceStatusRecord,
    snapshot: {
      revision: 1, stateRevision: 1, runtimeRevision: 1,
      state: { revision: 1, games: [], roles: [], launchWorkspaces: [],
        gameWindows: [], macros: [] },
      browserRuntime: {
        roles: [], workspaces: [],
        windows: name ? [{ windowId: "live", activeTabId: "tab", tabIds: ["tab"] }] : [],
        tabs: name ? [{ id: "tab", windowId: "live", name }] : []
      },
      logicalWindows: [], roleStatuses: [], macroStatuses: []
    } as unknown as CoreAppSnapshotRecord
  };
}

function deferred() {
  let resolve!: (value: ReturnType<typeof state>) => void;
  const promise = new Promise<ReturnType<typeof state>>((done) => { resolve = done; });
  return { promise, resolve };
}

function harness(platform: "darwin" | "win32") {
  let listener: (event: CoreEvent) => void = () => undefined;
  let action: (id: string) => void = () => undefined;
  const applied: Array<readonly ElectronQuickMenuEntry[]> = [];
  const read = vi.fn(async () => state());
  const unsubscribe = vi.fn();
  const showGameWindow = vi.fn(async () => undefined);
  const controller = new ElectronQuickMenuController({
    actions: {
      launchRole: vi.fn(), launchWorkspace: vi.fn(), presentMainWindow: vi.fn(),
      requestQuit: vi.fn(), showGameWindow, stopAllRoles: vi.fn()
    },
    apply: (entries, onAction) => { applied.push(entries); action = onAction; },
    initialLanguage: "en", onError: vi.fn(), platform,
    state: { read, subscribe: (value) => { listener = value; return unsubscribe; } }
  });
  return { controller, read, applied, unsubscribe, showGameWindow,
    event: () => listener({ type: "stateChanged", revision: 2, changedCollections: [] }),
    click: (id: string) => action(id) };
}

const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
const direct = (entries: readonly ElectronQuickMenuEntry[] | undefined) =>
  entries?.filter((entry) => "id" in entry && entry.id.startsWith("show-display:"));

describe.each(["darwin", "win32"] as const)("Quick Menu live projections (%s)", (platform) => {
  it("updates open, renamed and closed windows from events and routes their exact identity", async () => {
    const h = harness(platform);
    h.controller.start();
    await flush();
    expect(direct(h.applied.at(-1))).toEqual([]);
    h.read.mockResolvedValue(state("First"));
    h.event();
    await flush();
    expect(direct(h.applied.at(-1))).toEqual([
      expect.objectContaining({ id: "show-display:live", label: "First · Temporary Window" })
    ]);
    h.click("show-display:live");
    await flush();
    expect(h.showGameWindow).toHaveBeenCalledExactlyOnceWith("live");
    h.read.mockResolvedValue(state("Renamed"));
    h.controller.observeNativeProjectionChanged();
    await flush();
    expect(direct(h.applied.at(-1))).toEqual([
      expect.objectContaining({ label: "Renamed · Temporary Window" })
    ]);
    h.read.mockResolvedValue(state());
    h.event();
    await flush();
    expect(direct(h.applied.at(-1))).toEqual([]);
    h.controller.dispose();
  });

  it("discards superseded reads and ignores pending completions and clicks after disposal", async () => {
    const h = harness(platform);
    const stale = deferred();
    const fresh = deferred();
    h.read.mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise);
    h.controller.start();
    h.event();
    stale.resolve(state("Stale"));
    await flush();
    expect(h.applied).toHaveLength(1);
    fresh.resolve(state("Current"));
    await flush();
    expect(direct(h.applied.at(-1))).toEqual([
      expect.objectContaining({ label: "Current · Temporary Window" })
    ]);
    const pending = deferred();
    h.read.mockReturnValueOnce(pending.promise);
    h.event();
    h.controller.dispose();
    pending.resolve(state("Retired"));
    await flush();
    h.event();
    h.controller.observeNativeProjectionChanged();
    h.click("show-display:live");
    expect(h.applied).toHaveLength(2);
    expect(h.read).toHaveBeenCalledTimes(3);
    expect(h.unsubscribe).toHaveBeenCalledOnce();
    expect(h.showGameWindow).not.toHaveBeenCalled();
  });
});
