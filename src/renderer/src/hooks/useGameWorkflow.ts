import { useState, type Dispatch, type SetStateAction } from "react";

import type { GameFormState } from "../app/types";
import { useConfirmation } from "../components/confirmation";
import type { Translator } from "../i18n";
import type { Game, GameCompatibilityReport, Role, RoleDefaults } from "../../../shared/types";

interface UseGameWorkflowOptions {
  beginErrorOperation: () => (error: unknown) => void;
  setGames: Dispatch<SetStateAction<Game[]>>;
  setCompatibilityReports: Dispatch<SetStateAction<GameCompatibilityReport[]>>;
  roleDefaults: RoleDefaults;
  roles: Role[];
  t: Translator;
}

export function useGameWorkflow({
  beginErrorOperation,
  setGames,
  setCompatibilityReports,
  roleDefaults,
  roles,
  t
}: UseGameWorkflowOptions) {
  const confirm = useConfirmation();
  const [isSavingGame, setIsSavingGame] = useState(false);

  async function saveGame(form: GameFormState): Promise<Game | undefined> {
    const reportError = beginErrorOperation();
    setIsSavingGame(true);
    try {
      const input = {
        name: form.name,
        iconImageDataUrl: form.source === "custom" ? form.iconImageDataUrl ?? null : undefined,
        defaultLaunchUrl: form.defaultLaunchUrl,
        loginUrl: form.loginUrl.trim() || null,
        roleDefaults: form.usesGlobalRoleDefaults
          ? null
          : {
              windowWidth: Number(form.windowWidth),
              windowHeight: Number(form.windowHeight),
              launchPreset: form.launchPreset
            },
        browserLaunchMode: form.browserLaunchMode
      };
      const saved = form.id
        ? await window.rionStudio.updateGame(form.id, input)
        : await window.rionStudio.createGame(input);
      setGames((current) => form.id
        ? current.map((game) => game.id === saved.id ? saved : game)
        : [...current, saved]);
      return saved;
    } catch (error) {
      reportError(error);
      return undefined;
    } finally {
      setIsSavingGame(false);
    }
  }

  async function resetBuiltinGame(game: Game): Promise<Game | undefined> {
    const confirmed = await confirm({
      title: t("games.reset.title"),
      description: t("games.reset.description"),
      cancelLabel: t("confirm.cancel"),
      confirmLabel: t("games.reset.action")
    });
    if (!confirmed) return undefined;
    const reportError = beginErrorOperation();
    try {
      const saved = await window.rionStudio.resetBuiltinGame(game.id);
      setGames((current) => current.map((item) => item.id === saved.id ? saved : item));
      return saved;
    } catch (error) {
      reportError(error);
      return undefined;
    }
  }

  async function deleteGame(game: Game): Promise<boolean> {
    const assignedRoles = roles.filter((role) => role.gameId === game.id);
    if (assignedRoles.length > 0) {
      await confirm({
        title: t("games.delete.title").replace("{name}", game.name),
        description: t("games.delete.inUse").replace("{names}", assignedRoles.map((role) => role.name).join(", ")),
        cancelLabel: t("confirm.cancel"),
        confirmLabel: t("confirm.delete"),
        confirmDisabled: true,
        tone: "destructive"
      });
      return false;
    }
    const confirmed = await confirm({
      title: t("games.delete.title").replace("{name}", game.name),
      description: t("games.delete.description"),
      cancelLabel: t("confirm.cancel"),
      confirmLabel: t("confirm.delete"),
      tone: "destructive"
    });
    if (!confirmed) return false;
    const reportError = beginErrorOperation();
    try {
      await window.rionStudio.deleteGame(game.id);
      setGames((current) => current.filter((item) => item.id !== game.id));
      setCompatibilityReports((current) => current.filter((report) => report.gameId !== game.id));
      return true;
    } catch (error) {
      reportError(error);
      return false;
    }
  }

  async function runCompatibilityCheck(gameId: string): Promise<void> {
    const reportError = beginErrorOperation();
    try {
      await window.rionStudio.runGameCompatibilityCheck(gameId, roleDefaults);
    } catch (error) {
      reportError(error);
    }
  }

  async function cancelCompatibilityCheck(gameId: string): Promise<void> {
    const reportError = beginErrorOperation();
    try {
      await window.rionStudio.cancelGameCompatibilityCheck(gameId);
    } catch (error) {
      reportError(error);
    }
  }

  async function applyRecommendation(game: Game): Promise<void> {
    const reportError = beginErrorOperation();
    try {
      const saved = await window.rionStudio.updateGame(game.id, { browserLaunchMode: "external" });
      setGames((current) => current.map((item) => item.id === saved.id ? saved : item));
    } catch (error) {
      reportError(error);
    }
  }

  return {
    applyRecommendation,
    cancelCompatibilityCheck,
    deleteGame,
    isSavingGame,
    resetBuiltinGame,
    runCompatibilityCheck,
    saveGame
  };
}
