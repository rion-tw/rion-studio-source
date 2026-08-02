import { useRef, useState, type Dispatch, type SetStateAction } from "react";

import { formatBulkDeleteResult } from "../app/bulkDelete";
import type { GameFormState } from "../app/types";
import { useConfirmation } from "../components/confirmation";
import type { Translator } from "../i18n";
import type { Game, Role } from "../../../shared/types";

interface UseGameWorkflowOptions {
  beginErrorOperation: () => (error: unknown) => void;
  setGames: Dispatch<SetStateAction<Game[]>>;
  roles: Role[];
  setNotice?: (message: string | null) => void;
  t: Translator;
}

export function useGameWorkflow({
  beginErrorOperation,
  setGames,
  roles,
  setNotice,
  t
}: UseGameWorkflowOptions) {
  const confirm = useConfirmation();
  const [isSavingGame, setIsSavingGame] = useState(false);
  const [isDeletingGames, setIsDeletingGames] = useState(false);
  const isDeletingGamesRef = useRef(false);

  async function saveGame(form: GameFormState): Promise<Game | undefined> {
    const reportError = beginErrorOperation();
    setIsSavingGame(true);
    try {
      const input = {
        name: form.name,
        iconImageDataUrl: form.source === "custom" ? form.iconImageDataUrl ?? null : undefined,
        coverImageDataUrl: form.source === "custom" ? form.coverImageDataUrl ?? null : undefined,
        defaultLaunchUrl: form.defaultLaunchUrl
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

  async function deleteGames(games: Game[]): Promise<boolean> {
    if (isDeletingGamesRef.current || games.length === 0) {
      return false;
    }

    const assignedRoleNamesByGameId = new Map<string, string[]>();
    roles.forEach((role) => {
      const names = assignedRoleNamesByGameId.get(role.gameId) ?? [];
      names.push(role.name);
      assignedRoleNamesByGameId.set(role.gameId, names);
    });
    const protectedCount = games.filter((game) => game.source === "builtin").length;
    const inUseGames = games.filter(
      (game) => game.source === "custom" && (assignedRoleNamesByGameId.get(game.id)?.length ?? 0) > 0
    );
    const skippedCount = protectedCount + inUseGames.length;
    const deletableCount = games.length - skippedCount;
    const isSingle = games.length === 1;
    const singleAssignedNames = assignedRoleNamesByGameId.get(games[0]?.id ?? "") ?? [];
    const description = isSingle && protectedCount === 0 && inUseGames.length === 0
      ? t("games.delete.description")
      : isSingle && singleAssignedNames.length > 0
        ? t("games.delete.inUse").replace("{names}", singleAssignedNames.join(", "))
        : t("bulkDelete.games.description")
            .replace("{deletable}", String(deletableCount))
            .replace("{skipped}", String(skippedCount))
            .replace("{protected}", String(protectedCount))
            .replace("{inUse}", String(inUseGames.length));
    const confirmed = await confirm({
      title: isSingle
        ? t("games.delete.title").replace("{name}", games[0].name)
        : t("bulkDelete.games.title").replace("{count}", String(games.length)),
      description,
      cancelLabel: t("confirm.cancel"),
      confirmLabel: t("confirm.delete"),
      confirmDisabled: deletableCount === 0,
      tone: "destructive"
    });
    if (!confirmed) return false;

    isDeletingGamesRef.current = true;
    setIsDeletingGames(true);
    const reportError = beginErrorOperation();
    setNotice?.(null);
    try {
      const result = await window.rionStudio.deleteGames({ ids: games.map((game) => game.id) });
      const nextGames = await window.rionStudio.listGames();
      setGames(nextGames);
      setNotice?.(formatBulkDeleteResult(result, t));
      return true;
    } catch (error) {
      reportError(error);
      return false;
    } finally {
      isDeletingGamesRef.current = false;
      setIsDeletingGames(false);
    }
  }

  async function deleteGame(game: Game): Promise<boolean> {
    return deleteGames([game]);
  }

  return {
    deleteGame,
    deleteGames,
    isDeletingGames,
    isSavingGame,
    resetBuiltinGame,
    saveGame
  };
}
