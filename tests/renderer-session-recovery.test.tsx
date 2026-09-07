// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import RoleSessionRecoveryDialog from "../src/renderer/src/features/roles/RoleSessionRecoveryDialog";
import type { RoleSessionRecoveryCommand, RoleSessionRecoveryRecord } from "../src/shared/generated";
import type { RionStudioApi } from "../src/shared/api";
import en from "../src/renderer/src/i18n/en.json";

beforeAll(() => Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value() { this.setAttribute("open", ""); } }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const roleId = "11111111-1111-4111-8111-111111111111";
function inspection(supported = true): RoleSessionRecoveryRecord {
  return { roleId, attemptId: null, revision: 0, journalRevision: 4, phase: "inspected", blockers: [],
    sourceIntegrity: "unverified", targetEquality: "notRun", persistence: "notRun", login: "notTested", upgradeResult: null,
    candidates: [{ token: "a".repeat(64), application: "authenticatedExport", kind: "authenticatedExport", supported,
      blockers: supported ? [] : ["COOKIE_SAMESITE_SEMANTICS_UNPROVEN"], cookieCount: 1, localStorageOriginCount: 1, localStorageEntryCount: supported ? 1 : null, otherWebsiteDataPresent: false }] };
}
function mount(initial: RoleSessionRecoveryRecord) {
  let listener: ((record: RoleSessionRecoveryRecord) => void) | undefined;
  let finish: ((record: RoleSessionRecoveryRecord) => void) | undefined;
  const commands: RoleSessionRecoveryCommand[] = [];
  window.rionStudio = {
    onSessionMigrationRecovery: callback => { listener = callback; return () => { listener = undefined; }; },
    sessionMigrationRecovery: vi.fn(async command => {
      commands.push(command);
      if (command.type === "recover") return new Promise<RoleSessionRecoveryRecord>(resolve => { finish = resolve; });
      return initial;
    })
  } as Pick<RionStudioApi, "onSessionMigrationRecovery" | "sessionMigrationRecovery"> as RionStudioApi;
  render(<RoleSessionRecoveryDialog roleId={roleId} t={key => en[key]} onClose={vi.fn()} />);
  return { commands, emit: (record: RoleSessionRecoveryRecord) => act(() => listener?.(record)), finish: (record: RoleSessionRecoveryRecord) => act(() => finish?.(record)) };
}
describe("preserve-session recovery UI", () => {
  it("shows the precise unsupported reason and never submits a recovery", async () => {
    const initial = inspection(false);
    initial.candidates[0].cookieCount = null;
    const fixture = mount(initial);
    await screen.findByText("COOKIE_SAMESITE_SEMANTICS_UNPROVEN");
    expect((screen.getByRole("button", { name: "Preserve sign-in data" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/entries: Not verified/u)).toBeTruthy();
    expect(screen.getByText(/Cookies: Not verified/u)).toBeTruthy();
    expect(fixture.commands.map(command => command.type)).toEqual(["inspect"]);
  });
  it("reports partial upgrade as usable without claiming Cookies or login migrated", async () => {
    const initial = { ...inspection(false), phase: "freshReady", attemptId: "22222222-2222-4222-8222-222222222222", candidates: [], upgradeResult: {
      cookies: "failed", localStorage: "transferred", cookieCount: 0, localStorageOriginCount: 2, localStorageEntryCount: 5, reasons: ["COOKIE_READBACK_MISMATCH"]
    } };
    const fixture = mount(initial);
    await screen.findByText("This role is ready to use. Data transfer results are shown below.");
    expect(screen.getByText("Cookies: Transfer failed (0)")).toBeTruthy();
    expect(screen.getByText("localStorage: Transferred (2 / 5)")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Preserve sign-in data" })).toBeNull();
    expect(fixture.commands.map(command => command.type)).toEqual(["inspect"]);
  });
  it("requires explicit selection when sources are ambiguous", async () => {
    const initial = inspection();
    initial.blockers = ["RECOVERY_SOURCE_SELECTION_REQUIRED"];
    initial.candidates.push({ ...initial.candidates[0], token: "b".repeat(64), application: "com.rionstudio.launcher.dev" });
    const fixture = mount(initial);
    await screen.findByText("Development application");
    const recover = screen.getByRole("button", { name: "Preserve sign-in data" }) as HTMLButtonElement;
    expect(recover.disabled).toBe(true);
    fireEvent.click(screen.getAllByRole("radio")[1]); fireEvent.click(recover);
    await waitFor(() => expect(fixture.commands).toHaveLength(2));
    expect(fixture.commands[1]).toEqual(expect.objectContaining({ type: "recover", roleId, sourceToken: "b".repeat(64), expectedJournalRevision: 4 }));
    expect(Object.keys(fixture.commands[1]).sort()).toEqual(["attemptId", "expectedJournalRevision", "roleId", "sourceToken", "type"]);
  });
  it("fences stale progress and cancels only the active attempt without reporting success", async () => {
    const initial = inspection(); const fixture = mount(initial);
    await screen.findByText("Authenticated v8 export");
    fireEvent.click(screen.getByRole("button", { name: "Preserve sign-in data" }));
    await waitFor(() => expect(fixture.commands).toHaveLength(2));
    const command = fixture.commands[1]; if (command.type !== "recover") throw new Error("missing recovery");
    const progress = { ...initial, attemptId: command.attemptId, phase: "isolatedImport", revision: 3 };
    fixture.emit(progress); fixture.emit({ ...progress, phase: "reading", revision: 2 });
    fixture.emit({ ...progress, roleId: "other", phase: "complete", revision: 8 });
    expect(screen.getByRole("status").textContent).toContain("Verifying a separate copy");
    fireEvent.click(screen.getByRole("button", { name: "Cancel migration" }));
    await waitFor(() => expect(fixture.commands.at(-1)).toEqual({ type: "cancel", roleId, attemptId: command.attemptId }));
    fixture.finish({ ...progress, phase: "cancelled", revision: 4 });
    await screen.findByText("Migration cancelled.");
    expect(screen.queryByText(/Migration complete\./u)).toBeNull();
  });
  it("reattaches to an active attempt and accepts only newer terminal events", async () => {
    const initial = { ...inspection(), attemptId: "22222222-2222-4222-8222-222222222222", phase: "isolatedImport", revision: 3 };
    const fixture = mount(initial);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel migration" }));
    await waitFor(() => expect(fixture.commands.at(-1)).toEqual({ type: "cancel", roleId, attemptId: initial.attemptId }));
    fixture.emit({ ...initial, phase: "complete", revision: 2 });
    expect(screen.getByRole("button", { name: "Cancel migration" })).toBeTruthy();
    fixture.emit({ ...initial, phase: "cancelled", revision: 4 });
    await screen.findByRole("button", { name: "Close" });
    fixture.emit({ ...initial, revision: 3 });
    expect(screen.getByRole("status").textContent).toBe("Migration cancelled.");
  });
});
