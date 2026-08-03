import { AlertCircle } from "lucide-react";
import { Suspense, type JSX, useCallback, useEffect, useRef, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router";
import { AppSidebar } from "./components/AppSidebar";
import { UpdateReadyBanner } from "./components/UpdateReadyBanner";
import { Surface } from "./components/ui/patterns";
import { LegalOnboarding } from "./features/legal/LegalOnboarding";
import { FirstRunOnboardingGate } from "./features/onboarding/FirstRunOnboardingGate";
import { SettingsSidebar } from "./features/settings/SettingsSidebar";
import { createEditEditorPath, createNewEditorPath } from "./app/editorNavigation";
import { getBrowserEngineStatusTitle } from "./app/browserEnginePresentation";
import { isPersistentRuntimeError, toMessage } from "./app/errorUtils";
import { shouldShowUpdateBadge } from "./app/statusUtils";
import { useAppData } from "./hooks/useAppData";
import { useAppUpdates } from "./hooks/useAppUpdates";
import { useLegalAcceptance } from "./hooks/useLegalAcceptance";
import { useFirstRunOnboarding } from "./hooks/useFirstRunOnboarding";
import { useGameWorkflow } from "./hooks/useGameWorkflow";
import { useMacroWorkflow } from "./hooks/useMacroWorkflow";
import { usePreferences } from "./hooks/usePreferences";
import { useRoleWorkflow } from "./hooks/useRoleWorkflow";
import { useWorkspaceWorkflow } from "./hooks/useWorkspaceWorkflow";
import { useWindowsApplicationShortcuts } from "./hooks/useWindowsApplicationShortcuts";
import { useSystemRuntimeWarnings } from "./hooks/useSystemRuntimeWarnings";
import { localizeErrorMessage } from "./i18n";
import { DEFAULT_GAME_BROWSER_SETTINGS } from "../../shared/browserFonts";
import { DEFAULT_MACRO_SETTINGS } from "../../shared/macroSettings";
import type { GameBrowserSettings, GameBrowserSettingsPatch, MacroSettings, PortableExportInput, PortableExportResult, PortableImportInput, PortableImportPreview, PortableImportResult, GameWindow, RuntimeWindowPreferences, SystemFontFamily } from "../../shared/types";
import { BootLoadingScreen, BridgeUnavailable, RouteFallback } from "./app/AppScreens";
import { DashboardRoute, GameEditorRoute, GameWindowEditorRoute, GameWindowsRoute, GamesRoute, LaunchWorkspacesRoute, MacroEditorRoute, MacrosRoute, RoleEditorRoute, RolesRoute, SettingsRoute, WorkspaceEditorRoute } from "./app/lazyRoutes";

const TOAST_DISMISS_MS = 4000;

export function App(): JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const data = useAppData();
  const preferences = usePreferences();
  const hasBridge = Boolean(window.rionStudio);
  useWindowsApplicationShortcuts(hasBridge);
  const legal = useLegalAcceptance(hasBridge);
  const firstRunOnboarding = useFirstRunOnboarding({ enabled: hasBridge && data.initialLoadState === "ready" && legal.status?.isAccepted === true, roles: data.roles });
  const [gameBrowserSettings, setGameBrowserSettings] = useState<GameBrowserSettings>(DEFAULT_GAME_BROWSER_SETTINGS);
  const gameBrowserSettingsPatchQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [macroSettings, setMacroSettings] = useState<MacroSettings>(DEFAULT_MACRO_SETTINGS);
  const [runtimeWindowPreferences, setRuntimeWindowPreferences] =
    useState<RuntimeWindowPreferences>({
      alwaysHideTabCloseButton: false,
      alwaysShowToolbarInFullScreen: false,
      restoreGameWindowsOnStartup: true
    });
  const [notice, setNotice] = useState<string | null>(null);
  useSystemRuntimeWarnings(setNotice);
  const [isSavingGameWindow, setIsSavingGameWindow] = useState(false);
  const isSavingGameWindowRef = useRef(false);
  const notifiedEngineIssues = useRef(new Map<string, string>());
  const [systemFonts, setSystemFonts] = useState<SystemFontFamily[]>([]);
  const updates = useAppUpdates({
    enabled: hasBridge,
    onError: data.setError
  });
  useEffect(() => {
    if (!hasBridge) return;
    const onError = (event: ErrorEvent) => window.rionStudio.reportRendererLog({
      event: "renderer_error", message: event.message || "Renderer error", ...(event.error?.stack ? { stack: String(event.error.stack) } : {})
    });
    const onRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      window.rionStudio.reportRendererLog({
        event: "unhandled_rejection",
        message: reason instanceof Error ? reason.message : String(reason),
        ...(reason instanceof Error && reason.stack ? { stack: reason.stack } : {})
      });
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => { window.removeEventListener("error", onError); window.removeEventListener("unhandledrejection", onRejection); };
  }, [hasBridge]);
  const navigateToMacros = useCallback(() => navigate("/macros"), [navigate]);
  const navigateToNewGame = useCallback(() => navigate(createNewEditorPath("games")), [navigate]);
  const navigateToEditGame = useCallback((gameId: string) => navigate(createEditEditorPath("games", gameId)), [navigate]);
  const navigateToNewRoleForGame = useCallback((gameId: string) => navigate(createNewEditorPath("roles", new URLSearchParams({ gameId }))), [navigate]);
  const navigateToNewRole = useCallback(() => navigate(createNewEditorPath("roles")), [navigate]);
  const navigateToEditRole = useCallback(
    (roleId: string) => navigate(createEditEditorPath("roles", roleId)),
    [navigate]
  );
  const navigateToNewWorkspace = useCallback(() => navigate(createNewEditorPath("workspaces")), [navigate]);
  const navigateToEditWorkspace = useCallback(
    (workspaceId: string) => navigate(createEditEditorPath("workspaces", workspaceId)),
    [navigate]
  );
  const navigateToNewGameWindow = useCallback(() => navigate(createNewEditorPath("game-windows")), [navigate]);
  const navigateToEditGameWindow = useCallback(
    (windowId: string) => navigate(createEditEditorPath("game-windows", windowId)),
    [navigate]
  );
  const saveGameWindow = useCallback(async (form: {
    id?: string;
    name: string;
    targetDisplay: Parameters<typeof window.rionStudio.createGameWindow>[0]["targetDisplay"];
    placement: Parameters<typeof window.rionStudio.createGameWindow>[0]["placement"];
  }): Promise<GameWindow | undefined> => {
    if (!window.rionStudio || isSavingGameWindowRef.current) return undefined;
    isSavingGameWindowRef.current = true;
    setIsSavingGameWindow(true);
    const reportError = data.beginErrorOperation();
    try {
      const saved = form.id
        ? await window.rionStudio.updateGameWindow(form.id, {
            name: form.name,
            targetDisplay: form.targetDisplay,
            placement: form.placement
          })
        : await window.rionStudio.createGameWindow({
            name: form.name,
            targetDisplay: form.targetDisplay,
            placement: form.placement
          });
      data.setGameWindows((current) => form.id
        ? current.map((item) => item.id === saved.id ? saved : item)
        : [...current, saved]);
      return saved;
    } catch (error) {
      reportError(error);
      return undefined;
    } finally {
      isSavingGameWindowRef.current = false;
      setIsSavingGameWindow(false);
    }
  }, [data]);
  const navigateToNewMacro = useCallback((roleId?: string) => {
    const searchParams = roleId ? new URLSearchParams({ roleId }) : undefined;
    navigate(createNewEditorPath("macros", searchParams));
  }, [navigate]);
  const navigateToEditMacro = useCallback(
    (macroId: string) => navigate(createEditEditorPath("macros", macroId)),
    [navigate]
  );
  const updateGameBrowserSettings = useCallback(async (settings: GameBrowserSettings): Promise<GameBrowserSettings> => {
    if (!window.rionStudio) {
      throw new Error("Rion Studio desktop bridge is unavailable. Restart the app after rebuilding.");
    }

    const nextSettings = await window.rionStudio.updateGameBrowserSettings(settings);
    setGameBrowserSettings(nextSettings);
    return nextSettings;
  }, []);
  const patchGameBrowserSettings = useCallback(
    (patch: GameBrowserSettingsPatch): Promise<GameBrowserSettings> => {
      const operation = gameBrowserSettingsPatchQueueRef.current.then(async () => {
        if (!window.rionStudio) {
          throw new Error("Rion Studio desktop bridge is unavailable. Restart the app after rebuilding.");
        }

        const nextSettings = await window.rionStudio.patchGameBrowserSettings(patch);
        setGameBrowserSettings(nextSettings);
        return nextSettings;
      });
      gameBrowserSettingsPatchQueueRef.current = operation.then(
        () => undefined,
        () => undefined
      );
      return operation;
    },
    []
  );
  const updateMacroSettings = useCallback(async (settings: MacroSettings): Promise<MacroSettings> => {
    if (!window.rionStudio) {
      throw new Error("Rion Studio desktop bridge is unavailable. Restart the app after rebuilding.");
    }

    const nextSettings = await window.rionStudio.updateMacroSettings(settings);
    setMacroSettings(nextSettings);
    return nextSettings;
  }, []);
  const updateRuntimeWindowPreferences = useCallback(
    async (next: RuntimeWindowPreferences): Promise<RuntimeWindowPreferences> => {
      if (!window.rionStudio) {
        throw new Error("Rion Studio desktop bridge is unavailable. Restart the app after rebuilding.");
      }
      const updated = await window.rionStudio.updateRuntimeWindowPreferences(next);
      setRuntimeWindowPreferences(updated);
      return updated;
    },
    []
  );
  const loadSystemFonts = useCallback(async (): Promise<SystemFontFamily[]> => {
    if (!window.rionStudio) {
      throw new Error("Rion Studio desktop bridge is unavailable. Restart the app after rebuilding.");
    }

    if (systemFonts.length > 0) {
      return systemFonts;
    }

    const nextFonts = await window.rionStudio.listSystemFonts();
    setSystemFonts(nextFonts);
    return nextFonts;
  }, [systemFonts]);
  const exportPortableData = useCallback(async (input: PortableExportInput): Promise<PortableExportResult | null> => {
    if (!window.rionStudio) {
      throw new Error("Rion Studio desktop bridge is unavailable. Restart the app after rebuilding.");
    }

    return window.rionStudio.exportPortableData(input);
  }, []);
  const previewPortableImport = useCallback(async (): Promise<PortableImportPreview | null> => {
    if (!window.rionStudio) {
      throw new Error("Rion Studio desktop bridge is unavailable. Restart the app after rebuilding.");
    }

    return window.rionStudio.previewPortableImport();
  }, []);
  const discardPortableImport = useCallback(async (importId: string): Promise<void> => {
    if (!window.rionStudio) {
      throw new Error("Rion Studio desktop bridge is unavailable. Restart the app after rebuilding.");
    }
    await window.rionStudio.discardPortableImport(importId);
  }, []);
  const applyPortableImport = useCallback(
    async (input: PortableImportInput): Promise<PortableImportResult> => {
      if (!window.rionStudio) {
        throw new Error("Rion Studio desktop bridge is unavailable. Restart the app after rebuilding.");
      }

      const result = await window.rionStudio.applyPortableImport(input);
      if (result.preferences?.themeMode) {
        preferences.handleThemeModeChange(result.preferences.themeMode);
      }

      if (result.preferences?.language) {
        preferences.handleLanguageChange(result.preferences.language);
      }

      if (result.preferences?.gameBrowserSettings) {
        setGameBrowserSettings(result.preferences.gameBrowserSettings);
      }

      if (result.preferences?.macroSettings) {
        setMacroSettings(result.preferences.macroSettings);
      }

      await data.loadData();
      return result;
    },
    [data, preferences]
  );
  useEffect(() => {
    if (!hasBridge || data.initialLoadState !== "ready") {
      return;
    }

    let isDisposed = false;
    void Promise.all([
      window.rionStudio.getGameBrowserSettings(),
      window.rionStudio.getMacroSettings(),
      window.rionStudio.getRuntimeWindowPreferences()
    ])
      .then(([nextGameBrowserSettings, nextMacroSettings, nextRuntimeWindowPreferences]) => {
        if (!isDisposed) {
          setGameBrowserSettings(nextGameBrowserSettings);
          setMacroSettings(nextMacroSettings);
          setRuntimeWindowPreferences(nextRuntimeWindowPreferences);
        }
      })
      .catch(data.setError);

    return () => {
      isDisposed = true;
    };
  }, [data.initialLoadState, data.setError, hasBridge]);

  const roleWorkflow = useRoleWorkflow({
    beginErrorOperation: data.beginErrorOperation,
    gameNamesById: new Map(data.games.map((game) => [game.id, game.name])),
    roles: data.roles,
    setMacros: data.setMacros,
    setNotice,
    setRoles: data.setRoles,
    setStatuses: data.setStatuses,
    setWorkspaces: data.setWorkspaces,
    statusByRole: data.statusByRole,
    t: preferences.t
  });

  const gameWorkflow = useGameWorkflow({
    beginErrorOperation: data.beginErrorOperation,
    roles: data.roles,
    setGames: data.setGames,
    setNotice,
    t: preferences.t
  });

  const workspaceWorkflow = useWorkspaceWorkflow({
    beginErrorOperation: data.beginErrorOperation,
    setNotice,
    setRoles: data.setRoles,
    setStatuses: data.setStatuses,
    setWorkspaces: data.setWorkspaces,
    t: preferences.t,
    workspaces: data.workspaces
  });

  const macroWorkflow = useMacroWorkflow({
    beginErrorOperation: data.beginErrorOperation,
    macros: data.macros,
    setMacros: data.setMacros,
    setMacroStatuses: data.setMacroStatuses,
    setNotice,
    t: preferences.t
  });
  const busyRoleIds = roleWorkflow.busyRoleIds;
  const { openListForRole } = macroWorkflow;
  const { initialLoadState, loadData, setError } = data;
  const { reload: reloadLegal } = legal;

  useEffect(() => {
    if (
      initialLoadState !== "ready" ||
      data.error === null ||
      isPersistentRuntimeError(data.error) ||
      firstRunOnboarding.isVisible
    ) {
      return;
    }

    const timeoutId = window.setTimeout(() => setError(null), TOAST_DISMISS_MS);
    return () => window.clearTimeout(timeoutId);
  }, [data.error, firstRunOnboarding.isVisible, initialLoadState, setError]);

  useEffect(() => {
    if (
      initialLoadState !== "ready" ||
      data.error !== null ||
      notice === null ||
      firstRunOnboarding.isVisible
    ) {
      return;
    }

    const timeoutId = window.setTimeout(() => setNotice(null), TOAST_DISMISS_MS);
    return () => window.clearTimeout(timeoutId);
  }, [data.error, firstRunOnboarding.isVisible, initialLoadState, notice]);

  useEffect(() => {
    if (initialLoadState !== "ready") return;
    const engineIssue = [...data.statuses].reverse().find((status) => {
      if (!status.issueReason) {
        return false;
      }
      const key = status.issueReason;
      if (notifiedEngineIssues.current.get(status.roleId) === key) return false;
      notifiedEngineIssues.current.set(status.roleId, key);
      return true;
    });
    for (const roleId of notifiedEngineIssues.current.keys()) {
      if (!data.statuses.some((status) => status.roleId === roleId)) {
        notifiedEngineIssues.current.delete(roleId);
      }
    }
    if (engineIssue) {
      setNotice(getBrowserEngineStatusTitle(engineIssue, preferences.t));
    }
  }, [data.statuses, initialLoadState, preferences.t]);

  useEffect(() => {
    if (!hasBridge || initialLoadState !== "ready") {
      return;
    }

    let isDisposed = false;

    const consumePendingPageRequest = (): void => {
      void window.rionStudio
        .consumePendingMacroPageRequest()
        .then((request) => {
          if (!isDisposed && request) {
            openListForRole(request.roleId);
            navigateToMacros();
          }
        })
        .catch(setError);
    };

    const unsubscribe = window.rionStudio.onMacroPageRequested(() => {
      consumePendingPageRequest();
    });

    consumePendingPageRequest();

    return () => {
      isDisposed = true;
      unsubscribe();
    };
  }, [hasBridge, initialLoadState, navigateToMacros, openListForRole, setError]);

  const retryInitialLoad = useCallback(() => {
    void loadData({ markInitialLoad: true });
    void reloadLegal();
  }, [loadData, reloadLegal]);
  const initialBootFailed = data.initialLoadState === "failed" || legal.error !== null;
  const initialBootError = data.initialLoadState === "failed" ? data.error : legal.error;

  if (hasBridge && (data.initialLoadState !== "ready" || legal.status === null)) {
    return (
      <BootLoadingScreen
        error={initialBootError}
        language={preferences.language}
        state={initialBootFailed ? "failed" : "loading"}
        t={preferences.t}
        onRetry={retryInitialLoad}
      />
    );
  }

  if (hasBridge && !legal.status?.isAccepted) {
    return (
      <LegalOnboarding
        error={legal.error}
        isAccepting={legal.isAccepting}
        language={preferences.language}
        t={preferences.t}
        onAccept={legal.accept}
        onLanguageChange={preferences.handleLanguageChange}
        onQuit={() => window.rionStudio.quitApplication()}
      />
    );
  }

  if (hasBridge && firstRunOnboarding.isVisible) {
    return <FirstRunOnboardingGate controller={firstRunOnboarding} data={data} notice={notice} preferences={preferences} roleWorkflow={roleWorkflow} />;
  }

  const roleEditorElement = hasBridge ? (
    <RoleEditorRoute
      games={data.games}
      isSaving={roleWorkflow.isSaving}
      roles={data.roles}
      t={preferences.t}
      onClearBrowserData={roleWorkflow.handleClearBrowserData}
      onError={data.setError}
      onSave={roleWorkflow.saveRole}
    />
  ) : (
    <BridgeUnavailable t={preferences.t} />
  );
  const gameEditorElement = hasBridge ? (
    <GameEditorRoute
      games={data.games}
      isSaving={gameWorkflow.isSavingGame}
      t={preferences.t}
      onError={data.setError}
      onReset={gameWorkflow.resetBuiltinGame}
      onSave={gameWorkflow.saveGame}
    />
  ) : <BridgeUnavailable t={preferences.t} />;
  const workspaceEditorElement = hasBridge ? (
    <WorkspaceEditorRoute
      games={data.games}
      isSaving={workspaceWorkflow.isSavingWorkspace}
      roles={data.roles}
      statusByRole={data.statusByRole}
      t={preferences.t}
      workspaces={data.workspaces}
      onSave={workspaceWorkflow.saveWorkspace}
    />
  ) : (
    <BridgeUnavailable t={preferences.t} />
  );
  const macroEditorElement = hasBridge ? (
    <MacroEditorRoute
      games={data.games}
      isSaving={macroWorkflow.isSavingMacro}
      macros={data.macros}
      macroSettings={macroSettings}
      roles={data.roles}
      t={preferences.t}
      onSave={macroWorkflow.saveMacro}
    />
  ) : (
    <BridgeUnavailable t={preferences.t} />
  );

  return (
    <div className="liquid-app-shell flex h-screen overflow-hidden text-foreground">
      {location.pathname === "/settings" ? (
        <SettingsSidebar t={preferences.t} />
      ) : (
        <AppSidebar
          gameCount={data.games.length}
          gameWindowCount={data.gameWindows.length}
          hasUpdateBadge={shouldShowUpdateBadge(updates.status)}
          macroCount={data.macros.length}
          roleCount={data.roles.length}
          t={preferences.t}
          workspaceCount={data.workspaces.length}
        />
      )}

      <main className="app-content relative min-w-0 flex-1 overflow-hidden">
        <UpdateReadyBanner
          status={updates.status}
          t={preferences.t}
          onInstall={updates.installDownloadedUpdate}
        />
        {data.error !== null ? (
          <Surface
            className="pointer-events-none absolute bottom-5 left-1/2 z-[var(--layer-toast)] flex w-fit max-w-[min(720px,calc(100%_-_2.5rem))] -translate-x-1/2 items-start gap-3 border-destructive/30 px-4 py-3 text-body text-destructive md:bottom-6 md:max-w-[min(720px,calc(100%_-_3rem))]"
            role="alert"
            variant="strong"
          >
            <AlertCircle className="mt-0.5 shrink-0" size={17} />
            <span className="min-w-0 break-words">{toMessage(data.error, preferences.language, preferences.t)}</span>
          </Surface>
        ) : null}
        {data.error === null && notice !== null ? (
          <Surface
            className="pointer-events-none absolute bottom-5 left-1/2 z-[var(--layer-toast)] flex w-fit max-w-[min(720px,calc(100%_-_2.5rem))] -translate-x-1/2 items-start gap-3 border-activity/30 px-4 py-3 text-body text-foreground md:bottom-6 md:max-w-[min(720px,calc(100%_-_3rem))]"
            role="status"
            variant="strong"
          >
            <AlertCircle className="mt-0.5 shrink-0 text-activity" size={17} />
            <span className="min-w-0 break-words">{localizeErrorMessage(notice, preferences.language)}</span>
          </Surface>
        ) : null}

        <Suspense fallback={<RouteFallback t={preferences.t} />}>
          <Routes>
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route
              path="/games"
              element={hasBridge ? <GamesRoute
                games={data.games}
                isDeleting={gameWorkflow.isDeletingGames}
                roles={data.roles}
                statusByRole={data.statusByRole}
                t={preferences.t}
                onDelete={(game) => void gameWorkflow.deleteGame(game)}
                onDeleteMany={gameWorkflow.deleteGames}
                onEdit={(game) => navigateToEditGame(game.id)}
                onNewGame={navigateToNewGame}
                onNewRole={navigateToNewRoleForGame}
              /> : <BridgeUnavailable t={preferences.t} />}
            />
            <Route path="/games/new" element={gameEditorElement} />
            <Route path="/games/:id/edit" element={gameEditorElement} />
            <Route path="/games/:id" element={<Navigate to="edit" replace />} />
            <Route
              path="/dashboard"
              element={
                hasBridge ? (
                  <DashboardRoute
                    embeddedRuntime={data.embeddedRuntime}
                    gameCount={data.games.length}
                    busyMacroIds={macroWorkflow.busyMacroIds}
                    busyRoleIds={busyRoleIds}
                    busyRunKeys={macroWorkflow.busyRunKeys}
                    busyWorkspaceIds={workspaceWorkflow.busyWorkspaceIds}
                    macroStatusByRun={data.macroStatusByRun}
                    macroStatuses={data.macroStatuses}
                    macros={data.macros}
                    roleStatuses={data.statuses}
                    roles={data.roles}
                    statusByRole={data.statusByRole}
                    t={preferences.t}
                    workspaces={data.workspaces}
                    onCreateWorkspace={navigateToNewWorkspace}
                    onRestoreSavedGameWindows={(input) =>
                      void window.rionStudio.restoreSavedGameWindows(input)
                    }
                    onDiscardSavedGameWindows={(input) =>
                      void window.rionStudio.discardSavedGameWindows(input)
                    }
                    onLaunchRole={(roleId) => void roleWorkflow.handleLaunch(roleId)}
                    onLaunchWorkspace={(workspace) => void workspaceWorkflow.handleLaunchWorkspace(workspace)}
                    onNavigateMacros={navigateToMacros}
                    onNavigateGames={() => navigate("/games")}
                    onNavigateGameWindows={() => navigate("/game-windows")}
                    onNavigateRoles={(filter) => {
                      roleWorkflow.setActiveFilter(filter);
                      roleWorkflow.setQuery("");
                      navigate("/roles");
                    }}
                    onNavigateWorkspaces={() => navigate("/workspaces")}
                    onNewMacro={() => navigateToNewMacro()}
                    onNewRole={navigateToNewRole}
                    onStartMacro={(macroId) => void macroWorkflow.handleStartMacro(macroId)}
                    onStopMacro={(macroId) => void macroWorkflow.handleStopMacro(macroId)}
                    onStopRole={(roleId) => void roleWorkflow.handleStop(roleId)}
                    onStopWorkspace={(workspace) => void workspaceWorkflow.handleStopWorkspace(workspace)}
                  />
                ) : (
                  <BridgeUnavailable t={preferences.t} />
                )
              }
            />
            <Route
              path="/roles"
              element={
                hasBridge ? (
                  <RolesRoute
                    activeFilter={roleWorkflow.activeFilter}
                    busyRoleIds={busyRoleIds}
                    filteredRoles={roleWorkflow.filteredRoles}
                    games={data.games}
                    roleStats={data.roleStats}
                    roles={data.roles}
                    scrollPositionRef={roleWorkflow.listScrollTopRef}
                    query={roleWorkflow.query}
                    statusByRole={data.statusByRole}
                    t={preferences.t}
                    onClearBrowserData={(role) => void roleWorkflow.handleClearBrowserData(role)}
                    onClearQuery={() => roleWorkflow.setQuery("")}
                    onCopy={(role) => void roleWorkflow.handleCopy(role)}
                    onDelete={(role) => void roleWorkflow.handleDelete(role)}
                    onDeleteMany={roleWorkflow.handleDeleteMany}
                    onEdit={(role) => navigateToEditRole(role.id)}
                    onError={data.setError}
                    onFilterChange={roleWorkflow.setActiveFilter}
                    onLaunch={(roleId) => void roleWorkflow.handleLaunch(roleId)}
                    onNewRole={navigateToNewRole}
                    onQueryChange={roleWorkflow.setQuery}
                    onReorder={(orderedIds) => void roleWorkflow.handleReorder(orderedIds)}
                    onStop={(roleId) => void roleWorkflow.handleStop(roleId)}
                    isReordering={roleWorkflow.isReorderingRoles}
                  />
                ) : (
                  <BridgeUnavailable t={preferences.t} />
                )
              }
            />
            <Route path="/roles/new" element={roleEditorElement} />
            <Route path="/roles/:id/edit" element={roleEditorElement} />
            <Route
              path="/workspaces"
              element={
                hasBridge ? (
                  <LaunchWorkspacesRoute
                    busyWorkspaceIds={workspaceWorkflow.busyWorkspaceIds}
                    games={data.games}
                    query={workspaceWorkflow.query}
                    roles={data.roles}
                    scrollPositionRef={workspaceWorkflow.listScrollTopRef}
                    statusByRole={data.statusByRole}
                    t={preferences.t}
                    workspaces={data.workspaces}
                    onCopyWorkspace={(workspace) => void workspaceWorkflow.handleCopyWorkspace(workspace)}
                    onCreateWorkspace={navigateToNewWorkspace}
                    onDeleteWorkspace={(workspace) => void workspaceWorkflow.handleDeleteWorkspace(workspace)}
                    onDeleteWorkspaces={workspaceWorkflow.handleDeleteWorkspaces}
                    onEditWorkspace={(workspace) => navigateToEditWorkspace(workspace.id)}
                    onLaunchWorkspace={(workspace) => void workspaceWorkflow.handleLaunchWorkspace(workspace)}
                    onQueryChange={workspaceWorkflow.setQuery}
                    onReorderWorkspaces={(orderedIds) => void workspaceWorkflow.handleReorderWorkspaces(orderedIds)}
                    onStopWorkspace={(workspace) => void workspaceWorkflow.handleStopWorkspace(workspace)}
                    isReordering={workspaceWorkflow.isReorderingWorkspaces}
                  />
                ) : (
                  <BridgeUnavailable t={preferences.t} />
                )
              }
            />
            <Route path="/workspaces/new" element={workspaceEditorElement} />
            <Route path="/workspaces/:id/edit" element={workspaceEditorElement} />
            <Route
              path="/game-windows"
              element={hasBridge ? (
                <GameWindowsRoute
                  displays={data.displays}
                  gameWindows={data.gameWindows} games={data.games}
                  runtime={data.embeddedRuntime} roles={data.roles}
                  t={preferences.t} workspaces={data.workspaces}
                  onEdit={navigateToEditGameWindow}
                  onError={data.setError}
                  onNew={navigateToNewGameWindow}
                />
              ) : <BridgeUnavailable t={preferences.t} />}
            />
            <Route
              path="/game-windows/new"
              element={hasBridge ? (
                <GameWindowEditorRoute
                  displays={data.displays}
                  gameWindows={data.gameWindows} games={data.games}
                  isSaving={isSavingGameWindow}
                  onError={data.setError} roles={data.roles} runtime={data.embeddedRuntime}
                  t={preferences.t}
                  workspaces={data.workspaces}
                  onSave={saveGameWindow}
                />
              ) : <BridgeUnavailable t={preferences.t} />}
            />
            <Route
              path="/game-windows/:id/edit"
              element={hasBridge ? (
                <GameWindowEditorRoute
                  displays={data.displays}
                  gameWindows={data.gameWindows} games={data.games}
                  isSaving={isSavingGameWindow}
                  onError={data.setError} roles={data.roles} runtime={data.embeddedRuntime}
                  t={preferences.t}
                  workspaces={data.workspaces}
                  onSave={saveGameWindow}
                />
              ) : <BridgeUnavailable t={preferences.t} />}
            />
            <Route
              path="/macros"
              element={
                hasBridge ? (
                  <MacrosRoute
                    busyMacroIds={macroWorkflow.busyMacroIds}
                    busyRunKeys={macroWorkflow.busyRunKeys}
                    macros={data.macros}
                    macroStatuses={data.macroStatuses}
                    macroStatusByRun={data.macroStatusByRun}
                    query={macroWorkflow.query}
                    roleFilterId={macroWorkflow.roleFilterId}
                    roles={data.roles}
                    scrollPositionRef={macroWorkflow.listScrollTopRef}
                    sort={macroWorkflow.sort}
                    statusByRole={data.statusByRole}
                    t={preferences.t}
                    onCopyMacro={(macro) => void macroWorkflow.handleCopyMacro(macro)}
                    onDeleteMacro={(macro) => void macroWorkflow.handleDeleteMacro(macro)}
                    onDeleteMacros={macroWorkflow.handleDeleteMacros}
                    onEditMacro={(macro) => navigateToEditMacro(macro.id)}
                    onNewMacro={navigateToNewMacro}
                    onQueryChange={macroWorkflow.setQuery}
                    onRoleFilterChange={macroWorkflow.setRoleFilterId}
                    onSetMacroEnabled={(macro, enabled) => void macroWorkflow.handleSetMacroEnabled(macro, enabled)}
                    onSetMacrosEnabled={macroWorkflow.handleSetMacrosEnabled}
                    onSortChange={macroWorkflow.setSort}
                    onStartMacro={(macroId) => void macroWorkflow.handleStartMacro(macroId)}
                    onStartMacros={macroWorkflow.handleStartMacros}
                    onStopMacro={(macroId) => void macroWorkflow.handleStopMacro(macroId)}
                    onStopMacros={macroWorkflow.handleStopMacros}
                  />
                ) : (
                  <BridgeUnavailable t={preferences.t} />
                )
              }
            />
            <Route path="/macros/new" element={macroEditorElement} />
            <Route path="/macros/:id/edit" element={macroEditorElement} />
            <Route
              path="/settings"
              element={
                <SettingsRoute
                  games={data.games}
                  gameBrowserSettings={gameBrowserSettings}
                  roles={data.roles}
                  language={preferences.language}
                  macroSettings={macroSettings}
                  runtimeWindowPreferences={runtimeWindowPreferences}
                  portableDataCounts={{
                    gameCount: data.games.length,
                    gameWindowCount: data.gameWindows.length,
                    macroCount: data.macros.length,
                    roleCount: data.roles.length,
                    workspaceCount: data.workspaces.length
                  }}
                  resolvedTheme={preferences.resolvedTheme}
                  t={preferences.t}
                  themeMode={preferences.themeMode}
                  updateStatus={updates.status}
                  updateVersion={updates.appVersion}
                  isUpdateBusy={updates.isBusy}
                  onCheckForUpdates={updates.checkForUpdates}
                  onSetAutoUpdateEnabled={updates.setAutoUpdateEnabled}
                  onError={data.setError}
                  onExportPortableData={exportPortableData}
                  onGameBrowserSettingsChange={updateGameBrowserSettings}
                  onGameBrowserSettingsPatch={patchGameBrowserSettings}
                  onMacroSettingsChange={updateMacroSettings}
                  onRuntimeWindowPreferencesChange={updateRuntimeWindowPreferences}
                  onLoadSystemFonts={loadSystemFonts}
                  onPreviewPortableImport={previewPortableImport}
                  onApplyPortableImport={applyPortableImport}
                  onDiscardPortableImport={discardPortableImport}
                  onOpenUpdateDownload={updates.openUpdateDownload}
                  onInstallDownloadedUpdate={updates.installDownloadedUpdate}
                  onLanguageChange={preferences.handleLanguageChange}
                  onThemeModeChange={preferences.handleThemeModeChange}
                  systemFonts={systemFonts}
                />
              }
            />
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </Suspense>
      </main>
    </div>
  );
}
