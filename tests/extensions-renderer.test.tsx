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
const original: ExtensionSnapshotRecord = { revision: 3, installed: [{ id, name: "Fixture", version: "1.0", sha256: "0".repeat(64), directory: "/managed", permissions: ["https://example.com/*"], enabledRoleIds: [role.id], removed: false }], roles: [{ roleId: role.id, leaseId: "lease", extensionIds: [id], status: "loaded" }] };
afterEach(cleanup);

it("distinguishes pending configuration from the live lease and ignores stale snapshots", async () => {
  let publish!: (snapshot: ExtensionSnapshotRecord) => void;
  const invoke = vi.fn(async () => ({ snapshot: original, lease: null, prepared: null }));
  window.rionStudio = { extensions: invoke, extensionStore: vi.fn(async () => ({})), onExtensionsChanged: (listener: typeof publish) => { publish = listener; return () => undefined; }, onExtensionStoreChanged: () => () => undefined } as unknown as RionStudioApi;
  const user = userEvent.setup();
  render(<ExtensionsRoute roles={[role]} t={t} />);
  await screen.findByText("Fixture");
  await act(async () => publish({ ...original, revision: 2, installed: [] }));
  expect(screen.getByText("Fixture")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Manage" }));
  expect(screen.getByText("Loaded")).toBeTruthy();
  await user.click(screen.getByRole("checkbox"));
  expect(screen.getByText("Pending next launch")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(invoke).toHaveBeenLastCalledWith({ type: "configure", id, roleIds: [] });
});

it("retains an actionable removal tombstone instead of offering a duplicate installation", async () => {
  const snapshot = { ...original, roles: [], installed: [{ ...original.installed[0], removed: true, enabledRoleIds: [] }] };
  const invoke = vi.fn(async () => ({ snapshot, lease: null, prepared: null }));
  window.rionStudio = { extensions: invoke, extensionStore: vi.fn(async () => ({})), onExtensionsChanged: () => () => undefined, onExtensionStoreChanged: () => () => undefined } as unknown as RionStudioApi;
  const user = userEvent.setup();
  render(<ExtensionsRoute roles={[role]} t={t} />);
  await screen.findByText("Removal pending");
  await user.click(screen.getByRole("button", { name: "Retry removal" }));
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
  expect(invoke).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole("button", { name: "Retry removal" }));
  await user.click(screen.getByRole("button", { name: "Confirm removal" }));
  expect(invoke).toHaveBeenLastCalledWith({ type: "remove", id });
});
