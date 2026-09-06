import { EventEmitter } from "node:events";
import type { ChromiumRoleWebContentsViewPort } from "../src/electron/main/chromiumRoleSurfacePorts";
import type { WindowsChromiumInputRuntimeParentBinding } from "../src/electron/main/windowsChromiumInputHostPorts";
import { describe, expect, it, vi } from "vitest";

import type { EngineCapabilitySnapshotRecord } from "../src/shared/generated";
import {
  createWindowsChromiumTrustedInputRuntime,
  type WindowsChromiumTrustedInputRuntimeConfiguration,
  type WindowsChromiumTrustedInputRuntimeSurfacePort
} from "../src/electron/main/windowsChromiumTrustedInputRuntime";

type ReceiptListener = Parameters<
  WindowsChromiumTrustedInputRuntimeConfiguration["ipcMain"]["on"]
>[1];

function capabilities(
  trustedInput: EngineCapabilitySnapshotRecord["trustedInput"],
  backgroundInput: EngineCapabilitySnapshotRecord["backgroundInput"]
) {
  return { trustedInput, backgroundInput };
}

function configuration(): WindowsChromiumTrustedInputRuntimeConfiguration {
  return {
    addon: {
      readWindowsRuntimeForeground: () => { throw new Error("No native parent in this fixture."); }
    },
    focusedWebContentsId: () => null,
    deadlines: {
      schedule: () => 1,
      cancel: () => undefined
    },
    ipcMain: {
      on: () => undefined,
      removeListener: () => undefined
    }
  };
}

function surfaces(): WindowsChromiumTrustedInputRuntimeSurfacePort {
  return {
    authorizeTrustedInputFrame: () => {
      throw new Error("no active frame");
    },
    currentTrustedInputFrame: () => {
      throw new Error("no active frame");
    },
    resolveInputSurface: () => null,
    resolveTrustedInputClick: () => ({
      clientX: 0,
      clientY: 0,
      zoomFactor: 1
    }),
    sendTrustedInputControl: () => undefined,
    subscribeTrustedInputLifecycle: () => () => undefined
  };
}

function runtimeInput(
  inputCapabilities: ReturnType<typeof capabilities>,
  runtimeConfiguration?: WindowsChromiumTrustedInputRuntimeConfiguration
) {
  const listeners = new Set<ReceiptListener>();
  const configurationWithIpc = runtimeConfiguration
    ? {
        ...runtimeConfiguration,
        ipcMain: {
          on: (
            _channel: string,
            listener: ReceiptListener
          ) => {
            listeners.add(listener);
          },
          removeListener: (
            _channel: string,
            listener: ReceiptListener
          ) => {
            listeners.delete(listener);
          }
        }
      }
    : undefined;
  return {
    listeners,
    value: {
      capabilities: inputCapabilities,
      ...(configurationWithIpc ? { configuration: configurationWithIpc } : {}),
      nowMs: () => 1,
      onError: vi.fn(),
      parents: { resolve: () => null }
    }
  };
}

describe("Windows Chromium trusted-input runtime composition", () => {
  it("keeps disabled production capabilities inert even when dependencies exist", async () => {
    const input = runtimeInput(
      capabilities("disabled", "disabled"),
      configuration()
    );
    expect(createWindowsChromiumTrustedInputRuntime(input.value)).toBeNull();
    expect(input.listeners).toHaveLength(0);
  });

  it("requires trusted input for a background claim and exact View dependencies", () => {
    expect(() => createWindowsChromiumTrustedInputRuntime(
      runtimeInput(
        capabilities("disabled", "supported"),
        configuration()
      ).value
    )).toThrowError(expect.objectContaining({
      code: "ELECTRON_WINDOWS_INPUT_CAPABILITY_INCONSISTENT"
    }));
    expect(() => createWindowsChromiumTrustedInputRuntime(
      runtimeInput(capabilities("supported", "disabled")).value
    )).toThrowError(expect.objectContaining({
      code: "ELECTRON_WINDOWS_INPUT_RUNTIME_MISSING"
    }));

  });

  it("attaches the actual Role View to its existing parent without a child-window factory", async () => {
    const events = new EventEmitter();
    const contentsEvents = new EventEmitter();
    const children: unknown[] = [];
    const parent = { id: 1, isDestroyed: () => false, isFocused: () => true, isVisible: () => true,
      getNativeWindowHandle: () => Buffer.from([1]),
      on: events.on.bind(events), removeListener: events.removeListener.bind(events),
      contentView: { children, addChildView: (view: unknown) => { children.push(view); },
        removeChildView: (view: unknown) => { children.splice(children.indexOf(view), 1); } } };
    const view = { getVisible: () => false, setVisible: vi.fn(),
      getBounds: () => ({ x: 0, y: 0, width: 300, height: 200 }),
      webContents: { id: 12, isDestroyed: () => false, isFocused: () => false, getZoomFactor: () => 1,
        on: contentsEvents.on.bind(contentsEvents), removeListener: contentsEvents.removeListener.bind(contentsEvents) }
    } as unknown as ChromiumRoleWebContentsViewPort;
    const input = runtimeInput(capabilities("supported", "supported"), {
      ...configuration(), addon: { readWindowsRuntimeForeground: () => ({
        parentIdentity: "a".repeat(64), focusIdentity: "b".repeat(64), parentWasForeground: true,
        parentVisible: true, parentMinimized: false }) }, focusedWebContentsId: () => 13
    });
    const runtime = createWindowsChromiumTrustedInputRuntime({ ...input.value, parents: {
      resolve: () => ({ window: parent, logicalParent: parent,
        identity: { nativeGeneration: 1, ownerRevision: "1" } } as unknown as WindowsChromiumInputRuntimeParentBinding)
    } })!;
    await runtime.nativeAttachments.attach({ roleId: "role", generation: 1, parent, view,
      isCancelled: () => false, attach: () => parent.contentView.addChildView(view),
      attachTo: target => target.contentView.addChildView(view), detach: () => parent.contentView.removeChildView(view) });
    expect(children).toEqual([view]);
    expect(runtime.nativeAttachments.resolve("role", 1)?.observe()).toMatchObject({
      viewAttached: true, viewVisible: false, contentsFocused: false,
      identity: { webContentsId: 12, parentIdentity: "a".repeat(64) }
    });
    await runtime.dispose();
    expect(runtime.nativeAttachments.resolve("role", 1)).toBeNull();
    expect(children).toEqual([view]); // The surface registry owns physical retirement.
    expect(events.eventNames()).toEqual([]);
    expect(contentsEvents.eventNames()).toEqual([]);
  });

  it("registers one main-only receipt lane and disposes it exactly", async () => {
    const input = runtimeInput(
      capabilities("supported", "supported"),
      configuration()
    );
    const runtime = createWindowsChromiumTrustedInputRuntime(input.value)!;
    expect(input.listeners).toHaveLength(0);
    const trustedInput = runtime.createTrustedInput(surfaces());
    expect(input.listeners).toHaveLength(1);
    expect(() => runtime.createTrustedInput(surfaces())).toThrowError(
      expect.objectContaining({ code: "ELECTRON_WINDOWS_INPUT_RUNTIME_CONFLICT" })
    );

    await trustedInput.dispose();
    expect(input.listeners).toHaveLength(0);
    await runtime.dispose();
    expect(input.listeners).toHaveLength(0);
  });
});
