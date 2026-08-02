// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/renderer/src/App";
import en from "../src/renderer/src/i18n/en.json";
import type { RionStudioApi } from "../src/shared/api";

const state = vi.hoisted(() => ({ legalAccepted: false, onboardingVisible: true }));

vi.mock("../src/renderer/src/components/AppSidebar", () => ({
  AppSidebar: () => <aside>App sidebar</aside>
}));
vi.mock("../src/renderer/src/features/legal/LegalOnboarding", () => ({
  LegalOnboarding: () => <div>Legal onboarding</div>
}));
vi.mock("../src/renderer/src/features/onboarding/FirstRunOnboardingGate", () => ({
  FirstRunOnboardingGate: () => <div>First-run onboarding</div>
}));
vi.mock("../src/renderer/src/hooks/useAppData", () => ({
  useAppData: () => ({
    beginErrorOperation: () => () => undefined,
    displays: [],
    embeddedRuntime: { tabs: [], windows: [] },
    error: null,
    gameWindows: [],
    games: [],
    initialLoadState: "ready",
    loadData: vi.fn(),
    macros: [],
    macroStatuses: [],
    macroStatusByRun: new Map(),
    roles: [],
    roleStats: { running: 0, stopped: 0, total: 0 },
    setError: vi.fn(),
    setGameWindows: vi.fn(),
    setGames: vi.fn(),
    setMacros: vi.fn(),
    setMacroStatuses: vi.fn(),
    setRoles: vi.fn(),
    setStatuses: vi.fn(),
    setWorkspaces: vi.fn(),
    statuses: [],
    statusByRole: new Map(),
    workspaces: []
  })
}));
vi.mock("../src/renderer/src/hooks/useLegalAcceptance", () => ({
  useLegalAcceptance: () => ({
    accept: vi.fn(),
    error: null,
    isAccepting: false,
    reload: vi.fn(),
    status: {
      currentVersions: { fairUse: "1", privacy: "1", terms: "1" },
      isAccepted: state.legalAccepted
    }
  })
}));
vi.mock("../src/renderer/src/hooks/useFirstRunOnboarding", () => ({
  useFirstRunOnboarding: () => ({
    complete: vi.fn(),
    dismissSuccess: vi.fn(),
    isSuccessPresented: false,
    isVisible: state.onboardingVisible,
    progress: { version: 1, state: "in_progress" },
    skip: vi.fn(),
    updateProgress: vi.fn()
  })
}));
vi.mock("../src/renderer/src/hooks/usePreferences", () => ({
  usePreferences: () => ({
    handleLanguageChange: vi.fn(),
    handleThemeModeChange: vi.fn(),
    language: "en",
    resolvedTheme: "light",
    t: (key: keyof typeof en) => en[key],
    themeMode: "system"
  })
}));
vi.mock("../src/renderer/src/hooks/useRoleWorkflow", () => ({
  useRoleWorkflow: () => ({
    activeFilter: "all",
    busyRoleIds: new Set(),
    filteredRoles: [],
    handleLaunch: vi.fn(),
    isReorderingRoles: false,
    isSaving: false,
    listScrollTopRef: { current: 0 },
    query: "",
    saveRole: vi.fn(),
    setActiveFilter: vi.fn(),
    setQuery: vi.fn()
  })
}));
vi.mock("../src/renderer/src/hooks/useGameWorkflow", () => ({
  useGameWorkflow: () => ({ isDeletingGames: false, isSavingGame: false })
}));
vi.mock("../src/renderer/src/hooks/useMacroWorkflow", () => ({
  useMacroWorkflow: () => ({
    busyMacroIds: new Set(),
    busyRunKeys: new Set(),
    openListForRole: vi.fn(),
    query: "",
    roleFilterId: "all",
    scrollPositionRef: { current: 0 },
    sort: "manual"
  })
}));
vi.mock("../src/renderer/src/hooks/useWorkspaceWorkflow", () => ({
  useWorkspaceWorkflow: () => ({
    busyWorkspaceIds: new Set(),
    isReorderingWorkspaces: false,
    isSavingWorkspace: false,
    listScrollTopRef: { current: 0 },
    query: ""
  })
}));
vi.mock("../src/renderer/src/hooks/useAppUpdates", () => ({
  useAppUpdates: () => ({ appVersion: "", isBusy: false, status: null })
}));
vi.mock("../src/renderer/src/hooks/useWindowsApplicationShortcuts", () => ({
  useWindowsApplicationShortcuts: vi.fn()
}));
vi.mock("../src/renderer/src/features/settings/useBrowserProxySettings", () => ({
  useBrowserProxySettings: () => ({})
}));

beforeEach(() => {
  state.legalAccepted = false;
  state.onboardingVisible = true;
  const unsubscribe = (): void => undefined;
  window.rionStudio = {
    consumePendingMacroPageRequest: vi.fn().mockResolvedValue(null),
    getGameBrowserSettings: vi.fn().mockResolvedValue({}),
    getMacroSettings: vi.fn().mockResolvedValue({}),
    getRuntimeWindowPreferences: vi.fn().mockResolvedValue({}),
    onMacroPageRequested: vi.fn().mockReturnValue(unsubscribe),
    reportRendererLog: vi.fn()
  } as unknown as RionStudioApi;
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "rionStudio");
});

describe("App first-run gate ordering", () => {
  it("keeps legal acceptance ahead of first-run onboarding", () => {
    render(<MemoryRouter><App /></MemoryRouter>);

    expect(screen.getByText("Legal onboarding")).toBeTruthy();
    expect(screen.queryByText("First-run onboarding")).toBeNull();
    expect(screen.queryByText("App sidebar")).toBeNull();
  });

  it("shows first-run onboarding without the main sidebar after legal acceptance", () => {
    state.legalAccepted = true;
    render(<MemoryRouter><App /></MemoryRouter>);

    expect(screen.getByText("First-run onboarding")).toBeTruthy();
    expect(screen.queryByText("Legal onboarding")).toBeNull();
    expect(screen.queryByText("App sidebar")).toBeNull();
  });
});
