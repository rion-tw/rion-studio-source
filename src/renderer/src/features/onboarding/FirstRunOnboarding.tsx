import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  Gamepad2,
  Loader2,
  Play,
  Plus,
  Rocket,
  UserRound
} from "lucide-react";
import { type JSX, type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";

import appIconUrl from "../../assets/app-icon.png";
import { getGameCoverUrl, getGameIconUrl, sortGames } from "../../app/gamePresentation";
import type { RoleFormState } from "../../app/types";
import { toMessage } from "../../app/errorUtils";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { StatusCallout, Surface } from "../../components/ui/patterns";
import type { FirstRunOnboardingProgress } from "../../hooks/useFirstRunOnboarding";
import { localizeErrorMessage, type Language, type Translator } from "../../i18n";
import { cn } from "../../lib/utils";
import type { Game, Role, RoleStatus } from "../../../../shared/types";

type OnboardingStep = "game" | "role" | "launch" | "success";

interface FirstRunOnboardingProps {
  error: unknown | null;
  games: Game[];
  isSaving: boolean;
  isSuccessPresented: boolean;
  language: Language;
  notice: string | null;
  progress: FirstRunOnboardingProgress;
  roles: Role[];
  statusByRole: Map<string, RoleStatus>;
  t: Translator;
  onClearError: () => void;
  onComplete: () => void;
  onCustomGame: () => void;
  onDismissSuccess: () => void;
  onLaunch: (roleId: string) => Promise<RoleStatus | undefined>;
  onOpenLater: () => void;
  onSave: (form: RoleFormState) => Promise<Role | undefined>;
  onSkip: () => void;
  onUpdateProgress: (patch: Partial<Pick<FirstRunOnboardingProgress, "gameId" | "roleId">>) => void;
}

export function FirstRunOnboarding({
  error,
  games,
  isSaving,
  isSuccessPresented,
  language,
  notice,
  progress,
  roles,
  statusByRole,
  t,
  onClearError,
  onComplete,
  onCustomGame,
  onDismissSuccess,
  onLaunch,
  onOpenLater,
  onSave,
  onSkip,
  onUpdateProgress
}: FirstRunOnboardingProps): JSX.Element {
  const builtinGames = useMemo(
    () => sortGames(games.filter((game) => game.source === "builtin")),
    [games]
  );
  const resumedRole = progress.roleId
    ? roles.find((role) => role.id === progress.roleId)
    : undefined;
  const resumedGameId = resumedRole?.gameId ?? progress.gameId;
  const validResumedGame = games.find((game) => game.id === resumedGameId);
  const resumedStatus = resumedRole ? statusByRole.get(resumedRole.id) : undefined;
  const [selectedGameId, setSelectedGameId] = useState(validResumedGame?.id ?? "");
  const [createdRole, setCreatedRole] = useState<Role | undefined>(resumedRole);
  const [roleName, setRoleName] = useState(resumedRole?.name ?? "");
  const [step, setStep] = useState<OnboardingStep>(() => {
    if (isSuccessPresented || resumedStatus?.state === "running") return "success";
    if (resumedRole) return "launch";
    return validResumedGame ? "role" : "game";
  });
  const [isLaunching, setIsLaunching] = useState(false);
  const [launchFailed, setLaunchFailed] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const completionRequestedRef = useRef(isSuccessPresented);
  const activeRole = createdRole ?? resumedRole;
  const selectedGame = games.find((game) => game.id === (activeRole?.gameId ?? selectedGameId));
  const activeStatus = activeRole ? statusByRole.get(activeRole.id) : undefined;

  useEffect(() => {
    if (progress.roleId && !resumedRole && !createdRole) {
      onUpdateProgress({ roleId: undefined });
    }
    if (progress.gameId && !games.some((game) => game.id === progress.gameId)) {
      setSelectedGameId("");
      setStep("game");
      onUpdateProgress({ gameId: undefined, roleId: undefined });
    }
  }, [createdRole, games, onUpdateProgress, progress.gameId, progress.roleId, resumedRole]);

  const requestCompletion = useCallback((): void => {
    setIsLaunching(false);
    setLaunchFailed(false);
    setStep("success");
    if (!completionRequestedRef.current) {
      completionRequestedRef.current = true;
      onComplete();
    }
  }, [onComplete]);

  useEffect(() => {
    if (activeStatus?.state === "running") {
      requestCompletion();
    }
  }, [activeStatus?.state, requestCompletion]);

  useEffect(() => {
    const focusTarget = step === "role" ? nameInputRef.current : headingRef.current;
    focusTarget?.focus();
  }, [step]);

  async function launchRole(role: Role): Promise<void> {
    onClearError();
    setLaunchFailed(false);
    setIsLaunching(true);
    setStep("launch");
    const status = await onLaunch(role.id);
    setIsLaunching(false);
    if (status?.state === "running") {
      requestCompletion();
      return;
    }
    if (status?.state !== "launching") {
      setLaunchFailed(true);
    }
  }

  async function createAndLaunch(): Promise<void> {
    if (!selectedGame || !roleName.trim() || isSaving || isLaunching) return;
    onClearError();
    const savedRole = await onSave({
      gameId: selectedGame.id,
      launchUrl: selectedGame.defaultLaunchUrl,
      name: roleName.trim(),
      notes: ""
    });
    if (!savedRole) return;
    setCreatedRole(savedRole);
    onUpdateProgress({ gameId: selectedGame.id, roleId: savedRole.id });
    await launchRole(savedRole);
  }

  const errorMessage = error
    ? toMessage(error, language, t)
    : launchFailed
      ? t("onboarding.launch.error")
      : null;

  return (
    <div className="liquid-app-shell app-drag flex h-screen flex-col overflow-hidden p-5 text-foreground md:p-7">
      <header className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <img className="size-10 rounded-lg shadow-sm" src={appIconUrl} alt="" aria-hidden="true" />
          <div>
            <p className="text-sm font-semibold">Rion Studio</p>
            <p className="text-caption text-muted-foreground">{t("onboarding.header")}</p>
          </div>
        </div>
        <StepIndicator step={step} t={t} />
      </header>

      <main className="app-no-drag mx-auto grid min-h-0 w-full max-w-5xl flex-1 place-items-center py-5">
        <Surface className="app-scroll-region max-h-full w-full max-w-4xl overflow-auto" radius="lg" variant="strong">
          {step === "game" ? (
            <GameStep
              builtinGames={builtinGames}
              headingRef={headingRef}
              selectedGameId={selectedGameId}
              t={t}
              onCustomGame={onCustomGame}
              onNext={() => {
                if (!selectedGameId) return;
                onUpdateProgress({ gameId: selectedGameId, roleId: undefined });
                setStep("role");
              }}
              onSelect={setSelectedGameId}
              onSkip={onSkip}
            />
          ) : step === "role" ? (
            <RoleStep
              game={selectedGame}
              headingRef={headingRef}
              isBusy={isSaving || isLaunching}
              nameInputRef={nameInputRef}
              roleName={roleName}
              t={t}
              onBack={() => setStep("game")}
              onCreate={() => void createAndLaunch()}
              onNameChange={setRoleName}
              onSkip={onSkip}
            />
          ) : (
            <LaunchStep
              errorMessage={errorMessage}
              game={selectedGame}
              headingRef={headingRef}
              isLaunching={isLaunching}
              isSuccess={step === "success"}
              notice={notice ? localizeErrorMessage(notice, language) : null}
              role={activeRole}
              t={t}
              onDismissSuccess={onDismissSuccess}
              onOpenLater={onOpenLater}
              onRetry={() => activeRole ? void launchRole(activeRole) : undefined}
            />
          )}
        </Surface>
      </main>
    </div>
  );
}

function GameStep({
  builtinGames,
  headingRef,
  selectedGameId,
  t,
  onCustomGame,
  onNext,
  onSelect,
  onSkip
}: {
  builtinGames: Game[];
  headingRef: RefObject<HTMLHeadingElement | null>;
  selectedGameId: string;
  t: Translator;
  onCustomGame: () => void;
  onNext: () => void;
  onSelect: (gameId: string) => void;
  onSkip: () => void;
}): JSX.Element {
  return (
    <div className="grid gap-5 p-5 md:p-7">
      <StepHeading description={t("onboarding.game.description")} headingRef={headingRef} kicker={t("onboarding.kicker")} title={t("onboarding.game.title")} />
      {builtinGames.length > 0 ? (
        <div className="grid gap-3 md:grid-cols-2" role="radiogroup" aria-label={t("onboarding.game.groupLabel")}>
          {builtinGames.map((game) => (
            <GameChoiceCard key={game.id} game={game} selected={selectedGameId === game.id} onSelect={() => onSelect(game.id)} />
          ))}
        </div>
      ) : (
        <StatusCallout tone="warning"><AlertTriangle size={15} />{t("onboarding.game.unavailable")}</StatusCallout>
      )}
      <div className="flex flex-col-reverse gap-2 border-t border-border/45 pt-4 sm:flex-row sm:items-center sm:justify-between">
        <Button data-testid="onboarding-skip" type="button" variant="ghost" onClick={onSkip}>{t("onboarding.skip")}</Button>
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          <Button type="button" variant="outline" onClick={onCustomGame}><Plus size={15} />{t("onboarding.game.custom")}</Button>
          <Button type="button" disabled={!selectedGameId} onClick={onNext}>{t("onboarding.next")}<ArrowRight size={15} /></Button>
        </div>
      </div>
    </div>
  );
}

function RoleStep({
  game,
  headingRef,
  isBusy,
  nameInputRef,
  roleName,
  t,
  onBack,
  onCreate,
  onNameChange,
  onSkip
}: {
  game: Game | undefined;
  headingRef: RefObject<HTMLHeadingElement | null>;
  isBusy: boolean;
  nameInputRef: RefObject<HTMLInputElement | null>;
  roleName: string;
  t: Translator;
  onBack: () => void;
  onCreate: () => void;
  onNameChange: (name: string) => void;
  onSkip: () => void;
}): JSX.Element {
  return (
    <form className="grid gap-5 p-5 md:p-7" onSubmit={(event) => { event.preventDefault(); onCreate(); }}>
      <StepHeading description={t("onboarding.role.description")} headingRef={headingRef} kicker={t("onboarding.kicker")} title={t("onboarding.role.title")} />
      {game ? <GameSummary game={game} /> : null}
      <label className="grid gap-2 text-sm font-semibold" htmlFor="onboarding-role-name">
        {t("onboarding.role.name")}
        <Input
          ref={nameInputRef}
          id="onboarding-role-name"
          autoComplete="off"
          disabled={isBusy}
          maxLength={120}
          placeholder={t("onboarding.role.namePlaceholder")}
          required
          value={roleName}
          onChange={(event) => onNameChange(event.target.value)}
        />
      </label>
      <p className="text-xs leading-5 text-muted-foreground">{t("onboarding.role.sessionNote")}</p>
      <div className="flex flex-col-reverse gap-2 border-t border-border/45 pt-4 sm:flex-row sm:items-center sm:justify-between">
        <Button data-testid="onboarding-skip" type="button" variant="ghost" disabled={isBusy} onClick={onSkip}>{t("onboarding.skip")}</Button>
        <div className="flex gap-2">
          <Button type="button" variant="outline" disabled={isBusy} onClick={onBack}><ArrowLeft size={15} />{t("onboarding.back")}</Button>
          <Button type="submit" disabled={isBusy || !roleName.trim() || !game}>
            {isBusy ? <Loader2 className="spin" size={16} /> : <Rocket size={16} />}
            {t("onboarding.role.createAndOpen")}
          </Button>
        </div>
      </div>
    </form>
  );
}

function LaunchStep({
  errorMessage,
  game,
  headingRef,
  isLaunching,
  isSuccess,
  notice,
  role,
  t,
  onDismissSuccess,
  onOpenLater,
  onRetry
}: {
  errorMessage: string | null;
  game: Game | undefined;
  headingRef: RefObject<HTMLHeadingElement | null>;
  isLaunching: boolean;
  isSuccess: boolean;
  notice: string | null;
  role: Role | undefined;
  t: Translator;
  onDismissSuccess: () => void;
  onOpenLater: () => void;
  onRetry: () => void;
}): JSX.Element {
  const title = isSuccess ? t("onboarding.success.title") : isLaunching ? t("onboarding.launch.title") : t("onboarding.launch.retryTitle");
  const description = isSuccess ? t("onboarding.success.description") : isLaunching ? t("onboarding.launch.description") : t("onboarding.launch.retryDescription");
  return (
    <div className="grid gap-5 p-5 md:p-7" aria-live="polite" aria-busy={isLaunching}>
      <div className="grid justify-items-center gap-4 py-2 text-center">
        <div className={cn("grid size-14 place-items-center rounded-full", isSuccess ? "bg-success/15 text-success" : "bg-activity/15 text-activity")}>
          {isSuccess ? <CheckCircle2 size={30} /> : isLaunching ? <Loader2 className="spin" size={28} /> : <AlertTriangle size={28} />}
        </div>
        <StepHeading centered description={description} headingRef={headingRef} kicker={t("onboarding.kicker")} title={title} />
      </div>
      {role && game ? <RoleSummary game={game} role={role} /> : null}
      {errorMessage ? <StatusCallout tone="destructive" role="alert"><AlertTriangle size={15} />{errorMessage}</StatusCallout> : null}
      {notice ? <StatusCallout tone="warning"><AlertTriangle size={15} />{notice}</StatusCallout> : null}
      {!isLaunching ? (
        <div className="flex flex-col-reverse gap-2 border-t border-border/45 pt-4 sm:flex-row sm:justify-end">
          {isSuccess ? (
            <Button type="button" size="lg" onClick={onDismissSuccess}><Check size={16} />{t("onboarding.success.enter")}</Button>
          ) : (
            <>
              <Button type="button" variant="ghost" onClick={onOpenLater}>{t("onboarding.launch.later")}</Button>
              <Button type="button" disabled={!role} onClick={onRetry}><Play size={16} />{t("onboarding.launch.retry")}</Button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function GameChoiceCard({ game, selected, onSelect }: { game: Game; selected: boolean; onSelect: () => void }): JSX.Element {
  const coverUrl = getGameCoverUrl(game);
  const iconUrl = getGameIconUrl(game);
  return (
    <button
      aria-checked={selected}
      className={cn(
        "group overflow-hidden rounded-lg border text-left transition-[border-color,box-shadow,transform] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35",
        selected ? "border-activity/70 shadow-[0_0_0_2px_hsl(var(--activity)/0.12)]" : "border-border/45 hover:border-border"
      )}
      role="radio"
      type="button"
      onClick={onSelect}
    >
      <div className="relative aspect-video overflow-hidden bg-muted">
        {coverUrl ? <img className="size-full object-cover transition-transform group-hover:scale-[1.015]" src={coverUrl} alt="" /> : <Gamepad2 className="absolute inset-0 m-auto text-muted-foreground" size={36} />}
        {selected ? <span className="absolute right-3 top-3 grid size-7 place-items-center rounded-full bg-activity text-activity-foreground"><Check size={16} /></span> : null}
      </div>
      <div className="flex items-center gap-3 p-4">
        <span className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-lg bg-muted">
          {iconUrl ? <img className="size-full object-cover" src={iconUrl} alt="" /> : <Gamepad2 size={20} />}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold">{game.name}</span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">{game.defaultLaunchUrl}</span>
        </span>
      </div>
    </button>
  );
}

function GameSummary({ game }: { game: Game }): JSX.Element {
  const iconUrl = getGameIconUrl(game);
  return (
    <Surface className="flex items-center gap-3 p-4" variant="inset">
      <span className="grid size-11 shrink-0 place-items-center overflow-hidden rounded-lg bg-muted">{iconUrl ? <img className="size-full object-cover" src={iconUrl} alt="" /> : <Gamepad2 size={21} />}</span>
      <span className="min-w-0"><span className="block truncate text-sm font-semibold">{game.name}</span><span className="mt-0.5 block truncate text-xs text-muted-foreground">{game.defaultLaunchUrl}</span></span>
    </Surface>
  );
}

function RoleSummary({ game, role }: { game: Game; role: Role }): JSX.Element {
  return <Surface className="grid gap-3 p-4 sm:grid-cols-2" variant="inset"><span className="flex items-center gap-2 text-sm"><UserRound className="text-muted-foreground" size={17} /><strong>{role.name}</strong></span><span className="flex items-center gap-2 text-sm"><Gamepad2 className="text-muted-foreground" size={17} /><strong>{game.name}</strong></span></Surface>;
}

function StepHeading({ centered = false, description, headingRef, kicker, title }: { centered?: boolean; description: string; headingRef: RefObject<HTMLHeadingElement | null>; kicker: string; title: string }): JSX.Element {
  return <div className={cn("min-w-0", centered && "max-w-xl")}><p className="text-caption font-semibold uppercase tracking-[0.18em] text-muted-foreground">{kicker}</p><h1 ref={headingRef} className="mt-2 text-page-title font-semibold tracking-tight outline-none" tabIndex={-1}>{title}</h1><p className="mt-2 text-body text-muted-foreground">{description}</p></div>;
}

function StepIndicator({ step, t }: { step: OnboardingStep; t: Translator }): JSX.Element {
  const activeIndex = step === "game" ? 0 : step === "role" ? 1 : 2;
  const labels = [t("onboarding.step.game"), t("onboarding.step.role"), t("onboarding.step.open")];
  return <ol className="hidden items-center gap-2 sm:flex" aria-label={t("onboarding.progress")}>
    {labels.map((label, index) => <li key={label} className={cn("flex items-center gap-2 text-xs font-semibold", index <= activeIndex ? "text-foreground" : "text-muted-foreground")}><span className={cn("grid size-6 place-items-center rounded-full border", index < activeIndex ? "border-success/40 bg-success/15 text-success" : index === activeIndex ? "border-activity/45 bg-activity/15 text-activity" : "border-border/55")}>{index < activeIndex ? <Check size={13} /> : index + 1}</span><span className="hidden lg:inline">{label}</span>{index < labels.length - 1 ? <span className="h-px w-5 bg-border/60" /> : null}</li>)}
  </ol>;
}
