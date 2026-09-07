// @vitest-environment jsdom
import { runInNewContext } from "node:vm";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmationContext } from "../src/renderer/src/components/confirmation";
import { useRoleWorkflow } from "../src/renderer/src/hooks/useRoleWorkflow";
import en from "../src/renderer/src/i18n/en.json";

const message = "[BROWSER_RUNTIME_CAPABILITY_UNAVAILABLE] The bundled Chromium runtime cannot satisfy this launch because SessionMigrationRequired.";
afterEach(() => { cleanup(); Reflect.deleteProperty(window, "rionStudio"); });
function Wrapper({ children }: { children: ReactNode }) {
  return <ConfirmationContext.Provider value={async () => false}>{children}</ConfirmationContext.Provider>;
}

describe.each(["macos", "windows"])("%s role launch migration failure", (platform) => {
  it("routes a non-enumerable error from another context to the exact role without resetting", async () => {
    const failure: unknown = runInNewContext("new Error(message)", { message, platform });
    expect(failure instanceof Error).toBe(false);
    expect(JSON.stringify(failure)).toBe("{}");
    const launchRole = vi.fn().mockRejectedValue(failure);
    const clearRoleBrowserData = vi.fn();
    const sessionMigrationRecovery = vi.fn();
    Object.defineProperty(window, "rionStudio", { configurable: true, value: { launchRole, clearRoleBrowserData, sessionMigrationRecovery } });
    const reportError = vi.fn();
    const { result } = renderHook(() => useRoleWorkflow({
      beginErrorOperation: () => reportError, roles: [], gameNamesById: new Map(), statusByRole: new Map(), t: key => en[key]
    }), { wrapper: Wrapper });
    await act(async () => { expect(await result.current.handleLaunch("role-a")).toBeUndefined(); });
    expect(result.current.recoveryRoleId).toBe("role-a");
    expect(result.current.busyRoleIds.size).toBe(0);
    expect(reportError).not.toHaveBeenCalled();
    expect(clearRoleBrowserData).not.toHaveBeenCalled();
    expect(sessionMigrationRecovery).not.toHaveBeenCalled();
    expect(launchRole).toHaveBeenCalledTimes(1);
  });

  it("keeps other runtime capability failures as errors", async () => {
    const failure = new Error(message.replace("SessionMigrationRequired", "TrustedInputUnavailable"));
    Object.defineProperty(window, "rionStudio", { configurable: true, value: { launchRole: vi.fn().mockRejectedValue(failure) } });
    const reportError = vi.fn();
    const { result } = renderHook(() => useRoleWorkflow({
      beginErrorOperation: () => reportError, roles: [], gameNamesById: new Map(), statusByRole: new Map(), t: key => en[key]
    }), { wrapper: Wrapper });
    await act(async () => { await result.current.handleLaunch("role-a"); });
    expect(result.current.recoveryRoleId).toBeNull();
    expect(reportError).toHaveBeenCalledWith(failure);
  });
});
