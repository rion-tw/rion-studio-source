import { AlertCircle, Loader2, RefreshCw } from "lucide-react";
import { lazy, Suspense, type JSX, useCallback, useEffect, useMemo, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router";

import appIconUrl from "./assets/app-icon.png";
import { AppSidebar } from "./components/AppSidebar";
import { Button } from "./components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "./components/ui/card";
import { Surface } from "./components/ui/patterns";
import { LegalOnboarding } from "./features/legal/LegalOnboarding";
import { SettingsSidebar } from "./features/settings/SettingsSidebar";
import { WorkspaceDisplayPickerDialog } from "./features/workspaces/WorkspaceDisplayPickerDialog";
import { ChromeProfileImportFlow } from "./features/chrome-profile-import/ChromeProfileImportFlow";
import { createEditEditorPath, createNewEditorPath } from "./app/editorNavigation";
import { toMessage } from "./app/errorUtils";
import { shouldShowUpdateBadge } from "./app/statusUtils";
import { scheduleAfterTwoAnimationFrames } from "./app/rendererReady";
import { useAppData } from "./hooks/useAppData";
import { useAppUpdates } from "./hooks/useAppUpdates";
import { useLegalAcceptance } from "./hooks/useLegalAcceptance";
import { useGameWorkflow } from "./hooks/useGameWorkflow";
import { useMacroWorkflow } from "./hooks/useMacroWorkflow";
import { usePreferences } from "./hooks/usePreferences";
import { useRoleWorkflow } from "./hooks/useRoleWorkflow";
import { useWorkspaceWorkflow } from "./hooks/useWorkspaceWorkflow";
import { localizeErrorMessage, type Language, type Translator } from "./i18n";
import { DEFAULT_GAME_BROWSER_SETTINGS } from "../../shared/browserFonts";
import { DEFAULT_MACRO_SETTINGS } from "../../shared/macroSettings";
import type {
  GameBrowserSettings,
  ChromeProfileImportInput,
  ChromeProfileImportProgress,
  ChromeProfileImportPreview,
  ChromeProfileImportResult,
  GraphicsDiagnostics,
  MacroSettings,
  PortableExportInput,
  PortableExportResult,
  PortableImportInput,
  PortableImportPreview,
  PortableImportResult,
  RuntimeWindowPreferences,
  SystemFontFamily
} from "../../shared/types";

const RolesRoute = lazy(() => import("./features/roles/RolesRoute"));
const GamesRoute = lazy(() => import("./features/games/GamesRoute"));
const GameEditorRoute = lazy(() => import("./features/games/GameModal"));
const RoleEditorRoute = lazy(() => import("./features/roles/RoleModal"));
const DashboardRoute = lazy(() => import("./features/dashboard/DashboardRoute"));
const LaunchWorkspacesRoute = lazy(() => import("./features/workspaces/LaunchWorkspacesRoute"));
const WorkspaceEditorRoute = lazy(() => import("./features/workspaces/WorkspaceModal"));
const MacrosRoute = lazy(() => import("./features/macros/MacrosRoute"));
const MacroEditorRoute = lazy(() => import("./features/macros/MacroModal"));
const SettingsRoute = lazy(() => import("./features/settings/SettingsRoute"));
const TOAST_DISMISS_MS = 4000;

export function App(): JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const data = useAppData();
  const preferences = usePreferences();
  const hasBridge = Boolean(window.rionStudio);
  const legal = useLegalAcceptance(hasBridge);
  const [gameBrowserSettings, setGameBrowserSettings] = useState<GameBrowserSettings>(DEFAULT_GAME_BROWSER_SETTINGS);
  const [macroSettings, setMacroSettings] = useState<MacroSettings>(DEFAULT_MACRO_SETTINGS);
  const [runtimeWindowPreferences, setRuntimeWindowPreferences] =
    useState<RuntimeWindowPreferences>({
      alwaysShowToolbarInFullScreen: false,
      restoreGameWindowsOnStartup: true
    });
  const [notice, setNotice] = useState<string | null>(null);
  const [busyExternalRoleIds, setBusyExternalRoleIds] = useState<ReadonlySet<string>>(() => new Set());
  const [isChromeProfileImportOpen, setIsChromeProfileImportOpen] = useState(false);
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
      throw new Error("Rion Studio preload bridge is unavailable. Restart the app after rebuilding.");
    }

    const nextSettings = await window.rionStudio.updateGameBrowserSettings(settings);
    setGameBrowserSettings(nextSettings);
    return nextSettings;
  }, []);
  const updateMacroSettings = useCallback(async (settings: MacroSettings): Promise<MacroSettings> => {
    if (!window.rionStudio) {
      throw new Error("Rion Studio preload bridge is unavailable. Restart the app after rebuilding.");
    }

    const nextSettings = await window.rionStudio.updateMacroSettings(settings);
    setMacroSettings(nextSettings);
    return nextSettings;
  }, []);
  const updateRuntimeWindowPreferences = useCallback(
    async (next: RuntimeWindowPreferences): Promise<RuntimeWindowPreferences> => {
      if (!window.rionStudio) {
        throw new Error("Rion Studio preload bridge is unavailable. Restart the app after rebuilding.");
      }
      const updated = await window.rionStudio.updateRuntimeWindowPreferences(next);
      setRuntimeWindowPreferences(updated);
      return updated;
    },
    []
  );
  const loadSystemFonts = useCallback(async (): Promise<SystemFontFamily[]> => {
    if (!window.rionStudio) {
      throw new Error("Rion Studio preload bridge is unavailable. Restart the app after rebuilding.");
    }

    if (systemFonts.length > 0) {
      return systemFonts;
    }

    const nextFonts = await window.rionStudio.listSystemFonts();
    setSystemFonts(nextFonts);
    return nextFonts;
  }, [systemFonts]);
  const loadGraphicsDiagnostics = useCallback(async (): Promise<GraphicsDiagnostics> => {
    if (!window.rionStudio) {
      throw new Error("Rion Studio preload bridge is unavailable. Restart the app after rebuilding.");
    }

    return window.rionStudio.getGraphicsDiagnostics();
  }, []);
  const restartApplication = useCallback(async (): Promise<void> => {
    if (!window.rionStudio) {
      throw new Error("Rion Studio preload bridge is unavailable. Restart the app after rebuilding.");
    }

    await window.rionStudio.restartApplication();
  }, []);
  const exportPortableData = useCallback(async (input: PortableExportInput): Promise<PortableExportResult | null> => {
    if (!window.rionStudio) {
      throw new Error("Rion Studio preload bridge is unavailable. Restart the app after rebuilding.");
    }

    return window.rionStudio.exportPortableData(input);
  }, []);
  const previewPortableImport = useCallback(async (): Promise<PortableImportPreview | null> => {
    if (!window.rionStudio) {
      throw new Error("Rion Studio preload bridge is unavailable. Restart the app after rebuilding.");
    }

    return window.rionStudio.previewPortableImport();
  }, []);
  const discardPortableImport = useCallback(async (importId: string): Promise<void> => {
    if (!window.rionStudio) {
      throw new Error("Rion Studio preload bridge is unavailable. Restart the app after rebuilding.");
    }
    await window.rionStudio.discardPortableImport(importId);
  }, []);
  const applyPortableImport = useCallback(
    async (input: PortableImportInput): Promise<PortableImportResult> => {
      if (!window.rionStudio) {
        throw new Error("Rion Studio preload bridge is unavailable. Restart the app after rebuilding.");
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
  const previewChromeProfileImport = useCallback(async (): Promise<ChromeProfileImportPreview | null> => {
    if (!window.rionStudio) {
      throw new Error("Rion Studio preload bridge is unavailable. Restart the app after rebuilding.");
    }
    return window.rionStudio.previewChromeProfileImport();
  }, []);
  const applyChromeProfileImport = useCallback(async (input: ChromeProfileImportInput): Promise<ChromeProfileImportResult> => {
    if (!window.rionStudio) {
      throw new Error("Rion Studio preload bridge is unavailable. Restart the app after rebuilding.");
    }
    const result = await window.rionStudio.applyChromeProfileImport(input);
    await data.loadData();
    return result;
  }, [data]);
  const discardChromeProfileImport = useCallback(async (importId: string): Promise<void> => {
    if (!window.rionStudio) {
      throw new Error("Rion Studio preload bridge is unavailable. Restart the app after rebuilding.");
    }
    await window.rionStudio.discardChromeProfileImport(importId);
  }, []);
  const subscribeChromeProfileImportProgress = useCallback(
    (callback: (progress: ChromeProfileImportProgress) => void): (() => void) => {
      if (!window.rionStudio) return () => undefined;
      return window.rionStudio.onChromeProfileImportProgress(callback);
    },
    []
  );
  const openChromeProfileImport = useCallback(() => {
    if (data.games.length > 0) {
      setIsChromeProfileImportOpen(true);
    }
  }, [data.games.length]);

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
    setCompatibilityReports: data.setCompatibilityReports,
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
  const handleWorkspaceLaunch = workspaceWorkflow.handleLaunchWorkspace;

  const macroWorkflow = useMacroWorkflow({
    beginErrorOperation: data.beginErrorOperation,
    macros: data.macros,
    setMacros: data.setMacros,
    setMacroStatuses: data.setMacroStatuses,
    setNotice,
    t: preferences.t
  });
  const busyRoleIds = useMemo(
    () => new Set([...roleWorkflow.busyRoleIds, ...busyExternalRoleIds]),
    [busyExternalRoleIds, roleWorkflow.busyRoleIds]
  );
  const runExternalRoleAction = useCallback(async (roleId: string, action: () => Promise<void>): Promise<void> => {
    setBusyExternalRoleIds((current) => new Set(current).add(roleId));
    try {
      await action();
    } finally {
      setBusyExternalRoleIds((current) => {
        const next = new Set(current);
        next.delete(roleId);
        return next;
      });
    }
  }, []);
  const handleCaptureExternalDiagnostics = useCallback((roleId: string): void => {
    if (!window.rionStudio) return;
    void runExternalRoleAction(roleId, async () => {
      await window.rionStudio.captureExternalRoleDiagnostics(roleId);
      setNotice(preferences.t("roles.freezeReportCaptured"));
    }).catch(data.setError);
  }, [data, preferences, runExternalRoleAction]);
  const handleRecoverExternalRole = useCallback((roleId: string): void => {
    if (!window.rionStudio) return;
    void runExternalRoleAction(roleId, async () => {
      const status = await window.rionStudio.recoverExternalRole(roleId);
      data.setStatuses((current) => [...current.filter((item) => item.roleId !== roleId), status]);
      setNotice(preferences.t("roles.externalRecoveryStarted"));
    }).catch(data.setError);
  }, [data, preferences, runExternalRoleAction]);
  const { openListForRole } = macroWorkflow;
  const { initialLoadState, setError } = data;

  useEffect(() => {
    if (initialLoadState !== "ready" || data.error === null) {
      return;
    }

    const timeoutId = window.setTimeout(() => setError(null), TOAST_DISMISS_MS);
    return () => window.clearTimeout(timeoutId);
  }, [data.error, initialLoadState, setError]);

  useEffect(() => {
    if (initialLoadState !== "ready" || data.error !== null || notice === null) {
      return;
    }

    const timeoutId = window.setTimeout(() => setNotice(null), TOAST_DISMISS_MS);
    return () => window.clearTimeout(timeoutId);
  }, [data.error, initialLoadState, notice]);

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

  useEffect(() => {
    if (!hasBridge || initialLoadState !== "ready") {
      return;
    }

    let isDisposed = false;

    const consumePendingLaunchRequest = (): void => {
      void window.rionStudio
        .consumePendingWorkspaceLaunchRequest()
        .then((request) => {
          if (isDisposed || !request) {
            return;
          }

          const workspace = data.workspaces.find((item) => item.id === request.workspaceId);
          navigate("/workspaces");
          if (!workspace) {
            setError(new Error("Launch workspace not found."));
            return;
          }

          void handleWorkspaceLaunch(workspace, request.result);
        })
        .catch(setError);
    };

    const unsubscribe = window.rionStudio.onWorkspaceLaunchRequested(() => {
      consumePendingLaunchRequest();
    });

    consumePendingLaunchRequest();

    return () => {
      isDisposed = true;
      unsubscribe();
    };
  }, [
    data.workspaces,
    hasBridge,
    initialLoadState,
    navigate,
    setError,
    handleWorkspaceLaunch
  ]);

  useEffect(() => {
    if (!hasBridge || initialLoadState === "loading" || legal.isLoading) {
      return;
    }

    let isDisposed = false;
    let cancelScheduledPaint = (): void => undefined;
    const notifyAfterSettledPaint = (): void => {
      cancelScheduledPaint = scheduleAfterTwoAnimationFrames(() => {
        if (isDisposed) {
          return;
        }

        if (document.querySelector("[data-renderer-pending]")) {
          notifyAfterSettledPaint();
          return;
        }

        void window.rionStudio.notifyAppReady(initialLoadState).catch((readyError) => {
          console.error("Failed to notify the main process that the renderer is ready.", readyError);
        });
      });
    };

    notifyAfterSettledPaint();

    return () => {
      isDisposed = true;
      cancelScheduledPaint();
    };
  }, [hasBridge, initialLoadState, legal.isLoading]);

  if (hasBridge && (data.initialLoadState !== "ready" || legal.isLoading)) {
    return (
      <BootLoadingScreen
        error={data.error}
        language={preferences.language}
        state={data.initialLoadState === "failed" ? "failed" : "loading"}
        t={preferences.t}
        onRetry={() => void data.loadData({ markInitialLoad: true })}
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
      reports={data.gameCompatibilityReports}
      runStatuses={data.gameCompatibilityStatuses}
      t={preferences.t}
      onApplyRecommendation={gameWorkflow.applyRecommendation}
      onCancelCheck={(gameId) => void gameWorkflow.cancelCompatibilityCheck(gameId)}
      onError={data.setError}
      onOpenGraphicsSettings={(gameId) => navigate("/settings?section=game", { state: { returnTo: `/games/${gameId}/edit` } })}
      onReset={gameWorkflow.resetBuiltinGame}
      onRunCheck={(gameId) => void gameWorkflow.runCompatibilityCheck(gameId)}
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
      workspaceDisplays={data.workspaceDisplays}
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
          hasUpdateBadge={shouldShowUpdateBadge(updates.status)}
          macroCount={data.macros.length}
          roleCount={data.roles.length}
          t={preferences.t}
          workspaceCount={data.workspaces.length}
        />
      )}

      <main className="app-content relative min-w-0 flex-1 overflow-hidden">
        {data.error !== null ? (
          <Surface
            className="pointer-events-none absolute bottom-5 left-1/2 z-40 flex w-fit max-w-[min(720px,calc(100%_-_2.5rem))] -translate-x-1/2 items-start gap-3 border-destructive/30 px-4 py-3 text-sm text-destructive md:bottom-6 md:max-w-[min(720px,calc(100%_-_3rem))]"
            role="alert"
            variant="strong"
          >
            <AlertCircle className="mt-0.5 shrink-0" size={17} />
            <span className="min-w-0 break-words">{toMessage(data.error, preferences.language, preferences.t)}</span>
          </Surface>
        ) : null}
        {data.error === null && notice !== null ? (
          <Surface
            className="pointer-events-none absolute bottom-5 left-1/2 z-40 flex w-fit max-w-[min(720px,calc(100%_-_2.5rem))] -translate-x-1/2 items-start gap-3 border-primary/30 px-4 py-3 text-sm text-foreground md:bottom-6 md:max-w-[min(720px,calc(100%_-_3rem))]"
            role="status"
            variant="strong"
          >
            <AlertCircle className="mt-0.5 shrink-0 text-primary" size={17} />
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
                reports={data.gameCompatibilityReports}
                roles={data.roles}
                runStatuses={data.gameCompatibilityStatuses}
                statusByRole={data.statusByRole}
                t={preferences.t}
                onDelete={(game) => void gameWorkflow.deleteGame(game)}
                onDeleteMany={gameWorkflow.deleteGames}
                onEdit={(game) => navigateToEditGame(game.id)}
                onNewGame={navigateToNewGame}
                onNewRole={navigateToNewRoleForGame}
                onRunCheck={(gameId) => void gameWorkflow.runCompatibilityCheck(gameId)}
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
                    workspaceDisplays={data.workspaceDisplays}
                    onCreateWorkspace={navigateToNewWorkspace}
                    onCaptureExternalDiagnostics={handleCaptureExternalDiagnostics}
                    onShowGameWindows={(displayId) => void window.rionStudio.showEmbeddedRuntimeWindows(displayId)}
                    onRestoreSavedGameWindows={(input) =>
                      void window.rionStudio.restoreSavedGameWindows(input)
                    }
                    onDiscardSavedGameWindows={(input) =>
                      void window.rionStudio.discardSavedGameWindows(input)
                    }
                    onStopGameWindow={(displayId) =>
                      void window.rionStudio.stopEmbeddedRuntimeWindow(displayId)
                    }
                    onLaunchRole={(roleId) => void roleWorkflow.handleLaunch(roleId)}
                    onLaunchWorkspace={(workspace) => void workspaceWorkflow.handleLaunchWorkspace(workspace)}
                    onNavigateMacros={navigateToMacros}
                    onNavigateGames={() => navigate("/games")}
                    onNavigateRoles={(filter) => {
                      roleWorkflow.setActiveFilter(filter);
                      roleWorkflow.setQuery("");
                      navigate("/roles");
                    }}
                    onNavigateWorkspaces={() => navigate("/workspaces")}
                    onRecoverExternalRole={handleRecoverExternalRole}
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
                    isChromeProfileImportOpen={isChromeProfileImportOpen}
                    roleStats={data.roleStats}
                    roles={data.roles}
                    scrollPositionRef={roleWorkflow.listScrollTopRef}
                    query={roleWorkflow.query}
                    statusByRole={data.statusByRole}
                    t={preferences.t}
                    onClearBrowserData={(role) => void roleWorkflow.handleClearBrowserData(role)}
                    onClearQuery={() => roleWorkflow.setQuery("")}
                    onCaptureExternalDiagnostics={handleCaptureExternalDiagnostics}
                    onCopy={(role) => void roleWorkflow.handleCopy(role)}
                    onDelete={(role) => void roleWorkflow.handleDelete(role)}
                    onDeleteMany={roleWorkflow.handleDeleteMany}
                    onEdit={(role) => navigateToEditRole(role.id)}
                    onFilterChange={roleWorkflow.setActiveFilter}
                    onLaunch={(roleId) => void roleWorkflow.handleLaunch(roleId)}
                    onOpenChromeProfileImport={openChromeProfileImport}
                    onRecoverExternalRole={handleRecoverExternalRole}
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
                    workspaceDisplays={data.workspaceDisplays}
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
                    onSortChange={macroWorkflow.setSort}
                    onStartMacro={(macroId) => void macroWorkflow.handleStartMacro(macroId)}
                    onStopMacro={(macroId) => void macroWorkflow.handleStopMacro(macroId)}
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
                  gameBrowserSettings={gameBrowserSettings}
                  games={data.games}
                  hasRunningRoles={data.statuses.some(
                    (status) => status.state === "launching" || status.state === "running"
                  )}
                  language={preferences.language}
                  macroSettings={macroSettings}
                  runtimeWindowPreferences={runtimeWindowPreferences}
                  portableDataCounts={{
                    gameCount: data.games.length,
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
                  onMacroSettingsChange={updateMacroSettings}
                  onRuntimeWindowPreferencesChange={updateRuntimeWindowPreferences}
                  onLoadGraphicsDiagnostics={loadGraphicsDiagnostics}
                  onLoadSystemFonts={loadSystemFonts}
                  onPreviewPortableImport={previewPortableImport}
                  onApplyPortableImport={applyPortableImport}
                  onDiscardPortableImport={discardPortableImport}
                  onOpenChromeProfileImport={openChromeProfileImport}
                  onOpenUpdateDownload={updates.openUpdateDownload}
                  onInstallDownloadedUpdate={updates.installDownloadedUpdate}
                  onRestartApplication={restartApplication}
                  onLanguageChange={preferences.handleLanguageChange}
                  onThemeModeChange={preferences.handleThemeModeChange}
                  systemFonts={systemFonts}
                />
              }
            />
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </Suspense>
        <ChromeProfileImportFlow
          games={data.games}
          isOpen={isChromeProfileImportOpen}
          t={preferences.t}
          onApply={applyChromeProfileImport}
          onCloseChrome={() => window.rionStudio.closeChromeForImport()}
          onDiscard={discardChromeProfileImport}
          onError={data.setError}
          onOpenChange={setIsChromeProfileImportOpen}
          onPreview={previewChromeProfileImport}
          onProgress={subscribeChromeProfileImportProgress}
        />
      </main>
      <WorkspaceDisplayPickerDialog
        request={workspaceWorkflow.displaySelectionRequest}
        t={preferences.t}
        onCancel={workspaceWorkflow.handleDisplaySelectionCancel}
        onSelect={workspaceWorkflow.handleDisplaySelectionSelect}
      />
    </div>
  );
}

function BootLoadingScreen({
  error,
  language,
  onRetry,
  state,
  t
}: {
  error: unknown | null;
  language: Language;
  onRetry: () => void;
  state: "failed" | "loading";
  t: Translator;
}): JSX.Element {
  const isFailed = state === "failed";

  return (
    <div className="liquid-app-shell app-drag grid h-screen place-items-center overflow-hidden p-6 text-foreground">
      <section
        aria-busy={!isFailed}
        aria-label={!isFailed ? "Loading Rion Studio" : undefined}
        aria-live="polite"
        className="app-no-drag grid w-full max-w-[420px] justify-items-center gap-5 text-center"
      >
        <img
          className="size-16 rounded-lg shadow-lg shadow-black/10"
          src={appIconUrl}
          alt=""
          aria-hidden="true"
          draggable={false}
        />
        {isFailed ? (
          <>
            <div className="grid gap-1">
              <h1 className="text-lg font-semibold leading-7">Rion Studio</h1>
              <p className="text-sm font-medium text-muted-foreground">{t("app.tagline")}</p>
            </div>
            <Surface className="boot-card w-full p-5" variant="strong">
              <div className="grid gap-4 text-left">
                <div className="flex items-start gap-3">
                  <AlertCircle className="mt-0.5 shrink-0 text-destructive" size={18} />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold leading-5">{t("loading.failedTitle")}</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      {error ? toMessage(error, language, t) : t("loading.failedDescription")}
                    </p>
                  </div>
                </div>
                <Button className="justify-self-start" type="button" onClick={onRetry}>
                  <RefreshCw size={15} />
                  {t("loading.retry")}
                </Button>
              </div>
            </Surface>
          </>
        ) : (
          <Loader2 className="spin text-muted-foreground" size={22} aria-hidden="true" />
        )}
      </section>
    </div>
  );
}

function RouteFallback({ t }: { t: Translator }): JSX.Element {
  return (
    <div className="grid h-full place-items-center p-6" aria-label={t("loading.route")} data-renderer-pending>
      <Surface className="grid size-12 place-items-center boot-card" padding="sm" variant="strong">
        <Loader2 className="spin text-muted-foreground" size={20} />
      </Surface>
    </div>
  );
}

function BridgeUnavailable({ t }: { t: (key: "bridge.title" | "bridge.description") => string }): JSX.Element {
  return (
    <div className="grid h-full place-items-center p-6">
      <Card className="max-w-lg glass-panel-strong">
        <CardHeader>
          <CardTitle>{t("bridge.title")}</CardTitle>
          <CardDescription>{t("bridge.description")}</CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}
