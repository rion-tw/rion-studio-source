import { AlertCircle, Loader2, RefreshCw } from "lucide-react";
import { lazy, Suspense, type JSX, useCallback, useEffect } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router";

import appIconUrl from "./assets/app-icon.png";
import { AppSidebar } from "./components/AppSidebar";
import { Button } from "./components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "./components/ui/card";
import { Surface } from "./components/ui/patterns";
import RoleModal from "./features/roles/RoleModal";
import { SettingsSidebar } from "./features/settings/SettingsSidebar";
import WorkspaceModal from "./features/workspaces/WorkspaceModal";
import { toMessage } from "./app/errorUtils";
import { shouldShowLoginGuidance } from "./app/statusUtils";
import { scheduleAfterTwoAnimationFrames } from "./app/rendererReady";
import { useAppData } from "./hooks/useAppData";
import { useAppUpdates } from "./hooks/useAppUpdates";
import { useMacroWorkflow } from "./hooks/useMacroWorkflow";
import { usePreferences } from "./hooks/usePreferences";
import { useRoleWorkflow } from "./hooks/useRoleWorkflow";
import { useWorkspaceWorkflow } from "./hooks/useWorkspaceWorkflow";
import type { Language, Translator } from "./i18n";
import type {
  MacroEditorRequest,
  PortableExportInput,
  PortableExportResult,
  PortableImportPreview,
  PortableImportResult
} from "../../shared/types";

const RolesRoute = lazy(() => import("./features/roles/RolesRoute"));
const LaunchWorkspacesRoute = lazy(() => import("./features/workspaces/LaunchWorkspacesRoute"));
const MacrosRoute = lazy(() => import("./features/macros/MacrosRoute"));
const MacroModal = lazy(() => import("./features/macros/MacroModal"));
const SettingsRoute = lazy(() => import("./features/settings/SettingsRoute"));

export function App(): JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const data = useAppData();
  const preferences = usePreferences();
  const hasBridge = Boolean(window.rionStudio);
  const updates = useAppUpdates({
    enabled: hasBridge,
    onError: data.setError
  });
  const navigateToMacros = useCallback(() => navigate("/macros"), [navigate]);
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
  const applyPortableImport = useCallback(
    async (importId: string): Promise<PortableImportResult> => {
      if (!window.rionStudio) {
        throw new Error("Rion Studio preload bridge is unavailable. Restart the app after rebuilding.");
      }

      const result = await window.rionStudio.applyPortableImport(importId);
      if (result.preferences?.themeMode) {
        preferences.handleThemeModeChange(result.preferences.themeMode);
      }

      if (result.preferences?.language) {
        preferences.handleLanguageChange(result.preferences.language);
      }

      await data.loadData();
      return result;
    },
    [data, preferences]
  );

  const roleWorkflow = useRoleWorkflow({
    loadData: data.loadData,
    navigateToRoles: () => navigate("/roles"),
    roles: data.roles,
    setAuthStatuses: data.setAuthStatuses,
    setError: data.setError,
    setStatuses: data.setStatuses,
    statusByRole: data.statusByRole,
    t: preferences.t
  });

  const workspaceWorkflow = useWorkspaceWorkflow({
    loadData: data.loadData,
    navigateToWorkspaces: () => navigate("/workspaces"),
    setError: data.setError,
    setStatuses: data.setStatuses,
    setWorkspaces: data.setWorkspaces,
    t: preferences.t,
    workspaces: data.workspaces
  });

  const macroWorkflow = useMacroWorkflow({
    loadData: data.loadData,
    macros: data.macros,
    navigateToMacros,
    roles: data.roles,
    setError: data.setError,
    setMacroStatuses: data.setMacroStatuses,
    setMacros: data.setMacros,
    t: preferences.t
  });
  const { startCreateMacro, startEditMacro } = macroWorkflow;
  const {
    initialLoadState,
    macros,
    setError,
    setMacros
  } = data;

  useEffect(() => {
    if (!hasBridge || initialLoadState !== "ready") {
      return;
    }

    let isDisposed = false;

    const openMacroEditorRequest = async (request: MacroEditorRequest): Promise<void> => {
      if (!request.macroId) {
        startCreateMacro(request.roleId);
        return;
      }

      let macro = macros.find((item) => item.id === request.macroId);
      if (!macro) {
        const latestMacros = await window.rionStudio.listMacros();
        setMacros(latestMacros);
        macro = latestMacros.find((item) => item.id === request.macroId);
      }

      if (!macro) {
        navigateToMacros();
        throw new Error("The requested macro is no longer available.");
      }

      startEditMacro(macro);
    };

    const consumePendingEditorRequest = (): void => {
      void window.rionStudio
        .consumePendingMacroEditorRequest()
        .then(async (request) => {
          if (!isDisposed && request) {
            await openMacroEditorRequest(request);
          }
        })
        .catch(setError);
    };

    const unsubscribe = window.rionStudio.onMacroEditorRequested(() => {
      consumePendingEditorRequest();
    });

    consumePendingEditorRequest();

    return () => {
      isDisposed = true;
      unsubscribe();
    };
  }, [hasBridge, initialLoadState, macros, navigateToMacros, setError, setMacros, startCreateMacro, startEditMacro]);

  useEffect(() => {
    if (!hasBridge || initialLoadState === "loading") {
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
  }, [hasBridge, initialLoadState]);

  if (hasBridge && data.initialLoadState !== "ready") {
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

  return (
    <div className="liquid-app-shell flex h-screen overflow-hidden text-foreground">
      {location.pathname === "/settings" ? (
        <SettingsSidebar t={preferences.t} />
      ) : (
        <AppSidebar
          macroCount={data.macros.length}
          roleCount={data.roles.length}
          t={preferences.t}
          workspaceCount={data.workspaces.length}
        />
      )}

      <main className="app-content relative min-w-0 flex-1 overflow-hidden">
        {data.error !== null ? (
          <Surface className="absolute left-5 right-5 top-5 z-40 flex items-start gap-3 border-destructive/30 px-4 py-3 text-sm text-destructive md:left-6 md:right-6" variant="strong">
            <AlertCircle className="mt-0.5 shrink-0" size={17} />
            <span>{toMessage(data.error, preferences.language, preferences.t)}</span>
          </Surface>
        ) : null}

        <Suspense fallback={<RouteFallback t={preferences.t} />}>
          <Routes>
            <Route path="/" element={<Navigate to="/roles" replace />} />
            <Route
              path="/roles"
              element={
                hasBridge ? (
                  <RolesRoute
                    activeFilter={roleWorkflow.activeFilter}
                    authStatusByRole={data.authStatusByRole}
                    busyRoleId={roleWorkflow.busyRoleId}
                    filteredRoles={roleWorkflow.filteredRoles}
                    language={preferences.language}
                    roleStats={data.roleStats}
                    roles={data.roles}
                    query={roleWorkflow.query}
                    statusByRole={data.statusByRole}
                    t={preferences.t}
                    onClearQuery={() => roleWorkflow.setQuery("")}
                    onCopy={(role) => void roleWorkflow.handleCopy(role)}
                    onDelete={(role) => void roleWorkflow.handleDelete(role)}
                    onEdit={roleWorkflow.startEdit}
                    onFilterChange={roleWorkflow.setActiveFilter}
                    onLaunch={(roleId) => void roleWorkflow.handleLaunch(roleId)}
                    onLogin={roleWorkflow.requestSystemLogin}
                    onNewRole={roleWorkflow.startCreate}
                    onQueryChange={roleWorkflow.setQuery}
                    onStop={(roleId) => void roleWorkflow.handleStop(roleId)}
                  />
                ) : (
                  <BridgeUnavailable t={preferences.t} />
                )
              }
            />
            <Route
              path="/workspaces"
              element={
                hasBridge ? (
                  <LaunchWorkspacesRoute
                    busyWorkspaceId={workspaceWorkflow.busyWorkspaceId}
                    roles={data.roles}
                    statusByRole={data.statusByRole}
                    t={preferences.t}
                    workspaces={data.workspaces}
                    onCopyWorkspace={(workspace) => void workspaceWorkflow.handleCopyWorkspace(workspace)}
                    onCreateWorkspace={workspaceWorkflow.startCreateWorkspace}
                    onDeleteWorkspace={(workspace) => void workspaceWorkflow.handleDeleteWorkspace(workspace)}
                    onEditWorkspace={workspaceWorkflow.startEditWorkspace}
                    onLaunchWorkspace={(workspace) => void workspaceWorkflow.handleLaunchWorkspace(workspace)}
                    onStopWorkspace={(workspace) => void workspaceWorkflow.handleStopWorkspace(workspace)}
                  />
                ) : (
                  <BridgeUnavailable t={preferences.t} />
                )
              }
            />
            <Route
              path="/macros"
              element={
                hasBridge ? (
                  <MacrosRoute
                    busyMacroId={macroWorkflow.busyMacroId}
                    busyRunKey={macroWorkflow.busyRunKey}
                    macros={data.macros}
                    macroStatuses={data.macroStatuses}
                    macroStatusByRun={data.macroStatusByRun}
                    roles={data.roles}
                    statusByRole={data.statusByRole}
                    t={preferences.t}
                    onCopyMacro={(macro) => void macroWorkflow.handleCopyMacro(macro)}
                    onDeleteMacro={(macro) => void macroWorkflow.handleDeleteMacro(macro)}
                    onEditMacro={macroWorkflow.startEditMacro}
                    onNewMacro={macroWorkflow.startCreateMacro}
                    onStartMacro={(macroId) => void macroWorkflow.handleStartMacro(macroId)}
                    onStopMacro={(macroId) => void macroWorkflow.handleStopMacro(macroId)}
                  />
                ) : (
                  <BridgeUnavailable t={preferences.t} />
                )
              }
            />
            <Route
              path="/settings"
              element={
                <SettingsRoute
                  language={preferences.language}
                  resolvedTheme={preferences.resolvedTheme}
                  t={preferences.t}
                  themeMode={preferences.themeMode}
                  updateStatus={updates.status}
                  updateVersion={updates.appVersion}
                  isUpdateBusy={updates.isBusy}
                  onCheckForUpdates={updates.checkForUpdates}
                  onError={data.setError}
                  onExportPortableData={exportPortableData}
                  onPreviewPortableImport={previewPortableImport}
                  onApplyPortableImport={applyPortableImport}
                  onOpenUpdateDownload={updates.openUpdateDownload}
                  onInstallDownloadedUpdate={updates.installDownloadedUpdate}
                  onLanguageChange={preferences.handleLanguageChange}
                  onThemeModeChange={preferences.handleThemeModeChange}
                />
              }
            />
            <Route path="*" element={<Navigate to="/roles" replace />} />
          </Routes>
        </Suspense>
      </main>

      {hasBridge && roleWorkflow.isRoleModalOpen ? (
        <RoleModal
          authStatus={
            roleWorkflow.selectedRole
              ? data.authStatusByRole.get(roleWorkflow.selectedRole.id)
              : undefined
          }
          form={roleWorkflow.form}
          isLoginBusy={Boolean(
            roleWorkflow.selectedRole &&
              (roleWorkflow.busyRoleId === roleWorkflow.selectedRole.id ||
                shouldShowLoginGuidance(data.authStatusByRole.get(roleWorkflow.selectedRole.id)))
          )}
          isSaving={roleWorkflow.isSaving}
          selectedRole={roleWorkflow.selectedRole}
          t={preferences.t}
          onCancel={roleWorkflow.closeRoleModal}
          onChange={roleWorkflow.setForm}
          onError={data.setError}
          onRelogin={roleWorkflow.requestSystemLogin}
          onSubmit={roleWorkflow.handleSubmit}
        />
      ) : null}

      {hasBridge && workspaceWorkflow.isWorkspaceModalOpen && workspaceWorkflow.workspaceForm ? (
        <WorkspaceModal
          form={workspaceWorkflow.workspaceForm}
          isSaving={workspaceWorkflow.isSavingWorkspace}
          roles={data.roles}
          statusByRole={data.statusByRole}
          t={preferences.t}
          onCancel={workspaceWorkflow.closeWorkspaceModal}
          onChange={workspaceWorkflow.setWorkspaceForm}
          onSubmit={workspaceWorkflow.handleWorkspaceSubmit}
        />
      ) : null}

      {hasBridge && macroWorkflow.isMacroModalOpen && macroWorkflow.macroForm ? (
        <Suspense fallback={null}>
          <MacroModal
            form={macroWorkflow.macroForm}
            isSaving={macroWorkflow.isSavingMacro}
            roles={data.roles}
            t={preferences.t}
            onCancel={macroWorkflow.closeMacroModal}
            onChange={(nextForm) => {
              macroWorkflow.setMacroForm((current) => {
                if (!current) {
                  return current;
                }

                return typeof nextForm === "function" ? nextForm(current) : nextForm;
              });
            }}
            onSubmit={macroWorkflow.handleMacroSubmit}
          />
        </Suspense>
      ) : null}

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
