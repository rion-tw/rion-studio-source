import { AlertTriangle, LogIn } from "lucide-react";
import type { JSX } from "react";

import { formatAuthFlowState } from "../../app/statusUtils";
import { Surface } from "../../components/ui/patterns";
import type { Translator } from "../../i18n";
import { cn } from "../../lib/utils";
import type { AuthFlowStatus } from "../../../../shared/types";

interface LoginSessionGuideProps {
  authStatus?: AuthFlowStatus;
  className?: string;
  roleName: string;
  t: Translator;
}

export function LoginSessionGuide({
  authStatus,
  className,
  roleName,
  t
}: LoginSessionGuideProps): JSX.Element {
  return (
    <Surface
      className={cn(
        "grid gap-3 border border-amber-500/30 bg-amber-500/[0.07] p-4",
        className
      )}
      role="status"
      aria-live={authStatus ? "polite" : undefined}
      variant="strong"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-amber-500/25 bg-amber-500/10 text-amber-600 dark:text-amber-300">
          <LogIn size={17} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold leading-5 text-foreground">
              {t(authStatus ? "loginGuide.activeTitle" : "loginGuide.title").replace("{name}", roleName)}
            </p>
            {authStatus ? (
              <span className="rounded-full border border-border/40 bg-background/40 px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
                {formatAuthFlowState(authStatus, t)}
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{t("loginGuide.description")}</p>
        </div>
      </div>

      <ol className="grid gap-2 sm:grid-cols-3">
        <GuideStep number={1}>{t("loginGuide.step.account")}</GuideStep>
        <GuideStep number={2}>{t("loginGuide.step.character").replace("{name}", roleName)}</GuideStep>
        <GuideStep number={3}>{t("loginGuide.step.game")}</GuideStep>
      </ol>

      <p className="flex items-start gap-2 rounded-md border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2 text-[11px] font-medium leading-5 text-foreground">
        <AlertTriangle className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-300" size={14} />
        <span>{t("loginGuide.warning")}</span>
      </p>
    </Surface>
  );
}

function GuideStep({ children, number }: { children: string; number: number }): JSX.Element {
  return (
    <li className="flex min-w-0 items-start gap-2 rounded-md border border-border/30 bg-background/25 px-3 py-2 text-[11px] font-medium leading-5 text-foreground">
      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-bold text-primary">
        {number}
      </span>
      <span>{children}</span>
    </li>
  );
}
