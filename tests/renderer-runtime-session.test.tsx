// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import DashboardRoute from "../src/renderer/src/features/dashboard/DashboardRoute";
import type { Translator } from "../src/renderer/src/i18n";
import en from "../src/renderer/src/i18n/en.json";
import type {
  DiscardSavedGameWindowsInput,
  RestoreSavedGameWindowsInput
} from "../src/shared/types";

const t: Translator = (key) => en[key] ?? key;

afterEach(cleanup);

describe("Game Window recovery dashboard", () => {
  it("offers recovery, one-window restore, show-all, stop, and discard actions", () => {
    const onDiscard = vi.fn<(input: DiscardSavedGameWindowsInput) => void>();
    const onRestore = vi.fn<(input: RestoreSavedGameWindowsInput) => void>();
    const onShow = vi.fn<(displayId?: number) => void>();
    const onStop = vi.fn<(displayId: number) => void>();

    render(
      <DashboardRoute
        embeddedRuntime={{
          recovery: { reason: "unclean-exit", windowCount: 1, tabCount: 2 },
          savedWindows: [{
            id: "saved-window",
            displayId: 2,
            displayLabel: "Studio Display",
            wasVisible: true,
            activeSourceId: "role-2",
            tabCount: 2,
            roleCount: 2,
            tabNames: ["Role 1", "Role 2"],
            state: "saved"
          }],
          tabs: [{
            id: "tab-live",
            type: "role",
            sourceId: "role-live",
            name: "Live",
            displayId: 1,
            roleIds: ["role-live"],
            hidden: false,
            active: true,
            audible: false,
            audioMuted: false
          }],
          windows: [{
            id: "live-window",
            displayId: 1,
            bounds: { x: 0, y: 0, width: 1920, height: 1040 },
            visible: false,
            tabCount: 1
          }]
        }}
        gameCount={0}
        busyMacroIds={new Set()}
        busyRoleIds={new Set()}
        busyRunKeys={new Set()}
        busyWorkspaceIds={new Set()}
        macroStatusByRun={new Map()}
        macroStatuses={[]}
        macros={[]}
        roleStatuses={[]}
        roles={[]}
        statusByRole={new Map()}
        t={t}
        workspaces={[]}
        workspaceDisplays={[]}
        onCreateWorkspace={vi.fn()}
        onDiscardSavedGameWindows={onDiscard}
        onLaunchRole={vi.fn()}
        onLaunchWorkspace={vi.fn()}
        onNavigateGames={vi.fn()}
        onNavigateMacros={vi.fn()}
        onNavigateRoles={vi.fn()}
        onNavigateWorkspaces={vi.fn()}
        onNewMacro={vi.fn()}
        onNewRole={vi.fn()}
        onRestoreSavedGameWindows={onRestore}
        onShowGameWindows={onShow}
        onStartMacro={vi.fn()}
        onStopGameWindow={onStop}
        onStopMacro={vi.fn()}
        onStopRole={vi.fn()}
        onStopWorkspace={vi.fn()}
      />
    );

    expect(screen.getByText("Rion Studio did not close normally")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restore session" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    fireEvent.click(screen.getByRole("button", { name: /Studio Display/ }));
    fireEvent.click(screen.getByRole("button", { name: "Forget saved window" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop all tabs in this window" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Show all" })[0]);

    expect(onRestore).toHaveBeenNthCalledWith(1, { scope: "last-visible" });
    expect(onRestore).toHaveBeenNthCalledWith(2, {
      scope: "window",
      windowId: "saved-window"
    });
    expect(onDiscard).toHaveBeenNthCalledWith(1, { scope: "all" });
    expect(onDiscard).toHaveBeenNthCalledWith(2, {
      scope: "window",
      windowId: "saved-window"
    });
    expect(onStop).toHaveBeenCalledWith(1);
    expect(onShow).toHaveBeenCalledWith();
  });
});
