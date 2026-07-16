import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  Keyboard,
  ListChecks,
  Plus,
  Repeat,
  Save,
  Trash2,
  X
} from "lucide-react";
import { type FormEvent, type JSX, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";

import { EditorNotFound, EditorPage } from "../../components/EditorPage";
import { DEFAULT_ROLE_COVER_COLOR, roleCoverPlaceholderUrl } from "../../app/roleCoverPlaceholder";
import { Button } from "../../components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Switch } from "../../components/ui/switch";
import {
  FormField,
  SegmentedControl,
  Surface
} from "../../components/ui/patterns";
import { areEditorFormsEqual, createMacroFormState, createNewMacroForm } from "../../app/editorFormState";
import { readRequestedMacroRoleId } from "../../app/editorNavigation";
import type { MacroFormState } from "../../app/types";
import { useUnsavedChangesGuard } from "../../hooks/useUnsavedChangesGuard";
import type { Translator } from "../../i18n";
import { cn } from "../../lib/utils";
import {
  areMacroTriggersEqual,
  macroRoleAssignmentsOverlap,
  MACRO_OVERLAY_TRIGGER
} from "../../../../shared/macroShortcuts";
import type { Game, Macro, MacroRepeat, MacroStep, MacroTrigger, Role } from "../../../../shared/types";
import {
  commonMacroKeyCodes,
  createClientId,
  formatMacroCode,
  formatMacroIntervalPreset,
  formatMacroShortcut,
  isMacroIntervalPreset,
  isValidMacroInterval,
  MACRO_INTERVAL_CUSTOM_VALUE,
  MACRO_INTERVAL_OPTIONS,
  isPureModifierCode
} from "./macroUtils";

interface MacroEditorRouteProps {
  games: Game[];
  isSaving: boolean;
  macros: Macro[];
  roles: Role[];
  t: Translator;
  onSave: (form: MacroFormState) => Promise<Macro | undefined>;
}

function MacroEditorRoute(props: MacroEditorRouteProps): JSX.Element {
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const selectedMacro = id ? props.macros.find((macro) => macro.id === id) : undefined;

  if (id && !selectedMacro) {
    return (
      <EditorNotFound
        title={props.t("editor.notFound.title")}
        description={props.t("editor.notFound.macro")}
        actionLabel={props.t("editor.back.macros")}
        onAction={() => navigate("/macros", { replace: true })}
      />
    );
  }

  const requestedRoleId = readRequestedMacroRoleId(location.search);
  const initialForm = selectedMacro
    ? createMacroFormState(selectedMacro)
    : createNewMacroForm(props.macros, props.roles, props.t, requestedRoleId);
  return <MacroEditor key={id ?? `new:${requestedRoleId ?? ""}`} {...props} initialForm={initialForm} />;
}

function MacroEditor({
  initialForm,
  games,
  isSaving,
  macros,
  roles,
  t,
  onSave
}: MacroEditorRouteProps & { initialForm: MacroFormState }): JSX.Element {
  const navigate = useNavigate();
  const initialFormRef = useRef(initialForm);
  const [form, setForm] = useState(initialForm);
  const isDirty = !areEditorFormsEqual(initialFormRef.current, form);
  const shortcutConflict = useMemo(() => {
    if (!form.trigger) {
      return undefined;
    }
    if (areMacroTriggersEqual(form.trigger, MACRO_OVERLAY_TRIGGER)) {
      return t("macroForm.shortcutReserved");
    }

    const conflictingMacro = macros.find(
      (macro) =>
        macro.id !== form.id &&
        areMacroTriggersEqual(macro.trigger, form.trigger) &&
        macroRoleAssignmentsOverlap(macro.roleIds, form.roleIds)
    );
    return conflictingMacro
      ? t("macroForm.shortcutConflict").replace("{name}", conflictingMacro.name)
      : undefined;
  }, [form.id, form.roleIds, form.trigger, macros, t]);
  const canSubmit =
    form.name.trim().length > 0 &&
    form.roleIds.length > 0 &&
    form.steps.length > 0 &&
    (form.repeat.type === "once" || isValidMacroInterval(form.repeat.intervalMs)) &&
    !shortcutConflict;
  const saveHint = shortcutConflict ?? (
    form.roleIds.length === 0
      ? t("macroForm.saveHint.needsRole")
      : form.steps.length === 0
        ? t("macroForm.saveHint.needsStep")
        : form.repeat.type === "loop" && !isValidMacroInterval(form.repeat.intervalMs)
          ? t("macroForm.saveHint.invalidInterval")
        : t("macroForm.saveHint.ready")
  );
  const confirmationOptions = useMemo(() => ({
    title: t("confirm.unsaved.title"),
    description: t("confirm.unsaved.description"),
    cancelLabel: t("confirm.unsaved.continue"),
    confirmLabel: t("confirm.unsaved.discard"),
    tone: "destructive" as const
  }), [t]);
  const allowNavigation = useUnsavedChangesGuard(isDirty, confirmationOptions, isSaving);

  function handleCancel(): void {
    navigate("/macros", { replace: true });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const savedMacro = await onSave(form);
    if (savedMacro) {
      allowNavigation();
      navigate("/macros", { replace: true });
    }
  }

  return (
    <EditorPage
      backActionLabel={t("editor.back")}
      backLabel={t("editor.back.macros")}
      canSubmit={canSubmit}
      description={form.id ? t("macroForm.description.edit") : t("macroForm.description.new")}
      isSaving={isSaving}
      onCancel={handleCancel}
      onSubmit={(event) => void handleSubmit(event)}
      onTitleChange={(name) => setForm((current) => ({ ...current, name }))}
      saveHint={saveHint}
      saveIcon={form.id ? <Save size={16} /> : <Check size={16} />}
      saveLabel={form.id ? t("macroForm.saveChanges") : t("macroForm.createMacro")}
      title={form.name}
      titleAriaLabel={t("macroForm.name")}
      titlePlaceholder={t("macroForm.namePlaceholder")}
      contentClassName="min-[1180px]:grid-cols-[320px_minmax(0,1fr)] min-[1180px]:items-start xl:grid-cols-[340px_minmax(0,1fr)]"
    >
      <MacroForm
        form={form}
        games={games}
        isSaving={isSaving}
        roles={roles}
        shortcutConflict={shortcutConflict}
        t={t}
        onChange={setForm}
      />
    </EditorPage>
  );
}

interface MacroFormProps {
  form: MacroFormState;
  games: Game[];
  isSaving: boolean;
  onChange: (form: MacroFormState | ((current: MacroFormState) => MacroFormState)) => void;
  roles: Role[];
  shortcutConflict?: string;
  t: Translator;
}

function MacroForm({ form, games, isSaving, onChange, roles, shortcutConflict, t }: MacroFormProps): JSX.Element {
  const [newStepType, setNewStepType] = useState<MacroStep["type"]>("key");
  const gameNameById = useMemo(() => new Map(games.map((game) => [game.id, game.name])), [games]);
  const roleIds = useMemo(() => new Set(form.roleIds), [form.roleIds]);
  const missingRoleIds = useMemo(
    () => form.roleIds.filter((roleId) => !roles.some((role) => role.id === roleId)),
    [form.roleIds, roles]
  );

  function update(updater: (current: MacroFormState) => MacroFormState): void {
    onChange(updater);
  }

  function toggleRoleId(roleId: string): void {
    update((current) => {
      const currentRoleIds = new Set(current.roleIds);
      if (currentRoleIds.has(roleId)) {
        currentRoleIds.delete(roleId);
      } else {
        currentRoleIds.add(roleId);
      }

      return { ...current, roleIds: [...currentRoleIds] };
    });
  }

  function updateRepeat(repeat: MacroRepeat): void {
    update((current) => ({ ...current, repeat }));
  }

  function addStep(type: MacroStep["type"]): void {
    const step = createStep(type);
    update((current) => ({ ...current, steps: [...current.steps, step] }));
  }

  function updateStep(stepId: string, nextStep: MacroStep): void {
    update((current) => ({
      ...current,
      steps: current.steps.map((step) => (step.id === stepId ? nextStep : step))
    }));
  }

  function moveStep(stepId: string, direction: -1 | 1): void {
    update((current) => {
      const index = current.steps.findIndex((step) => step.id === stepId);
      const nextIndex = index + direction;

      if (index === -1 || nextIndex < 0 || nextIndex >= current.steps.length) {
        return current;
      }

      const steps = [...current.steps];
      const [step] = steps.splice(index, 1);
      steps.splice(nextIndex, 0, step);
      return { ...current, steps };
    });
  }

  function removeStep(stepId: string): void {
    update((current) => ({ ...current, steps: current.steps.filter((step) => step.id !== stepId) }));
  }

  return (
    <>
          <aside className="grid content-start gap-4">
            <Surface className="p-4" padding="none" variant="inset">
              <FormField label={t("macroForm.shortcut")} description={t("macroForm.shortcutDescription")}>
                <ShortcutRecorder
                  trigger={form.trigger}
                  t={t}
                  onChange={(trigger) => update((current) => ({ ...current, trigger }))}
                />
                {shortcutConflict ? (
                  <p className="mt-2 text-[11px] font-semibold leading-4 text-destructive">
                    {shortcutConflict}
                  </p>
                ) : null}
              </FormField>
            </Surface>

            <Surface className="p-4" padding="none" variant="inset">
              <FormField label={t("macroForm.repeat")} description={t("macroForm.repeatDescription")}>
                <div className="grid gap-2">
                  <SegmentedControl<MacroRepeat["type"]>
                    className={cn(
                      "w-full grid-cols-2 p-0.5 [&>button]:h-6",
                      isSaving && "pointer-events-none opacity-45"
                    )}
                    aria-disabled={isSaving}
                    items={[
                      { value: "once", label: t("macros.repeat.once"), icon: Check },
                      { value: "loop", label: t("macroForm.repeat.loop"), icon: Repeat }
                    ]}
                    value={form.repeat.type}
                    onValueChange={(repeatType) => {
                      if (isSaving) {
                        return;
                      }

                      updateRepeat(
                        repeatType === "loop"
                          ? {
                              type: "loop",
                              intervalMs: form.repeat.type === "loop" ? form.repeat.intervalMs : 1000
                            }
                          : { type: "once" }
                      );
                    }}
                  />
                  {form.repeat.type === "loop" ? (
                    <MacroIntervalControl
                      disabled={isSaving}
                      t={t}
                      value={form.repeat.intervalMs}
                      onChange={(intervalMs) => updateRepeat({ type: "loop", intervalMs })}
                    />
                  ) : null}
                </div>
              </FormField>
            </Surface>

            <Surface className="p-4" padding="none" variant="inset">
              <FormField
                className="flex-row items-center gap-4"
                label={t("macroForm.enabled")}
                description={t("macroForm.enabledDescription")}
              >
                <Switch
                  aria-label={t("macroForm.enabled")}
                  checked={form.enabled}
                  disabled={isSaving}
                  title={t(form.enabled ? "macros.disable" : "macros.enable")}
                  onCheckedChange={(enabled) => update((current) => ({ ...current, enabled }))}
                />
              </FormField>
            </Surface>

            {form.repeat.type === "loop" ? (
              <Surface
                className="flex items-start gap-2 border border-amber-500/25 bg-amber-500/[0.06] p-4"
                variant="inset"
              >
                <AlertTriangle className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-300" size={15} />
                <p className="text-[11px] font-medium leading-5 text-foreground">
                  {t("macroForm.fairUseNotice")}
                </p>
              </Surface>
            ) : null}
          </aside>

          <div className="grid content-start gap-4">
            <Surface className="p-4" padding="none" variant="inset">
              <FormField
                label={t("macroForm.roles")}
                description={t("macroForm.rolesDescription")}
              >
                {roles.length > 0 ? (
                  <div
                    id="macro-role"
                    className="flex max-h-52 flex-wrap gap-2 overflow-auto p-0.5"
                  >
                    {missingRoleIds.map((roleId) => (
                      <div
                        key={roleId}
                        className="glass-control inline-flex min-h-12 w-auto max-w-full flex-none items-center gap-2 rounded-lg p-2 text-xs font-medium text-muted-foreground"
                      >
                        <Check size={13} />
                        <span className="min-w-0 truncate">{t("macros.unknownRole")}</span>
                      </div>
                    ))}
                    {roles.map((role) => {
                      const isSelected = roleIds.has(role.id);
                      const gameName = gameNameById.get(role.gameId) ?? role.launchUrl;

                      return (
                        <button
                          key={role.id}
                          aria-pressed={isSelected}
                          className={cn(
                            "glass-control inline-flex min-h-12 w-auto max-w-full flex-none items-center gap-2 rounded-lg p-2 text-left transition-[background-color,border-color,color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/25 disabled:cursor-not-allowed disabled:opacity-60",
                            isSelected
                              ? "macro-role-card-selected text-foreground"
                              : "text-muted-foreground hover:text-foreground"
                          )}
                          disabled={isSaving}
                          type="button"
                          onClick={() => toggleRoleId(role.id)}
                        >
                          <span
                            className="size-8 shrink-0 rounded-sm bg-cover bg-center ring-1 ring-inset ring-border/60"
                            style={{
                              backgroundColor: role.coverImageDominantColor ?? DEFAULT_ROLE_COVER_COLOR,
                              backgroundImage: `url("${role.coverImageDataUrl ?? roleCoverPlaceholderUrl}")`
                            }}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-xs font-semibold">{role.name}</span>
                            <span className="mt-0.5 block truncate text-[10px] font-medium text-muted-foreground">
                              {gameName}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className="glass-control flex h-[30px] items-center rounded-md px-2.5 text-xs text-muted-foreground">
                    {t("macroForm.noRoles")}
                  </div>
                )}
              </FormField>
            </Surface>

            <Surface className="grid min-h-[360px] content-start gap-3 p-4" padding="none" variant="inset">
              <FormField label={t("macroForm.steps")} description={t("macroForm.stepsDescription")}>
                <div className="grid gap-3">
                  {form.steps.length === 0 ? (
                    <div className="glass-control grid min-h-44 place-items-center rounded-md border border-dashed border-border/60 p-6 text-center">
                      <div className="grid max-w-xs gap-2 text-muted-foreground">
                        <ListChecks className="mx-auto" size={24} />
                        <p className="text-xs font-semibold leading-5">{t("macroForm.stepsEmpty")}</p>
                        <p className="text-[11px] font-medium leading-5">{t("macroForm.stepsEmptyHint")}</p>
                      </div>
                    </div>
                  ) : (
                    <div className="glass-control grid overflow-hidden rounded-md [&>*:last-child]:border-b-0">
                      {form.steps.map((step, index) => (
                        <MacroStepEditor
                          key={step.id}
                          index={index}
                          isFirst={index === 0}
                          isLast={index === form.steps.length - 1}
                          isSaving={isSaving}
                          step={step}
                          t={t}
                          onMoveDown={() => moveStep(step.id, 1)}
                          onMoveUp={() => moveStep(step.id, -1)}
                          onRemove={() => removeStep(step.id)}
                          onUpdate={(nextStep) => updateStep(step.id, nextStep)}
                        />
                      ))}
                    </div>
                  )}

                  <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border/50 pt-3">
                    <InlineControl label={t("macroForm.stepType")} controlClassName="w-28 flex-none">
                      <Select
                        value={newStepType}
                        onValueChange={(value) => setNewStepType(value as MacroStep["type"])}
                        disabled={isSaving}
                      >
                        <SelectTrigger aria-label={t("macroForm.stepType")}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {macroStepTypeOrder.map((type) => (
                            <SelectItem key={type} value={type}>
                              {getMacroStepTypeLabel(type, t)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </InlineControl>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => addStep(newStepType)}
                      disabled={isSaving}
                    >
                      <Plus size={14} />
                      {t("macroForm.addStep")}
                    </Button>
                  </div>
                </div>
              </FormField>
            </Surface>
          </div>
    </>
  );
}

interface InlineControlProps {
  children: ReactNode;
  className?: string;
  controlClassName?: string;
  label: string;
  suffix?: string;
}

function InlineControl({ children, className, controlClassName, label, suffix }: InlineControlProps): JSX.Element {
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-2 text-[12px] font-semibold leading-none text-foreground",
        className
      )}
    >
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className={cn("min-w-0 flex-1", controlClassName)}>{children}</span>
      {suffix ? <span className="shrink-0 text-muted-foreground">{suffix}</span> : null}
    </div>
  );
}

interface AffixedInputProps {
  "aria-label": string;
  disabled: boolean;
  max: number;
  min: number;
  onChange: (value: number) => void;
  prefix?: string;
  suffix?: string;
  step?: number;
  value: number;
  widthClassName: string;
}

function AffixedInput({
  "aria-label": ariaLabel,
  disabled,
  max,
  min,
  onChange,
  prefix,
  suffix,
  step,
  value,
  widthClassName
}: AffixedInputProps): JSX.Element {
  return (
    <label
      className={cn(
        "glass-control flex h-[30px] min-w-0 items-center overflow-hidden rounded-md focus-within:border-ring/30 focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring/20",
        widthClassName
      )}
    >
      {prefix ? (
        <span className="pointer-events-none shrink-0 pl-2.5 text-[11px] font-semibold text-muted-foreground">
          {prefix}
        </span>
      ) : null}
      <input
        aria-label={ariaLabel}
        className="h-full min-w-0 flex-1 bg-transparent px-2 text-[13px] font-semibold leading-none text-foreground focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-45"
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        disabled={disabled}
      />
      {suffix ? (
        <span className="pointer-events-none shrink-0 pr-2.5 text-[11px] font-semibold text-muted-foreground">
          {suffix}
        </span>
      ) : null}
    </label>
  );
}

function MacroIntervalControl({
  disabled,
  onChange,
  t,
  value
}: {
  disabled: boolean;
  onChange: (value: number) => void;
  t: Translator;
  value: number;
}): JSX.Element {
  const [isCustom, setIsCustom] = useState(() => !isMacroIntervalPreset(value));
  const showCustomInput = isCustom || !isMacroIntervalPreset(value);

  return (
    <div className="grid gap-2">
      <Select
        disabled={disabled}
        value={showCustomInput ? MACRO_INTERVAL_CUSTOM_VALUE : String(value)}
        onValueChange={(nextValue) => {
          if (nextValue === MACRO_INTERVAL_CUSTOM_VALUE) {
            setIsCustom(true);
            return;
          }

          setIsCustom(false);
          onChange(Number(nextValue));
        }}
      >
        <SelectTrigger aria-label={t("macroForm.intervalMs")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {MACRO_INTERVAL_OPTIONS.map((option) => (
            <SelectItem key={option} value={String(option)}>
              {option === MACRO_INTERVAL_CUSTOM_VALUE
                ? t("macroForm.intervalCustom")
                : formatMacroIntervalPreset(option, t)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {showCustomInput ? (
        <AffixedInput
          aria-label={t("macroForm.intervalCustomValue")}
          disabled={disabled}
          max={600000}
          min={1}
          step={1}
          prefix={t("macroForm.intervalMs")}
          suffix="ms"
          value={value}
          widthClassName="h-[30px] w-full"
          onChange={onChange}
        />
      ) : null}
    </div>
  );
}

interface ShortcutRecorderProps {
  onChange: (trigger: MacroTrigger | undefined) => void;
  t: Translator;
  trigger: MacroTrigger | undefined;
}

function ShortcutRecorder({ onChange, t, trigger }: ShortcutRecorderProps): JSX.Element {
  const [isRecording, setIsRecording] = useState(false);

  useEffect(() => {
    if (!isRecording) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent): void {
      event.preventDefault();
      event.stopPropagation();

      if (isPureModifierCode(event.code)) {
        return;
      }

      onChange({
        code: event.code,
        ctrl: event.ctrlKey,
        alt: event.altKey,
        shift: event.shiftKey,
        meta: event.metaKey
      });
      setIsRecording(false);
    }

    window.addEventListener("keydown", handleKeyDown, true);

    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [isRecording, onChange]);

  return (
    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
      <Button
        className={cn("w-full min-w-0 justify-start px-2.5", isRecording && "glass-focus")}
        type="button"
        variant="outline"
        onClick={() => setIsRecording(true)}
      >
        <Keyboard size={15} />
        <span className="min-w-0 truncate text-left">
          {isRecording ? t("macroForm.shortcutRecording") : formatMacroShortcut(trigger, t)}
        </span>
      </Button>
      <Button type="button" variant="ghost" onClick={() => onChange(undefined)} disabled={!trigger}>
        <X size={14} />
        {t("macroForm.clearShortcut")}
      </Button>
    </div>
  );
}

interface MacroStepEditorProps {
  index: number;
  isFirst: boolean;
  isLast: boolean;
  isSaving: boolean;
  onMoveDown: () => void;
  onMoveUp: () => void;
  onRemove: () => void;
  onUpdate: (step: MacroStep) => void;
  step: MacroStep;
  t: Translator;
}

function MacroStepEditor({
  index,
  isFirst,
  isLast,
  isSaving,
  onMoveDown,
  onMoveUp,
  onRemove,
  onUpdate,
  step,
  t
}: MacroStepEditorProps): JSX.Element {
  return (
    <div className="glass-divider grid gap-2 border-b p-2.5 md:grid-cols-[auto_128px_minmax(0,1fr)_auto] md:items-center">
      <span className="grid size-7 shrink-0 place-items-center rounded-md bg-background/35 text-[11px] font-bold text-muted-foreground">
        {index + 1}
      </span>

      <Select
        value={step.type}
        onValueChange={(value) => onUpdate(createStep(value as MacroStep["type"], step.id))}
        disabled={isSaving}
      >
        <SelectTrigger aria-label={t("macroForm.stepType")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {macroStepTypeOrder.map((type) => (
            <SelectItem key={type} value={type}>
              {getMacroStepTypeLabel(type, t)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <MacroStepFields step={step} t={t} onUpdate={onUpdate} isSaving={isSaving} />

      <div className="flex justify-end gap-1">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          title={t("macroForm.moveUp")}
          onClick={onMoveUp}
          disabled={isSaving || isFirst}
        >
          <ChevronUp size={14} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          title={t("macroForm.moveDown")}
          onClick={onMoveDown}
          disabled={isSaving || isLast}
        >
          <ChevronDown size={14} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          title={t("macroForm.removeStep")}
          onClick={onRemove}
          disabled={isSaving}
        >
          <Trash2 size={14} />
        </Button>
      </div>
    </div>
  );
}

const macroStepTypeOrder: Array<MacroStep["type"]> = ["key", "click", "delay"];

function getMacroStepTypeLabel(type: MacroStep["type"], t: Translator): string {
  return t(type === "key" ? "macro.step.key" : type === "click" ? "macro.step.click" : "macro.step.delay");
}

function MacroStepFields({
  isSaving,
  onUpdate,
  step,
  t
}: {
  isSaving: boolean;
  onUpdate: (step: MacroStep) => void;
  step: MacroStep;
  t: Translator;
}): JSX.Element {
  if (step.type === "key") {
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-2 md:flex-nowrap">
        <Select
          value={step.code}
          onValueChange={(value) =>
            onUpdate({
              ...step,
              code: value,
              label: formatMacroCode(value)
            })
          }
          disabled={isSaving}
        >
          <SelectTrigger className="w-28 flex-none" aria-label={t("macro.step.key")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {commonMacroKeyCodes.map((code) => (
              <SelectItem key={code} value={code}>
                {formatMacroCode(code)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <KeyRecorder
          disabled={isSaving}
          t={t}
          onRecord={(code) => onUpdate({ ...step, code, label: formatMacroCode(code) })}
        />
      </div>
    );
  }

  if (step.type === "click") {
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-2 md:flex-nowrap">
        <AffixedInput
          aria-label={t("macroForm.clickX")}
          disabled={isSaving}
          max={100}
          min={0}
          prefix={t("macroForm.clickX")}
          suffix="%"
          value={step.xPercent}
          widthClassName="w-24 flex-none"
          onChange={(xPercent) => onUpdate({ ...step, xPercent })}
        />
        <AffixedInput
          aria-label={t("macroForm.clickY")}
          disabled={isSaving}
          max={100}
          min={0}
          prefix={t("macroForm.clickY")}
          suffix="%"
          value={step.yPercent}
          widthClassName="w-24 flex-none"
          onChange={(yPercent) => onUpdate({ ...step, yPercent })}
        />
      </div>
    );
  }

  return (
    <AffixedInput
      aria-label={t("macroForm.delayMs")}
      disabled={isSaving}
      max={600000}
      min={0}
      suffix="ms"
      value={step.ms}
      widthClassName="w-32 flex-none"
      onChange={(ms) => onUpdate({ ...step, ms })}
    />
  );
}

function KeyRecorder({
  disabled,
  onRecord,
  t
}: {
  disabled: boolean;
  onRecord: (code: string) => void;
  t: Translator;
}): JSX.Element {
  const [isRecording, setIsRecording] = useState(false);

  useEffect(() => {
    if (!isRecording) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent): void {
      event.preventDefault();
      event.stopPropagation();

      if (isPureModifierCode(event.code)) {
        return;
      }

      onRecord(event.code);
      setIsRecording(false);
    }

    window.addEventListener("keydown", handleKeyDown, true);

    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [isRecording, onRecord]);

  return (
    <Button
      className={cn("w-auto min-w-[88px] shrink-0 px-2.5", isRecording && "glass-focus")}
      type="button"
      variant="outline"
      onClick={() => setIsRecording(true)}
      disabled={disabled}
    >
      <Keyboard size={14} />
      {isRecording ? t("macroForm.recording") : t("macroForm.recordKey")}
    </Button>
  );
}

function createStep(type: MacroStep["type"], id = createClientId()): MacroStep {
  switch (type) {
    case "key":
      return {
        id,
        type: "key",
        code: "Tab",
        label: "Tab"
      };
    case "click":
      return {
        id,
        type: "click",
        xPercent: 50,
        yPercent: 50
      };
    case "delay":
      return {
        id,
        type: "delay",
        ms: 1000
      };
  }
}

export default MacroEditorRoute;
