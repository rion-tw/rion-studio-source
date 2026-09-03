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

function configuration(
  abiVersion = 4
): WindowsChromiumTrustedInputRuntimeConfiguration {
  return {
    addon: {
      windowsChromiumInputProbeAbiVersion: () => abiVersion,
      attachWindowsChromiumInputHwnd: () => {
        throw new Error("not attached");
      },
      probeWindowsChromiumInputHwnd: () => {
        throw new Error("not attached");
      },
      submitWindowsChromiumBackgroundKey: () => {
        throw new Error("not attached");
      },
      submitWindowsChromiumBackgroundMouse: () => {
        throw new Error("not attached");
      }
    },
    baseWindows: {
      create: () => {
        throw new Error("not attached");
      }
    },
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
      configuration(99)
    );
    expect(createWindowsChromiumTrustedInputRuntime(input.value)).toBeNull();
    expect(input.listeners).toHaveLength(0);
  });

  it("requires trusted input for a background claim and exact ABI3", () => {
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
    expect(() => createWindowsChromiumTrustedInputRuntime(
      runtimeInput(
        capabilities("supported", "disabled"),
        configuration(2)
      ).value
    )).toThrowError(expect.objectContaining({
      code: "ELECTRON_WINDOWS_INPUT_ABI_MISMATCH"
    }));
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
