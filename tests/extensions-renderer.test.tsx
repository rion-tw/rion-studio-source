// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ComponentProps, useState } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { ConfirmationProvider } from "../src/renderer/src/components/ConfirmationDialog";
import ExtensionsRoute from "../src/renderer/src/features/extensions/ExtensionsRoute";
import { formatExtensionBytes } from "../src/renderer/src/features/extensions/extensionSize";
import en from "../src/renderer/src/i18n/en.json";
import ja from "../src/renderer/src/i18n/ja.json";
import zhCN from "../src/renderer/src/i18n/zh-CN.json";
import zhTW from "../src/renderer/src/i18n/zh-TW.json";
import type { Translator } from "../src/renderer/src/i18n";
import type { RionStudioApi } from "../src/shared/api";
import type { ExtensionSnapshotRecord } from "../src/shared/generated";
import type { Role } from "../src/shared/types";

const t: Translator = key => en[key];
const id = "a".repeat(32);
const role = { id: "role", name: "Role A" } as Role;
const original: ExtensionSnapshotRecord = {
  revision: 3,
  installed: [{
    id,
    name: "Fixture",
    version: "1.0",
    description: "A useful fixture extension.",
    iconDataUrl: "data:image/png;base64,iVBORw0KGgo=",
    sizeBytes: 2_048,
    sha256: "0".repeat(64),
    directory: "/managed",
    permissions: ["https://example.com/*"],
    enabledRoleIds: [role.id],
    applyToAllRoles: false,
    removed: false
  }],
  roles: [{ roleId: role.id, leaseId: "lease", extensionIds: [id], status: "loaded" }]
};
afterEach(cleanup);
class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
beforeAll(() => {
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, writable: true, value: ResizeObserverStub });
  Object.defineProperties(HTMLDialogElement.prototype, {
    close: { configurable: true, value: function close(this: HTMLDialogElement): void { this.removeAttribute("open"); } },
    showModal: { configurable: true, value: function showModal(this: HTMLDialogElement): void { this.setAttribute("open", ""); } }
  });
});

type RouteProps = ComponentProps<typeof ExtensionsRoute>;
let updateProps: ((next: Partial<RouteProps>) => void) | null = null;
function Host({ initial }: { initial: RouteProps }) {
  const [props, setProps] = useState(initial);
  updateProps = next => setProps(previous => ({ ...previous, ...next }));
  return <ConfirmationProvider><ExtensionsRoute {...props} /></ConfirmationProvider>;
}
function mount(props: RouteProps, initialPath = "/extensions") {
  const router = createMemoryRouter([{ path: "/extensions/*", element: <Host initial={props} /> }], { initialEntries: [initialPath] });
  render(<RouterProvider router={router} />);
  return { router, update: (next: Partial<RouteProps>) => act(async () => updateProps?.(next)) };
}
const confirmation = () => within(document.querySelector("dialog[open]") as HTMLElement);

it("defines permanent and transient package failures in all four languages", () => {
  const permanentKeys = [
    "extensions.packageTooLarge",
    "extensions.unpackedTooLarge",
    "extensions.signatureInvalid",
    "extensions.manifestUnsupported"
  ] as const;
  for (const messages of [en, zhTW, zhCN, ja]) {
    expect(messages["extensions.storeUnavailable"]).toMatch(/try again|請重試|请重试|もう一度/);
    for (const key of permanentKeys) {
      expect(messages[key]).not.toMatch(/try again|請重試|请重试|もう一度/);
    }
  }
});

it("distinguishes pending configuration from the live lease and ignores stale snapshots", async () => {
  let publish!: (snapshot: ExtensionSnapshotRecord) => void;
  const invoke = vi.fn(async () => ({ snapshot: original, lease: null, prepared: null }));
  window.rionStudio = { extensions: invoke, extensionStore: vi.fn(async () => ({})), onExtensionsChanged: (listener: typeof publish) => { publish = listener; return () => undefined; }, onExtensionStoreChanged: () => () => undefined } as unknown as RionStudioApi;
  const user = userEvent.setup();
  mount({ language: "en", roles: [role], t });
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
  mount({ language: "en", roles: [role], t });
  await screen.findByText("Removal pending");
  await user.click(screen.getByRole("button", { name: "Retry removal" }));
  expect(screen.getByRole("heading", { level: 1, name: "Confirm removal" })).toBeTruthy();
  expect(screen.queryByRole("checkbox")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Back to extensions" }));
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Retry removal" }));
  await user.click(screen.getByRole("button", { name: "Retry removal" }));
  await user.click(screen.getByRole("button", { name: "Confirm removal" }));
  expect(invoke).toHaveBeenLastCalledWith({ type: "remove", id });
  await screen.findByRole("button", { name: "Retry removal" });
});

function fixture(snapshot = original) {
  let publish!: (snapshot: ExtensionSnapshotRecord) => void;
  let storePublish!: (store: import("../src/shared/extensions").ExtensionStoreState) => void;
  const invoke = vi.fn(async (_input: unknown) => ({ snapshot, lease: null, prepared: null as null | { operationId: string; package: typeof original.installed[0] } }));
  const store = { url: "https://chromewebstore.google.com/", extensionId: id, canGoBack: false, canGoForward: false, loading: false, failed: false };
  const extensionStore = vi.fn(async () => store);
  window.rionStudio = { extensions: invoke, extensionStore, onExtensionsChanged: (listener: typeof publish) => { publish = listener; return () => undefined; }, onExtensionStoreChanged: (listener: typeof storePublish) => { storePublish = listener; return () => undefined; } } as unknown as RionStudioApi;
  return { invoke, extensionStore, publish: (next: ExtensionSnapshotRecord) => publish(next), showStore: () => storePublish(store) };
}

it("searches normalized names and IDs and distinguishes no matches from an empty catalogue", async () => {
  fixture();
  const user = userEvent.setup();
  mount({ language: "en", roles: [role], t });
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

it("renders installed metadata in equal-height three-column cards with graceful fallbacks", async () => {
  const fallbackId = "b".repeat(32);
  const snapshot: ExtensionSnapshotRecord = {
    ...original,
    roles: [{ ...original.roles[0], status: "failed" }],
    installed: [
      original.installed[0],
      { ...original.installed[0], id: fallbackId, name: "Legacy fixture", description: undefined, iconDataUrl: undefined, sizeBytes: undefined },
      { ...original.installed[0], id: "c".repeat(32), name: "Long fixture name that must remain contained inside its card" }
    ]
  };
  fixture(snapshot);
  mount({ language: "en", roles: [role], t });

  const list = await screen.findByRole("list", { name: "Installed" });
  expect(list.className).toContain("collection-grid-extensions");
  expect(list.className).toContain("auto-rows-fr");
  const cards = list.querySelectorAll("[data-extension-id]");
  expect(cards).toHaveLength(3);

  const metadataCard = cards[0] as HTMLElement;
  expect(metadataCard.firstElementChild?.className).toContain("h-full");
  expect(within(metadataCard).getByText("A useful fixture extension.")).toBeTruthy();
  expect(within(metadataCard).getByText("2 KB")).toBeTruthy();
  expect(within(metadataCard).getByText(id).getAttribute("title")).toBe(id);
  expect(within(metadataCard).getByText("Load failed")).toBeTruthy();
  expect(metadataCard.querySelector("img")?.getAttribute("src")).toBe(original.installed[0].iconDataUrl);
  expect(metadataCard.querySelector("img")?.className).toContain("object-contain");
  expect(metadataCard.querySelector("img")?.parentElement?.className).not.toContain("glass-control");

  const fallbackCard = cards[1] as HTMLElement;
  expect(within(fallbackCard).getByText("No description provided.")).toBeTruthy();
  expect(within(fallbackCard).getByText("Unavailable")).toBeTruthy();
  expect(fallbackCard.querySelector("img")).toBeNull();
  expect(within(fallbackCard).getByRole("button", { name: "Manage" })).toBeTruthy();

  const longContentCard = cards[2] as HTMLElement;
  expect(longContentCard.querySelector("h2")?.className).toContain("truncate");
  expect(longContentCard.querySelector("[data-extension-description]")?.className).toContain("line-clamp-2");
  expect(longContentCard.querySelector("[data-extension-record-id]")?.className).toContain("truncate");
});

it("formats installed bytes as localized tabular B, KB, and MB values", () => {
  expect(formatExtensionBytes(512, "en")).toBe("512 B");
  expect(formatExtensionBytes(1_536, "en")).toBe("1.5 KB");
  expect(formatExtensionBytes(2 * 1_024 ** 2, "en")).toBe("2 MB");
  expect(formatExtensionBytes(1_536, "zh-TW")).toBe("1.5 KB");
});

it("preserves selected-role drafts across scope changes and applies select-all beyond the search filter", async () => {
  const f = fixture();
  const user = userEvent.setup();
  mount({ language: "en", roles: [role, { ...role, id: "other", name: "Other" }], t });
  await user.click(await screen.findByRole("button", { name: "Manage" }));
  const editor = within(document.querySelector("#app-editor-form") as HTMLElement);
  expect(editor.getByRole("heading", { level: 1, name: "Manage extension" })).toBeTruthy();
  await user.click(editor.getByRole("button", { name: "All roles" }));
  expect(editor.getByRole("checkbox", { name: "Other" }).getAttribute("data-state")).toBe("checked");
  await user.click(editor.getByRole("button", { name: "Selected roles" }));
  expect(editor.getByRole("checkbox", { name: "Other" }).getAttribute("data-state")).toBe("unchecked");
  await user.type(editor.getByRole("textbox", { name: "Search roles" }), "Role A");
  await user.click(editor.getByRole("button", { name: "Select all current roles" }));
  await user.click(editor.getByRole("button", { name: "Save" }));
  expect(f.invoke).toHaveBeenLastCalledWith({ type: "configure", id, roleIds: ["role", "other"], applyToAllRoles: false });
});

it("restores all current roles when a saved all-role rule switches to selected roles", async () => {
  const f = fixture({ ...original, installed: [{ ...original.installed[0], applyToAllRoles: true, enabledRoleIds: [] }] });
  const user = userEvent.setup();
  mount({ language: "en", roles: [role], t });
  await user.click(await screen.findByRole("button", { name: "Manage" }));
  await user.click(screen.getByRole("button", { name: "Selected roles" }));
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(f.invoke).toHaveBeenLastCalledWith({ type: "configure", id, roleIds: [role.id], applyToAllRoles: false });
  expect(await screen.findByRole("button", { name: "Manage" })).toBe(document.activeElement);
});

it("preserves the draft after cancelled removal or failed save and returns focus to the card", async () => {
  const f = fixture();
  const user = userEvent.setup();
  mount({ language: "en", roles: [role], t });
  await user.click(await screen.findByRole("button", { name: "Manage" }));
  await user.click(screen.getByRole("button", { name: "Remove" }));
  expect(confirmation().getByText('Remove "Fixture"?')).toBeTruthy();
  confirmation().getByRole("button", { name: "Cancel" }).focus();
  await user.keyboard("{Escape}");
  expect(document.querySelector("#app-editor-form")).toBeTruthy();
  await user.click(confirmation().getByRole("button", { name: "Cancel" }));
  expect(document.querySelector("dialog[open]")).toBeNull();
  await user.click(screen.getByRole("checkbox", { name: "Role A" }));
  await user.click(screen.getByRole("button", { name: "Remove" }));
  await user.click(confirmation().getByRole("button", { name: "Cancel" }));
  expect(screen.getByRole("checkbox", { name: "Role A" }).getAttribute("data-state")).toBe("unchecked");
  f.invoke.mockRejectedValueOnce(new Error("write failure"));
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(within(document.querySelector("#app-editor-form") as HTMLElement).getByRole("alert")).toBeTruthy();
  expect(screen.getByRole("checkbox", { name: "Role A" }).getAttribute("data-state")).toBe("unchecked");
  await user.keyboard("{Escape}");
  await user.click(confirmation().getByRole("button", { name: "Discard changes" }));
  const manage = await screen.findByRole("button", { name: "Manage" });
  expect(document.activeElement).toBe(manage);
});

it("removes an extension after confirmation and returns to the list", async () => {
  const f = fixture();
  const user = userEvent.setup();
  mount({ language: "en", roles: [role], t });
  await user.click(await screen.findByRole("button", { name: "Manage" }));
  await user.click(screen.getByRole("button", { name: "Remove" }));
  f.invoke.mockResolvedValueOnce({ snapshot: { ...original, revision: 4, installed: [] }, lease: null, prepared: null });
  await user.click(confirmation().getByRole("button", { name: "Confirm removal" }));
  expect(f.invoke).toHaveBeenLastCalledWith({ type: "remove", id });
  expect(await screen.findByText("No extensions installed yet.")).toBeTruthy();
});

it("installs an all-role rule without existing roles and returns to an unfiltered list", async () => {
  const f = fixture();
  const user = userEvent.setup();
  const { router } = mount({ language: "en", roles: [], t });
  await screen.findByText("Fixture");
  await user.type(screen.getByRole("textbox", { name: "Search extensions" }), "absent");
  await user.click(screen.getByRole("button", { name: "Add extension" }));
  await act(async () => f.publish({ revision: 4, installed: [], roles: [] }));
  await act(async () => f.showStore());
  f.invoke.mockImplementationOnce(async () => ({ snapshot: { revision: 4, installed: [], roles: [] }, lease: null, prepared: { operationId: "prepared", package: original.installed[0] } }));
  await user.click(screen.getByRole("button", { name: "Install this extension" }));
  expect(f.extensionStore).toHaveBeenCalledWith({ action: "hide" });
  expect(await screen.findByRole("heading", { level: 1, name: "Install extension" })).toBeTruthy();
  expect(router.state.location.pathname).toBe("/extensions/install");
  expect(screen.getByText("Requested permissions").closest("details")?.open).toBe(true);
  await user.click(screen.getByRole("button", { name: "All roles" }));
  f.invoke.mockResolvedValueOnce({ snapshot: { ...original, revision: 5, installed: [{ ...original.installed[0], applyToAllRoles: true, enabledRoleIds: [] }] }, lease: null, prepared: null });
  await user.click(screen.getByRole("button", { name: "Confirm installation" }));
  expect(f.invoke.mock.calls.at(-1)?.[0]).toMatchObject({ type: "install", applyToAllRoles: true });
  expect(await screen.findByText("Fixture")).toBeTruthy();
  expect(document.querySelector("#app-editor-form")).toBeNull();
  expect((screen.getByRole("textbox", { name: "Search extensions" }) as HTMLInputElement).value).toBe("");
});

it("shows loading and initial failure without a false empty state", async () => {
  const f = fixture();
  let reject!: (reason: Error) => void;
  f.invoke.mockImplementationOnce(() => new Promise((_resolve, failure) => { reject = failure; }));
  mount({ language: "en", roles: [], t });
  expect(screen.getByRole("status").textContent).toBe("Loading…");
  expect(screen.queryByText("No extensions installed yet.")).toBeNull();
  await act(async () => reject(new Error("offline")));
  expect(screen.getByRole("alert")).toBeTruthy();
  expect(screen.queryByText("No extensions installed yet.")).toBeNull();
});

it.each([
  ["EXTENSIONS_PACKAGE_TOO_LARGE", "128 MiB download limit"],
  ["EXTENSIONS_UNPACKED_TOO_LARGE", "512 MiB unpacked limit"],
  ["EXTENSIONS_SIGNATURE_INVALID", "signature"],
  ["EXTENSIONS_MANIFEST_UNSUPPORTED", "manifest is not supported"],
  ["EXTENSIONS_PACKAGE_FAILED", "operation failed"],
  ["EXTENSIONS_CANCELLED", "installation was cancelled"]
])("localizes %s without retry guidance", async (code, expected) => {
  const f = fixture({ revision: 3, installed: [], roles: [] });
  const user = userEvent.setup();
  mount({ language: "en", roles: [], t });
  await screen.findByText("No extensions installed yet.");
  await user.click(screen.getAllByRole("button", { name: "Add extension" })[0]);
  await act(async () => f.showStore());
  f.invoke.mockRejectedValueOnce({
    code,
    message: "internal package detail"
  });
  await user.click(screen.getByRole("button", { name: "Install this extension" }));
  expect(screen.getByRole("alert").textContent).toContain(expected);
  expect(screen.getByRole("alert").textContent).not.toMatch(/try again/i);
});

it("offers retry only for a transient store failure", async () => {
  const f = fixture({ revision: 3, installed: [], roles: [] });
  const user = userEvent.setup();
  mount({ language: "en", roles: [], t });
  await screen.findByText("No extensions installed yet.");
  await user.click(screen.getAllByRole("button", { name: "Add extension" })[0]);
  await act(async () => f.showStore());
  f.invoke.mockRejectedValueOnce({
    code: "EXTENSIONS_STORE_UNAVAILABLE",
    message: "internal store detail"
  });
  await user.click(screen.getByRole("button", { name: "Install this extension" }));
  expect(screen.getByRole("alert").textContent).toBe(
    "The Chrome Web Store is temporarily unavailable. Please try again."
  );
});

it("cancels preparation and ignores its late result while preserving the list search", async () => {
  const f = fixture({ revision: 3, installed: [], roles: [] });
  const user = userEvent.setup();
  mount({ language: "en", roles: [], t });
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
  expect(document.querySelector("#app-editor-form")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Back to extensions" }));
  expect((screen.getByRole("textbox", { name: "Search extensions" }) as HTMLInputElement).value).toBe("remember");
});

it("keeps navigation blocked after cancellation failure until Core acknowledges retry", async () => {
  const f = fixture({ revision: 3, installed: [], roles: [] });
  const user = userEvent.setup();
  mount({ language: "en", roles: [], t });
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

it("submits a save only once while pending and keeps the editor open until Core answers", async () => {
  const f = fixture();
  const user = userEvent.setup();
  mount({ language: "en", roles: [role], t });
  await user.click(await screen.findByRole("button", { name: "Manage" }));
  const save = screen.getByRole("button", { name: "Save" });
  let finish!: (value: Awaited<ReturnType<typeof f.invoke>>) => void;
  f.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await user.dblClick(save);
  expect(f.invoke.mock.calls.filter(([input]) => (input as { type: string }).type === "configure")).toHaveLength(1);
  expect((screen.getByRole("button", { name: "Back to extensions" }) as HTMLButtonElement).disabled).toBe(true);
  await user.keyboard("{Escape}");
  expect(document.querySelector("#app-editor-form")).toBeTruthy();
  await act(async () => finish({ snapshot: original, lease: null, prepared: null }));
  expect(document.querySelector("#app-editor-form")).toBeNull();
  expect(await screen.findByRole("button", { name: "Manage" })).toBeTruthy();
});

it("opens a manage editor from its route and reports missing packages without a modal", async () => {
  fixture();
  const user = userEvent.setup();
  const { router } = mount({ language: "en", roles: [role], t }, `/extensions/${id}/edit`);
  expect(await screen.findByRole("heading", { level: 1, name: "Manage extension" })).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
  await act(async () => { await router.navigate(`/extensions/${"c".repeat(32)}/edit`); });
  expect(await screen.findByText("Editor unavailable")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Back to extensions" }));
  expect(router.state.location.pathname).toBe("/extensions");
  await act(async () => { await router.navigate("/extensions/install"); });
  expect(router.state.location.pathname).toBe("/extensions");
});

it("passes the current app language when opening and updating the store", async () => {
  const f = fixture();
  const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, width: 600, height: 400 } as DOMRect);
  try {
    const user = userEvent.setup();
    const view = mount({ language: "zh-TW", roles: [], t });
    await user.click(screen.getByRole("button", { name: "Add extension" }));
    expect(f.extensionStore).toHaveBeenCalledWith(expect.objectContaining({ action: "show", language: "zh-TW" }));
    await view.update({ language: "ja" });
    expect(f.extensionStore).toHaveBeenLastCalledWith(expect.objectContaining({ action: "show", language: "ja" }));
  } finally { rect.mockRestore(); }
});

it("leaves the install editor even when Core rejects the cancellation", async () => {
  const f = fixture({ revision: 3, installed: [], roles: [] });
  const user = userEvent.setup();
  mount({ language: "en", roles: [], t });
  await screen.findByText("No extensions installed yet.");
  await user.click(screen.getAllByRole("button", { name: "Add extension" })[0]);
  await act(async () => f.showStore());
  f.invoke.mockResolvedValueOnce({
    snapshot: original,
    lease: null,
    prepared: { operationId: "op-1", package: original.installed[0] }
  });
  await user.click(screen.getByRole("button", { name: "Install this extension" }));
  // install() is fire-and-forget behind two awaits, so wait for the editor.
  await vi.waitFor(() => expect(document.querySelector("#app-editor-form")).not.toBeNull());

  // The install editor's Back action is its only exit, so a rejected cancel of
  // a stale or already-terminal operation must not trap the user inside it.
  f.invoke.mockRejectedValueOnce(new Error("cancel failed"));
  await user.click(within(
    document.querySelector("#app-editor-form") as HTMLElement
  ).getByRole("button", { name: en["extensions.cancel"] }));
  expect(document.querySelector("#app-editor-form")).toBeNull();
  expect(f.invoke.mock.calls.at(-1)?.[0]).toMatchObject({ type: "cancel" });
});

it("keeps the store usable when a preparation is superseded after the store hides", async () => {
  const f = fixture({ revision: 3, installed: [], roles: [] });
  const user = userEvent.setup();
  mount({ language: "en", roles: [], t });
  await screen.findByText("No extensions installed yet.");
  await user.click(screen.getAllByRole("button", { name: "Add extension" })[0]);
  await act(async () => f.showStore());

  // Cancel wins the race while the store is still hiding: the second latch
  // acquisition in install() must still be released, or every later action on
  // the route short-circuits on commandBusy and the page becomes inert.
  let hide!: () => void;
  f.invoke.mockResolvedValueOnce({
    snapshot: original,
    lease: null,
    prepared: { operationId: "op-2", package: original.installed[0] }
  });
  f.extensionStore.mockImplementationOnce(
    () => new Promise(resolve => { hide = () => resolve(undefined as never); })
  );
  await user.click(screen.getByRole("button", { name: "Install this extension" }));
  await vi.waitFor(() => expect(hide).toBeTypeOf("function"));
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await act(async () => { hide(); });

  expect(document.querySelector("#app-editor-form")).toBeNull();
  const back = await vi.waitFor(() => {
    const button = screen.getByRole("button", { name: "Back to extensions" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    return button;
  });
  await user.click(back);
  expect(screen.getByText("No extensions installed yet.")).toBeTruthy();
});
