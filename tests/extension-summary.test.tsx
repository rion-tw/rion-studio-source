// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useExtensionSummary } from "../src/renderer/src/hooks/useExtensionSummary";
import type { RionStudioApi } from "../src/shared/api";
import type { ExtensionSnapshotRecord } from "../src/shared/generated";

afterEach(cleanup);
it.each(["darwin", "win32"])("follows catalogue events and fences late snapshots on %s", async () => {
  let publish!: (snapshot: ExtensionSnapshotRecord) => void;
  let resolve!: (result: { snapshot: ExtensionSnapshotRecord }) => void;
  const unsubscribe = vi.fn();
  window.rionStudio = {
    extensions: vi.fn(() => new Promise(finish => { resolve = finish; })),
    onExtensionsChanged: (listener: typeof publish) => { publish = listener; return unsubscribe; }
  } as unknown as RionStudioApi;
  const { result, unmount } = renderHook(() => useExtensionSummary(true));
  const snapshot: ExtensionSnapshotRecord = { revision: 2, roles: [], installed: [{ id: "fixture", name: "Fixture", version: "1", permissions: [], sha256: "", directory: "", enabledRoleIds: [], applyToAllRoles: false, removed: true }] };
  await act(async () => publish(snapshot));
  expect(result.current).toEqual({ available: true, count: 1 });
  await act(async () => resolve({ snapshot: { revision: 1, roles: [], installed: [] } }));
  expect(result.current.count).toBe(1);
  await act(async () => publish({ revision: 3, roles: [], installed: [] }));
  expect(result.current).toEqual({ available: true, count: 0 });
  unmount();
  expect(unsubscribe).toHaveBeenCalledOnce();
  await act(async () => publish({ ...snapshot, revision: 4 }));
  expect(result.current.count).toBe(0);
});

it("does not expose unsupported extensions or query before startup is ready", async () => {
  const invoke = vi.fn(async () => { throw new Error("unsupported"); });
  window.rionStudio = { extensions: invoke, onExtensionsChanged: () => () => undefined } as unknown as RionStudioApi;
  const { result, rerender } = renderHook(({ enabled }) => useExtensionSummary(enabled), { initialProps: { enabled: false } });
  expect(invoke).not.toHaveBeenCalled();
  await act(async () => rerender({ enabled: true }));
  expect(result.current).toEqual({ available: false, count: 0 });
});
