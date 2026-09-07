// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import ExtensionsRoute from "../src/renderer/src/features/extensions/ExtensionsRoute";
import en from "../src/renderer/src/i18n/en.json";
import type { Translator } from "../src/renderer/src/i18n";
import type { RionStudioApi } from "../src/shared/api";
import type { ExtensionSnapshotRecord } from "../src/shared/generated";
import type { Role } from "../src/shared/types";

const t: Translator = key => en[key];
const id = "a".repeat(32);
const role = { id: "role", name: "Role A" } as Role;
const original: ExtensionSnapshotRecord = { revision: 3, installed: [{ id, name: "Fixture", version: "1.0", sha256: "0".repeat(64), directory: "/managed", permissions: ["https://example.com/*"], enabledRoleIds: [role.id], applyToAllRoles: false, removed: false }], roles: [{ roleId: role.id, leaseId: "lease", extensionIds: [id], status: "loaded" }] };
afterEach(cleanup);

it("distinguishes pending configuration from the live lease and ignores stale snapshots", async () => {
  let publish!: (snapshot: ExtensionSnapshotRecord) => void;
  const invoke = vi.fn(async () => ({ snapshot: original, lease: null, prepared: null }));
  window.rionStudio = { extensions: invoke, extensionStore: vi.fn(async () => ({})), onExtensionsChanged: (listener: typeof publish) => { publish = listener; return () => undefined; }, onExtensionStoreChanged: () => () => undefined } as unknown as RionStudioApi;
  const user = userEvent.setup();
  render(<ExtensionsRoute language="en" roles={[role]} t={t} />);
  await screen.findByText("Fixture");
  await act(async () => publish({ ...original, revision: 2, installed: [] }));
  expect(screen.getByText("Fixture")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Manage" }));
  expect(screen.getByText("Loaded")).toBeTruthy();
  await user.click(screen.getByRole("checkbox"));
  expect(screen.getByText("Pending next launch")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(invoke).toHaveBeenLastCalledWith({ type: "configure", id, roleIds: [], applyToAllRoles: false });
});

it("retains an actionable removal tombstone instead of offering a duplicate installation", async () => {
  const snapshot = { ...original, roles: [], installed: [{ ...original.installed[0], removed: true, enabledRoleIds: [] }] };
  const invoke = vi.fn(async () => ({ snapshot, lease: null, prepared: null }));
  window.rionStudio = { extensions: invoke, extensionStore: vi.fn(async () => ({})), onExtensionsChanged: () => () => undefined, onExtensionStoreChanged: () => () => undefined } as unknown as RionStudioApi;
  const user = userEvent.setup();
  render(<ExtensionsRoute language="en" roles={[role]} t={t} />);
  await screen.findByText("Removal pending");
  await user.click(screen.getByRole("button", { name: "Retry removal" }));
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
  expect(invoke).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole("button", { name: "Retry removal" }));
  await user.click(screen.getByRole("button", { name: "Confirm removal" }));
  expect(invoke).toHaveBeenLastCalledWith({ type: "remove", id });
});

function fixture(snapshot = original) {
  let publish!: (snapshot: ExtensionSnapshotRecord) => void;
  let storePublish!: (store: import("../src/shared/extensions").ExtensionStoreState) => void;
  const invoke = vi.fn(async (_input: unknown) => ({ snapshot, lease: null, prepared: null as null | { operationId: string; package: typeof original.installed[0] } }));
  const store = { url: "https://chromewebstore.google.com/", extensionId: id, canGoBack: false, canGoForward: false, loading: false, failed: false };
  const extensionStore = vi.fn(async () => store);
  window.rionStudio = { extensions: invoke, extensionStore, onExtensionsChanged: (listener: typeof publish) => { publish = listener; return () => undefined; }, onExtensionStoreChanged: (listener: typeof storePublish) => { storePublish = listener; return () => undefined; } } as unknown as RionStudioApi;
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  return { invoke, extensionStore, publish: (next: ExtensionSnapshotRecord) => publish(next), showStore: () => storePublish(store) };
}
afterEach(() => vi.unstubAllGlobals());

it("searches normalized names and IDs and distinguishes no matches from an empty catalogue", async () => {
  fixture();
  const user = userEvent.setup();
  render(<ExtensionsRoute language="en" roles={[role]} t={t} />);
  await screen.findByText("Fixture");
  const search = screen.getByRole("textbox", { name: "Search extensions" });
  await user.type(search, "  FIXTURE  ");
  expect(screen.getByText("Fixture")).toBeTruthy();
  await user.clear(search);
  await user.type(search, "zzzz");
  expect(screen.getByText("No matching extensions")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Clear search" }));
  expect(screen.getByText("Fixture")).toBeTruthy();
});

it("preserves selected-role drafts across scope changes and applies select-all beyond the search filter", async () => {
  const f = fixture();
  const user = userEvent.setup();
  render(<ExtensionsRoute language="en" roles={[role, { ...role, id: "other", name: "Other" }]} t={t} />);
  await user.click(await screen.findByRole("button", { name: "Manage" }));
  const dialog = within(screen.getByRole("dialog"));
  await user.click(dialog.getByRole("button", { name: "All roles" }));
  expect(dialog.getByRole("checkbox", { name: "Other" }).getAttribute("data-state")).toBe("checked");
  await user.click(dialog.getByRole("button", { name: "Selected roles" }));
  expect(dialog.getByRole("checkbox", { name: "Other" }).getAttribute("data-state")).toBe("unchecked");
  await user.type(dialog.getByRole("textbox", { name: "Search roles" }), "Role A");
  await user.click(dialog.getByRole("button", { name: "Select all current roles" }));
  await user.click(dialog.getByRole("button", { name: "Save" }));
  expect(f.invoke).toHaveBeenLastCalledWith({ type: "configure", id, roleIds: ["role", "other"], applyToAllRoles: false });
});

it("restores all current roles when a saved all-role rule switches to selected roles", async () => {
  const f = fixture({ ...original, installed: [{ ...original.installed[0], applyToAllRoles: true, enabledRoleIds: [] }] });
  const user = userEvent.setup();
  render(<ExtensionsRoute language="en" roles={[role]} t={t} />);
  await user.click(await screen.findByRole("button", { name: "Manage" }));
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Selected roles" }));
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(f.invoke).toHaveBeenLastCalledWith({ type: "configure", id, roleIds: [role.id], applyToAllRoles: false });
});

it("preserves the draft after cancelled removal or failed save and returns focus on close", async () => {
  const f = fixture();
  const user = userEvent.setup();
  render(<ExtensionsRoute language="en" roles={[role]} t={t} />);
  const manage = await screen.findByRole("button", { name: "Manage" });
  await user.click(manage);
  await user.click(screen.getByRole("checkbox", { name: "Role A" }));
  await user.click(screen.getByRole("button", { name: "Remove" }));
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
  expect(screen.getByRole("checkbox", { name: "Role A" }).getAttribute("data-state")).toBe("unchecked");
  f.invoke.mockRejectedValueOnce(new Error("write failure"));
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(within(screen.getByRole("dialog")).getByRole("alert")).toBeTruthy();
  expect(screen.getByRole("checkbox", { name: "Role A" }).getAttribute("data-state")).toBe("unchecked");
  await user.keyboard("{Escape}");
  expect(document.activeElement).toBe(manage);
});

it("installs an all-role rule without existing roles and returns to an unfiltered list", async () => {
  const f = fixture();
  const user = userEvent.setup();
  render(<ExtensionsRoute language="en" roles={[]} t={t} />);
  await screen.findByText("Fixture");
  await user.type(screen.getByRole("textbox", { name: "Search extensions" }), "absent");
  await user.click(screen.getByRole("button", { name: "Add extension" }));
  await act(async () => f.publish({ revision: 4, installed: [], roles: [] }));
  await act(async () => f.showStore());
  f.invoke.mockImplementationOnce(async () => ({ snapshot: { revision: 4, installed: [], roles: [] }, lease: null, prepared: { operationId: "prepared", package: original.installed[0] } }));
  await user.click(screen.getByRole("button", { name: "Install this extension" }));
  expect(f.extensionStore).toHaveBeenCalledWith({ action: "hide" });
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "All roles" }));
  f.invoke.mockResolvedValueOnce({ snapshot: { ...original, revision: 5, installed: [{ ...original.installed[0], applyToAllRoles: true, enabledRoleIds: [] }] }, lease: null, prepared: null });
  await user.click(screen.getByRole("button", { name: "Confirm installation" }));
  expect(f.invoke.mock.calls.at(-1)?.[0]).toMatchObject({ type: "install", applyToAllRoles: true });
  expect(screen.getByText("Fixture")).toBeTruthy();
  expect((screen.getByRole("textbox", { name: "Search extensions" }) as HTMLInputElement).value).toBe("");
});

it("shows loading and initial failure without a false empty state", async () => {
  const f = fixture();
  let reject!: (reason: Error) => void;
  f.invoke.mockImplementationOnce(() => new Promise((_resolve, failure) => { reject = failure; }));
  render(<ExtensionsRoute language="en" roles={[]} t={t} />);
  expect(screen.getByRole("status").textContent).toBe("Loading…");
  expect(screen.queryByText("No extensions installed yet.")).toBeNull();
  await act(async () => reject(new Error("offline")));
  expect(screen.getByRole("alert")).toBeTruthy();
  expect(screen.queryByText("No extensions installed yet.")).toBeNull();
});

it("cancels preparation and ignores its late result while preserving the list search", async () => {
  const f = fixture({ revision: 3, installed: [], roles: [] });
  const user = userEvent.setup();
  render(<ExtensionsRoute language="en" roles={[]} t={t} />);
  await screen.findByText("No extensions installed yet.");
  await user.type(screen.getByRole("textbox", { name: "Search extensions" }), "remember");
  await user.click(screen.getAllByRole("button", { name: "Add extension" })[0]);
  await act(async () => f.showStore());
  let finish!: (value: Awaited<ReturnType<typeof f.invoke>>) => void;
  f.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await user.click(screen.getByRole("button", { name: "Install this extension" }));
  expect((screen.getByRole("button", { name: "Back to extensions" }) as HTMLButtonElement).disabled).toBe(true);
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await act(async () => finish({ snapshot: original, lease: null, prepared: { operationId: "late", package: original.installed[0] } }));
  expect(screen.queryByRole("dialog")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Back to extensions" }));
  expect((screen.getByRole("textbox", { name: "Search extensions" }) as HTMLInputElement).value).toBe("remember");
});

it("keeps navigation blocked after cancellation failure until Core acknowledges retry", async () => {
  const f = fixture({ revision: 3, installed: [], roles: [] });
  const user = userEvent.setup();
  render(<ExtensionsRoute language="en" roles={[]} t={t} />);
  await screen.findByText("No extensions installed yet.");
  await user.click(screen.getAllByRole("button", { name: "Add extension" })[0]);
  await act(async () => f.showStore());
  f.invoke.mockImplementationOnce(() => new Promise(() => undefined));
  await user.click(screen.getByRole("button", { name: "Install this extension" }));
  f.invoke.mockRejectedValueOnce(new Error("cancel failed"));
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect((screen.getByRole("button", { name: "Back to extensions" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole("alert")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect((screen.getByRole("button", { name: "Back to extensions" }) as HTMLButtonElement).disabled).toBe(false);
  expect(f.invoke.mock.calls.at(-1)).toEqual(f.invoke.mock.calls.at(-2));
});

it("keeps keyboard focus inside the dialog and submits a save only once while pending", async () => {
  const f = fixture();
  const user = userEvent.setup();
  render(<ExtensionsRoute language="en" roles={[role]} t={t} />);
  await user.click(await screen.findByRole("button", { name: "Manage" }));
  const dialog = screen.getByRole("dialog");
  const save = within(dialog).getByRole("button", { name: "Save" });
  await user.tab({ shift: true });
  expect(document.activeElement).toBe(save);
  await user.tab();
  expect(document.activeElement?.tagName).toBe("SUMMARY");
  let finish!: (value: Awaited<ReturnType<typeof f.invoke>>) => void;
  f.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await user.dblClick(save);
  expect(f.invoke.mock.calls.filter(([input]) => (input as { type: string }).type === "configure")).toHaveLength(1);
  await user.keyboard("{Escape}");
  expect(screen.getByRole("dialog")).toBeTruthy();
  await act(async () => finish({ snapshot: original, lease: null, prepared: null }));
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("passes the current app language when opening and updating the store", async () => {
  const f = fixture();
  const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, width: 600, height: 400 } as DOMRect);
  try {
    const user = userEvent.setup();
    const view = render(<ExtensionsRoute language="zh-TW" roles={[]} t={t} />);
    await user.click(screen.getByRole("button", { name: "Add extension" }));
    expect(f.extensionStore).toHaveBeenCalledWith(expect.objectContaining({ action: "show", language: "zh-TW" }));
    view.rerender(<ExtensionsRoute language="ja" roles={[]} t={t} />);
    expect(f.extensionStore).toHaveBeenLastCalledWith(expect.objectContaining({ action: "show", language: "ja" }));
  } finally { rect.mockRestore(); }
});
