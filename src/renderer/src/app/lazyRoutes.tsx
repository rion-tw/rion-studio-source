// Focused implementation extracted from App.tsx.
import { lazy } from "react";

export const RolesRoute = lazy(() => import("../features/roles/RolesRoute"));

export const GamesRoute = lazy(() => import("../features/games/GamesRoute"));

export const GameEditorRoute = lazy(() => import("../features/games/GameModal"));

export const RoleEditorRoute = lazy(() => import("../features/roles/RoleModal"));

export const DashboardRoute = lazy(() => import("../features/dashboard/DashboardRoute"));

export const LaunchWorkspacesRoute = lazy(() => import("../features/workspaces/LaunchWorkspacesRoute"));

export const WorkspaceEditorRoute = lazy(() => import("../features/workspaces/WorkspaceModal"));

export const GameWindowsRoute = lazy(() => import("../features/game-windows/GameWindowsRoute"));

export const MacrosRoute = lazy(() => import("../features/macros/MacrosRoute"));

export const MacroEditorRoute = lazy(() => import("../features/macros/MacroModal"));

export const SettingsRoute = lazy(() => import("../features/settings/SettingsRoute"));
