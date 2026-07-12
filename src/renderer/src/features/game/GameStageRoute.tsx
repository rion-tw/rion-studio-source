import { Gamepad2, Loader2, Square } from "lucide-react";
import {
  type JSX,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef
} from "react";

import { EmptyState } from "../../components/EmptyState";
import { Button } from "../../components/ui/button";
import type { Translator } from "../../i18n";
import type { GameStageLayout, Role, RoleStatus } from "../../../../shared/types";
import { createGameStageSlotStyle, createGameStageViewBounds } from "./gameStageLayoutUtils";

interface GameStageRouteProps {
  layout: GameStageLayout | null;
  roles: Role[];
  statusByRole: Map<string, RoleStatus>;
  t: Translator;
  onStopLayout: (layout: GameStageLayout) => void;
  onStopRole: (roleId: string) => void;
  onOpenRoles: () => void;
}

export default function GameStageRoute({
  layout,
  roles,
  statusByRole,
  t,
  onOpenRoles,
  onStopLayout,
  onStopRole
}: GameStageRouteProps): JSX.Element {
  const stageRef = useRef<HTMLDivElement>(null);
  const viewportRefs = useRef(new Map<string, HTMLDivElement>());
  const frameRef = useRef<number | null>(null);
  const roleById = useMemo(() => new Map(roles.map((role) => [role.id, role])), [roles]);

  const reportBounds = useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
    }

    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      if (!layout) {
        void window.rionStudio.updateGameStageBounds({ visible: false, views: [] });
        return;
      }

      const views = layout.slots.flatMap((slot) => {
        const element = viewportRefs.current.get(slot.roleId);
        if (!element) {
          return [];
        }

        const rect = element.getBoundingClientRect();
        const bounds = createGameStageViewBounds(slot.roleId, rect);
        return bounds ? [bounds] : [];
      });

      void window.rionStudio.updateGameStageBounds({ visible: true, views });
    });
  }, [layout]);

  useLayoutEffect(() => {
    reportBounds();
  }, [reportBounds]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) {
      return;
    }

    const observer = new ResizeObserver(reportBounds);
    observer.observe(stage);
    window.addEventListener("resize", reportBounds);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", reportBounds);
    };
  }, [reportBounds]);

  useEffect(() => {
    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
      }
      void window.rionStudio.updateGameStageBounds({ visible: false, views: [] });
    };
  }, []);

  if (!layout) {
    return (
      <section className="app-page h-full overflow-auto px-5 py-5 md:px-7 md:py-7">
        <EmptyState
          icon={Gamepad2}
          title={t("game.empty.title")}
          description={t("game.empty.description")}
          actionLabel={t("game.empty.action")}
          onAction={onOpenRoles}
        />
      </section>
    );
  }

  return (
    <section className="flex h-full min-h-0 flex-col p-3 md:p-4">
      <header className="app-no-drag flex min-h-11 shrink-0 items-center gap-3 px-1 pb-3">
        <div className="min-w-0 flex-1">
          <p className="app-page-kicker">{layout.mode === "login" ? t("game.loginKicker") : t("game.kicker")}</p>
          <h1 className="truncate text-lg font-semibold leading-6 text-foreground">{layout.name}</h1>
        </div>
        <Button
          className="shrink-0 gap-1.5"
          type="button"
          variant="destructive"
          size="sm"
          onClick={() => onStopLayout(layout)}
        >
          <Square size={14} />
          {t("game.stopAll")}
        </Button>
      </header>

      <div ref={stageRef} className="relative min-h-0 flex-1 overflow-hidden rounded-md bg-black/80 shadow-inner">
        {layout.slots.map((slot) => {
          const role = roleById.get(slot.roleId);
          const status = statusByRole.get(slot.roleId);

          return (
            <div
              key={slot.roleId}
              className="absolute flex min-h-0 min-w-0 flex-col p-0.5"
              style={createGameStageSlotStyle(slot.rect)}
            >
              <div className="flex h-7 shrink-0 items-center gap-2 border border-b-0 border-white/10 bg-neutral-950 px-2 text-white">
                <span className="min-w-0 flex-1 truncate text-[11px] font-semibold">{role?.name ?? slot.roleId}</span>
                {status?.state === "launching" ? <Loader2 className="spin shrink-0 text-white/70" size={12} /> : null}
                <button
                  className="grid size-5 shrink-0 place-items-center rounded-sm text-white/60 transition-colors hover:bg-white/10 hover:text-white"
                  type="button"
                  title={t("role.stop")}
                  aria-label={t("role.stop")}
                  onClick={() => onStopRole(slot.roleId)}
                >
                  <Square size={11} />
                </button>
              </div>
              <div
                ref={(element) => {
                  if (element) {
                    viewportRefs.current.set(slot.roleId, element);
                  } else {
                    viewportRefs.current.delete(slot.roleId);
                  }
                }}
                className="grid min-h-0 flex-1 place-items-center border border-white/10 bg-neutral-900 text-[11px] text-white/50"
                data-game-viewport={slot.roleId}
              >
                {layout.mode === "login" ? t("game.loginLoading") : t("game.loading")}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
