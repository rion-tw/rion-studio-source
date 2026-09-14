import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChromiumExtensionSessions } from "../src/electron/main/chromiumExtensionSessions";
import {
  clearChromiumExtensionRuntimeDiagnosticsForTests,
  recentChromiumExtensionRuntimeDiagnostics
} from "../src/electron/main/chromiumExtensionRuntimeDiagnostics";

const id = "a".repeat(32);
afterEach(clearChromiumExtensionRuntimeDiagnosticsForTests);

describe.each(["darwin", "win32"])("Required permission classification (%s)", platform => {
  function fixture(requiredApiPermissions?: string[]) {
    const native = Object.assign(new EventEmitter(), {
      getAllExtensions: vi.fn(() => []),
      loadExtension: vi.fn(async () => ({ id })),
      removeExtension: vi.fn()
    });
    const record = {
      id, removed: false, directory: platform === "win32" ? "C:\\fixture" : "/fixture",
      permissions: ["management", "storage"], requiredApiPermissions
    };
    const core = { invoke: vi.fn(async (input: { command: { type: string } }) => ({
      snapshot: { installed: [record] },
      lease: input.command.type === "acquire"
        ? { roleId: "role", leaseId: "lease", extensionIds: [id], status: "loading" }
        : null
    })) };
    const sessions = new ChromiumExtensionSessions(core as never);
    const handle = { roleId: "role", session: { extensions: native } };
    return { native, core, sessions, handle };
  }

  it.each([[], ["storage"]])("loads optional management with required permissions %j", async (...required) => {
    const { native, sessions, handle } = fixture(required as string[]);
    await sessions.prepare(handle as never);
    expect(native.loadExtension).toHaveBeenCalledOnce();
    expect(recentChromiumExtensionRuntimeDiagnostics()).toContainEqual(expect.objectContaining({
      code: "ELECTRON_EXTENSION_READY", status: "loaded"
    }));
  });

  it.each([
    "management", "nativeMessaging", "debugger", "proxy", "vpnProvider",
    "enterprise.deviceAttributes", "enterprise.hardwarePlatform",
    "enterprise.networkingAttributes", "enterprise.futureApi"
  ])("still blocks required %s", async permission => {
    const { native, core, sessions, handle } = fixture([permission]);
    await sessions.prepare(handle as never);
    expect(native.loadExtension).not.toHaveBeenCalled();
    expect(recentChromiumExtensionRuntimeDiagnostics()).toContainEqual(expect.objectContaining({
      api: permission, code: "ELECTRON_EXTENSION_PERMISSION_BLOCKED", stage: "classification"
    }));
    expect(core.invoke).toHaveBeenLastCalledWith({ type: "extensions", command: {
      type: "complete", roleId: "role", leaseId: "lease", status: "degraded"
    } });
  });

  it("does not interpret missing legacy metadata as no required permissions", async () => {
    const { native, sessions, handle } = fixture();
    await sessions.prepare(handle as never);
    expect(native.loadExtension).not.toHaveBeenCalled();
    expect(recentChromiumExtensionRuntimeDiagnostics()).toContainEqual(expect.objectContaining({
      code: "ELECTRON_EXTENSION_PERMISSION_METADATA_UNAVAILABLE", status: "degraded"
    }));
  });

  it("retains downstream load failures after optional permission classification", async () => {
    const { native, sessions, handle } = fixture(["storage"]);
    native.loadExtension.mockRejectedValueOnce(new Error("NATIVE_LOAD_FAILED"));
    await sessions.prepare(handle as never);
    expect(native.loadExtension).toHaveBeenCalledOnce();
    expect(recentChromiumExtensionRuntimeDiagnostics()).toContainEqual(expect.objectContaining({
      code: "NATIVE_LOAD_FAILED", stage: "load", status: "degraded"
    }));
  });
});
