import { describe, expect, it, vi } from "vitest";
import { RuntimeWindowProjectionFence } from "../src/electron/main/runtimeWindowProjectionFence";
import { launchHarness } from "./support/electronChromiumRuntimeLaunchHarness";
import { advanceWindowTopology, emptySavedWindow } from "./support/chromiumRuntimeLaunchFixtures";
import { WINDOW_ID } from "./support/electronChromiumRuntimeLaunchFixtures";
import { RionBridgeError } from "../src/electron/ipc/errors";

describe("Chromium launch snapshots across completed native projections", () => {
  it.each(["admitted", "absent"] as const)(
    "checks native fitting with an initially exact revision pair and %s Core work", async work => {
      const events = new RuntimeWindowProjectionFence();
      const fitted = { x: 120, y: 76, width: 1080, height: 712 };
      let entered!: () => void, release!: () => void;
      const waiting = new Promise<"waiting">(resolve => { entered = () => resolve("waiting"); });
      const gate = new Promise<void>(resolve => { release = resolve; });
      const { coordinator, coreInvoke, state } = launchHarness({
        observedSnapshots: true,
        observeWindowProgress: id => events.observe(id),
        settleWindowNativeEvents: async id => { entered(); return events.settle(id); },
        settleWindowProjection: async () => false,
        onRegister: (command, current) => {
          current.nativeSnapshot = { ...current.nativeSnapshot, windows: current.nativeSnapshot.windows.map(window =>
            ({ ...window, bounds: fitted, target: { ...command.target, bounds: fitted } })) };
          if (work === "admitted") events.retain([`window:${WINDOW_ID}`], gate.then(() => {
            advanceWindowTopology(current, 1);
            current.coreSnapshot.state.gameWindows = current.coreSnapshot.state.gameWindows.map(saved =>
              ({ ...saved, placement: { ...saved.placement, normalBounds: fitted },
                updatedAt: "2026-08-30T12:00:01.000Z" }));
          }));
        }
      });
      const saved = emptySavedWindow();
      state.coreSnapshot.state.gameWindows.push(saved);
      const registration = coordinator.openEmptySavedGameWindow(saved);
      if (work === "admitted") {
        try {
          expect(await Promise.race([waiting, registration.then(() => "completed", () => "rejected")]))
            .toBe("waiting");
          expect(state.coreSnapshot.logicalWindows[0]!.revision).toBe(1);
          expect(state.nativeSnapshot.windows[0]!.topologyRevision).toBe(1);
          expect(coreInvoke).not.toHaveBeenCalledWith(expect.objectContaining({
            type: "embeddedWindowRetireProvision"
          }));
        } finally { release(); }
        await expect(registration).resolves.toBeUndefined();
        expect(state.coreSnapshot.logicalWindows[0]!.revision).toBe(2);
        expect(state.nativeSnapshot.windows[0]!.bounds).toEqual(fitted);
        expect(coreInvoke).not.toHaveBeenCalledWith(expect.objectContaining({
          type: "embeddedWindowRetireProvision"
        }));
      } else {
        release();
        await expect(registration).rejects.toMatchObject({ code: "ELECTRON_CHROMIUM_EMPTY_WINDOW_RECEIPT_STALE" });
        expect(coreInvoke).toHaveBeenCalledWith(expect.objectContaining({
          type: "embeddedWindowRetireProvision"
        }));
      }
    }
  );

  it.each(["native-event", "projection"] as const)(
    "keeps an empty saved host when its %s completes during the Core snapshot RPC", async lane => {
      const events = new RuntimeWindowProjectionFence();
      const projections = new RuntimeWindowProjectionFence();
      const fence = lane === "native-event" ? events : projections;
      const dispose = vi.fn();
      let fenced = false, completed = false;
      const { coordinator, coreInvoke, state } = launchHarness({
        observedSnapshots: true,
        observeWindowProgress: windowId => {
          expect(windowId).toBe(WINDOW_ID);
          const observation = fence.observe(windowId);
          return { readSequence: observation.readSequence, dispose: () => {
            dispose(); observation.dispose();
          } };
        },
        settleWindowNativeEvents: async windowId => {
          fenced = true;
          return events.settle(windowId);
        },
        settleWindowProjection: windowId => projections.settle(windowId),
        onRegister: (_command, current) => {
          advanceWindowTopology(current, 1);
          current.nativeSnapshot = { ...current.nativeSnapshot, windows:
            current.nativeSnapshot.windows.map(window => ({ ...window, topologyRevision: 1 })) };
        }
      });
      const invoke = coreInvoke.getMockImplementation()!;
      coreInvoke.mockImplementation(async command => {
        const result = await invoke(command);
        if (command.type !== "appSnapshot" || !fenced || completed) return result;
        completed = true;
        const captured = structuredClone(result);
        const terminal = Promise.resolve();
        fence.retain([`window:${WINDOW_ID}`], terminal);
        advanceWindowTopology(state, 1);
        await terminal;
        expect(await fence.settle(WINDOW_ID)).toBe(false);
        return captured;
      });
      const saved = emptySavedWindow();
      state.coreSnapshot.state.gameWindows.push(saved);

      await expect(coordinator.openEmptySavedGameWindow(saved)).resolves.toBeUndefined();

      expect(completed).toBe(true);
      expect(state.coreSnapshot.logicalWindows[0]!.revision).toBe(3);
      expect(state.nativeSnapshot.windows[0]!.topologyRevision).toBe(3);
      expect(coreInvoke).not.toHaveBeenCalledWith(expect.objectContaining({
        type: "embeddedWindowRetireProvision"
      }));
      expect(dispose).toHaveBeenCalledTimes(1);
    }
  );

  it.each(["native-event", "projection"] as const)(
    "does not accept a coherent pair after its %s receipt rejects during the Core RPC", async lane => {
      const events = new RuntimeWindowProjectionFence();
      const projections = new RuntimeWindowProjectionFence();
      const fence = lane === "native-event" ? events : projections;
      const dispose = vi.fn();
      const failure = new Error("Exact native receipt failed.");
      let fenced = false, completed = false;
      const { coordinator, coreInvoke, state } = launchHarness({
        observedSnapshots: true,
        observeWindowProgress: windowId => {
          const observation = fence.observe(windowId);
          return { readSequence: observation.readSequence, dispose: () => {
            dispose(); observation.dispose();
          } };
        },
        settleWindowNativeEvents: async windowId => {
          fenced = true;
          return events.settle(windowId);
        },
        settleWindowProjection: windowId => projections.settle(windowId),
        onRegister: (_command, current) => {
          advanceWindowTopology(current, 1);
          current.nativeSnapshot = { ...current.nativeSnapshot, windows:
            current.nativeSnapshot.windows.map(window => ({ ...window, topologyRevision: 1 })) };
        }
      });
      const invoke = coreInvoke.getMockImplementation()!;
      coreInvoke.mockImplementation(async command => {
        const result = await invoke(command);
        if (command.type !== "appSnapshot" || !fenced || completed) return result;
        completed = true;
        const terminal = Promise.reject(failure);
        fence.retain([`window:${WINDOW_ID}`], terminal);
        advanceWindowTopology(state, 1);
        await terminal.catch(() => undefined);
        expect(await fence.settle(WINDOW_ID)).toBe(false);
        return structuredClone(state.coreSnapshot);
      });
      const saved = emptySavedWindow();
      state.coreSnapshot.state.gameWindows.push(saved);

      await expect(coordinator.openEmptySavedGameWindow(saved)).rejects.toBe(failure);
      expect(dispose).toHaveBeenCalledTimes(1);
    }
  );

  it.each(["no-progress", "other-window", "persistent-mismatch", "generation-changed", "read-failed", "actor-stopped"] as const)(
    "preserves strict registration failure and detaches its observation: %s", async scenario => {
      const fence = new RuntimeWindowProjectionFence();
      const dispose = vi.fn();
      let fenced = false, completed = false, observing = false, reads = 0;
      const { coordinator, coreInvoke, state } = launchHarness({
        observedSnapshots: true,
        observeWindowProgress: windowId => {
          observing = true;
          const observation = fence.observe(windowId);
          return { readSequence: observation.readSequence, dispose: () => {
            observing = false; dispose(); observation.dispose();
          } };
        },
        settleWindowNativeEvents: async windowId => {
          fenced = true;
          if (scenario === "actor-stopped") throw new RionBridgeError({
            code: "ELECTRON_CORE_EFFECT_ACTOR_STOPPED", message: "Actor stopped."
          });
          return fence.settle(windowId);
        },
        settleWindowProjection: async () => false,
        onRegister: (_command, current) => {
          advanceWindowTopology(current, 1);
          current.nativeSnapshot = { ...current.nativeSnapshot, windows:
            current.nativeSnapshot.windows.map(window => ({ ...window, topologyRevision: 1 })) };
        }
      });
      const invoke = coreInvoke.getMockImplementation()!;
      coreInvoke.mockImplementation(async command => {
        const result = await invoke(command);
        if (command.type !== "appSnapshot" || !fenced || !observing) return result;
        reads += 1;
        if (completed || scenario === "no-progress") return result;
        completed = true;
        if (scenario === "read-failed") throw new Error("Core snapshot failed.");
        const captured = structuredClone(result);
        const terminal = Promise.resolve();
        fence.retain([`window:${scenario === "other-window" ? "unrelated" : WINDOW_ID}`], terminal);
        if (scenario === "generation-changed") {
          advanceWindowTopology(state, 1);
          state.coreSnapshot.logicalWindows[0]!.windowGeneration += 1;
          state.nativeSnapshot = { ...state.nativeSnapshot, windows: state.nativeSnapshot.windows.map(window =>
            ({ ...window, windowGeneration: state.coreSnapshot.logicalWindows[0]!.windowGeneration })) };
        }
        await terminal;
        return scenario === "generation-changed" ? structuredClone(state.coreSnapshot) : captured;
      });
      const saved = emptySavedWindow();
      state.coreSnapshot.state.gameWindows.push(saved);

      const registration = coordinator.openEmptySavedGameWindow(saved);
      if (scenario === "read-failed") {
        await expect(registration).rejects.toThrow("Core snapshot failed.");
      } else {
        await expect(registration).rejects.toMatchObject({ code: scenario === "actor-stopped"
          ? "ELECTRON_CORE_EFFECT_ACTOR_STOPPED" : "ELECTRON_CHROMIUM_EMPTY_WINDOW_RECEIPT_STALE" });
      }
      expect(reads).toBe(scenario === "actor-stopped" ? 0 : scenario === "persistent-mismatch" ? 2 : 1);
      expect(dispose).toHaveBeenCalledTimes(1);
    }
  );
});
