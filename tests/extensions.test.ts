import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { chromeStoreExtensionId } from "../src/shared/extensions";
import { ChromiumExtensionSessions } from "../src/electron/main/chromiumExtensionSessions";
import { createExtensionApiDispatcher } from "../src/electron/main/extensionApiDispatcher";
import type { ChromiumRoleSessionHandle } from "../src/electron/main/chromiumRoleSessionRegistry";

const id = "a".repeat(32);
describe("Chrome store identity", () => {
  it("accepts only exact HTTPS store detail pages", () => {
    expect(chromeStoreExtensionId(`https://chromewebstore.google.com/detail/fixture/${id}?hl=ja`)).toBe(id);
    for (const url of [`http://chromewebstore.google.com/detail/${id}`, `https://chromewebstore.google.com.evil.test/detail/${id}`, `https://chromewebstore.google.com/search/${id}`, `https://user@chromewebstore.google.com/detail/${id}`, `https://chromewebstore.google.com/detail/${id}/extra`, "invalid"]) {
      expect(chromeStoreExtensionId(url)).toBeNull();
    }
  });
});

describe.each(["darwin", "win32"])("Extension session lifecycle (%s)", platform => {
  function fixture() {
    const native = Object.assign(new EventEmitter(), {
      current: [] as { id: string }[],
      getAllExtensions: vi.fn(() => native.current),
      loadExtension: vi.fn(async () => { native.current.push({ id }); return { id }; }),
      removeExtension: vi.fn((removedId: string) => {
        native.current = native.current.filter(e => e.id !== removedId);
        native.emit("extension-unloaded", {}, { id: removedId });
      })
    });
    let generation = 0;
    const core = { invoke: vi.fn(async (input: { command: { type: string } }) => ({
      snapshot: { revision: 1, roles: [], installed: [{ id, removed: false, directory: platform === "win32" ? "C:\\fixture" : "/fixture" }] },
      lease: input.command.type === "acquire" ? { roleId: "role", leaseId: `lease-${++generation}`, extensionIds: [id], status: "loading" } : null,
      prepared: null
    })) };
    const handle = { roleId: "role", chromiumUserDataDir: platform === "win32" ? "C:\\role" : "/role", session: { extensions: native } } as unknown as ChromiumRoleSessionHandle;
    const sessions = new ChromiumExtensionSessions(core as never);
    return { native, core, handle, sessions };
  }
  it("loads once per exact role owner and unloads before releasing Core", async () => {
    const { native, core, handle, sessions } = fixture();
    await Promise.all([sessions.prepare(handle), sessions.prepare(handle)]);
    expect(native.loadExtension).toHaveBeenCalledTimes(1);
    expect(native.loadExtension).toHaveBeenCalledWith(platform === "win32" ? "C:\\fixture" : "/fixture", { allowFileAccess: false });
    await sessions.release(handle);
    expect(native.current).toEqual([]);
    expect(core.invoke).toHaveBeenLastCalledWith({ type: "extensions", command: { type: "release", roleId: "role", leaseId: "lease-1" } });
    await sessions.prepare(handle);
    expect(native.loadExtension).toHaveBeenCalledTimes(2);
  });
  it("rejects stale native identity and records load failure", async () => {
    const { native, core, handle, sessions } = fixture();
    native.loadExtension.mockRejectedValueOnce(new Error("failure"));
    await expect(sessions.prepare(handle)).rejects.toThrow("failure");
    expect(core.invoke).toHaveBeenLastCalledWith({ type: "extensions", command: { type: "complete", roleId: "role", leaseId: "lease-1", status: "failed" } });
    await expect(sessions.prepare({ ...handle })).rejects.toThrow("EXTENSIONS_STALE_SESSION");
    await sessions.release(handle);
  });
  it("fences a load that finishes after release was requested", async () => {
    const { native, core, handle, sessions } = fixture();
    let resolve!: (value: { id: string }) => void;
    native.loadExtension.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const ready = sessions.prepare(handle);
    const failure = expect(ready).rejects.toThrow("EXTENSIONS_SESSION_RELEASED");
    await Promise.resolve();
    const released = sessions.release(handle);
    resolve({ id });
    await failure;
    await released;
    expect(core.invoke.mock.calls.some(([input]) => "status" in input.command && input.command.status === "loaded")).toBe(false);
  });
});

it("keeps native lease commands out of the renderer bridge and fences store selection", async () => {
  const invoke = vi.fn();
  const dispatcher = createExtensionApiDispatcher({ invoke } as never, { snapshot: () => ({ extensionId: id }) } as never, { invoke } as never);
  await expect(dispatcher.invoke({} as never, "extensions", [{ type: "acquire", roleId: "role" } as never])).rejects.toThrow("EXTENSIONS_COMMAND_FORBIDDEN");
  await expect(dispatcher.invoke({} as never, "extensions", [{ type: "prepare", id: "b".repeat(32), operationId: "operation" }])).rejects.toThrow("EXTENSIONS_STORE_SELECTION_CHANGED");
  expect(invoke).not.toHaveBeenCalled();
});
