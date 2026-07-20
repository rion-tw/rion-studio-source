import {
  AlertTriangle,
  Check,
  Copy,
  CircleDot,
  Keyboard,
  ListChecks,
  Plus,
  Repeat,
  Save,
  GripVertical,
  Square,
  Trash2,
  X
} from "lucide-react";
import {
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type JSX,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { useLocation, useNavigate, useParams } from "react-router";

import { EditorNotFound, EditorPage } from "../../components/EditorPage";
import { DEFAULT_ROLE_COVER_COLOR, roleCoverPlaceholderUrl } from "../../app/roleCoverPlaceholder";
import { moveItemById } from "../../app/reorderItems";
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
  isReservedBrowserZoomMacroTrigger,
  macroRoleAssignmentsOverlap,
  MACRO_OVERLAY_TRIGGER
} from "../../../../shared/macroShortcuts";
import { DEFAULT_MACRO_SETTINGS, MACRO_DELAY_MAX_MS } from "../../../../shared/macroSettings";
import { canonicalizeMacroKeyModifiers } from "../../../../shared/macroKeys";
import {
  convertMacroCoordinateToOffset,
  DEFAULT_MACRO_CLICK_ANCHOR,
  MACRO_CLICK_ANCHORS,
  parseMacroCoordinateClipboard
} from "../../../../shared/macroCoordinates";
import type { Game, Macro, MacroActivationMode, MacroCallMode, MacroClickAnchor, MacroClickUnit, MacroKeyAction, MacroKeyModifier, MacroRepeat, MacroSettings, MacroStep, MacroTrigger, Role } from "../../../../shared/types";
import {
  commonMacroKeyCodes,
  createClientId,
  formatMacroCode,
  formatMacroKeyCombination,
  formatMacroIntervalPreset,
  formatMacroModifierLabel,
  getMacroTargetOptions,
  isCallableMacroTarget,
  isMacroIntervalPreset,
  isValidMacroInterval,
  type MacroTargetOption,
  MACRO_INTERVAL_CUSTOM_VALUE,
  MACRO_INTERVAL_OPTIONS,
  isPureModifierCode
} from "./macroUtils";

const MACRO_STEP_DRAG_MIME = "application/x-rion-macro-step";

interface MacroEditorRouteProps {
  games: Game[];
  isSaving: boolean;
  macroSettings?: MacroSettings;
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
  macroSettings = DEFAULT_MACRO_SETTINGS,
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
    if (isReservedBrowserZoomMacroTrigger(form.trigger)) {
      return t("macroForm.shortcutBrowserZoomReserved");
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
  const macroStepError = useMemo(() => {
    const isReferenced = form.id && macros.some((macro) =>
      macro.id !== form.id &&
      macro.steps.some((step) => step.type === "macro" && step.macroId === form.id)
    );
    if (
      isReferenced &&
      form.steps.some((step) => step.type === "key" && step.action === "hold_until_stop")
    ) {
      return t("macroForm.saveHint.referencedHold");
    }

    const invalidStep = form.steps.find((step) => {
      if (step.type !== "macro") return false;
      return !isCallableMacroTarget(macros, form.id, step.macroId);
    });
    return invalidStep ? t("macroForm.saveHint.invalidMacroTarget") : undefined;
  }, [form.id, form.steps, macros, t]);
  const activationError = form.activationMode === "while_held" && !form.trigger
    ? t("macroForm.saveHint.holdNeedsShortcut")
    : undefined;
  const canSubmit =
    form.name.trim().length > 0 &&
    (form.roleIds.length > 0 || Boolean(form.id)) &&
    form.steps.length > 0 &&
    (form.repeat.type === "once" || isValidMacroInterval(form.repeat.intervalMs)) &&
    !activationError &&
    !macroStepError &&
    !shortcutConflict;
  const saveHint = shortcutConflict ?? activationError ?? macroStepError ?? (
    form.roleIds.length === 0
      ? t(form.id ? "macroForm.saveHint.unassigned" : "macroForm.saveHint.needsRole")
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
        macroSettings={macroSettings}
        macros={macros}
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
  macroSettings: MacroSettings;
  macros: Macro[];
  onChange: (form: MacroFormState | ((current: MacroFormState) => MacroFormState)) => void;
  roles: Role[];
  shortcutConflict?: string;
  t: Translator;
}

function MacroForm({
  form,
  games,
  isSaving,
  macroSettings,
  macros,
  onChange,
  roles,
  shortcutConflict,
  t
}: MacroFormProps): JSX.Element {
  const gameNameById = useMemo(() => new Map(games.map((game) => [game.id, game.name])), [games]);
  const roleIds = useMemo(() => new Set(form.roleIds), [form.roleIds]);
  const missingRoleIds = useMemo(
    () => form.roleIds.filter((roleId) => !roles.some((role) => role.id === roleId)),
    [form.roleIds, roles]
  );
  const macroTargetOptions = useMemo(
    () => getMacroTargetOptions(macros, form.id),
    [form.id, macros]
  );
  const firstCallableMacroTargetId = macroTargetOptions.find(
    (option) => !option.unavailableReason
  )?.macro.id;
  const addStepOptions: Array<{
    action?: MacroKeyAction;
    label: string;
    type: MacroStep["type"];
  }> = [
    { type: "key", action: "tap", label: t("macroForm.addKey") },
    { type: "key", action: "hold_until_stop", label: t("macroForm.addHold") },
    { type: "click", label: t("macroForm.addClick") },
    { type: "delay", label: t("macroForm.addDelay") },
    { type: "macro", label: t("macroForm.addMacro") }
  ];
  const [draggedStepId, setDraggedStepId] = useState<string | null>(null);
  const [dropTargetStepId, setDropTargetStepId] = useState<string | null>(null);

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

  function addStep(type: MacroStep["type"], keyAction?: MacroKeyAction): void {
    const step = createStep(type, undefined, firstCallableMacroTargetId, form.activationMode, keyAction);
    update((current) => ({ ...current, steps: [...current.steps, step] }));
  }

  function updateStep(stepId: string, nextStep: MacroStep): void {
    update((current) => ({
      ...current,
      steps: current.steps.map((step) => (step.id === stepId ? nextStep : step))
    }));
  }

  function moveStepById(stepId: string, targetStepId: string): void {
    update((current) => {
      const nextSteps = moveItemById(current.steps, stepId, targetStepId);
      return nextSteps === current.steps ? current : { ...current, steps: nextSteps };
    });
  }

  function duplicateStep(stepId: string): void {
    update((current) => {
      const index = current.steps.findIndex((step) => step.id === stepId);
      if (index === -1) {
        return current;
      }

      const step = current.steps[index];
      const copy = duplicateStepState(step);
      const steps = [...current.steps];
      steps.splice(index + 1, 0, copy);
      return { ...current, steps };
    });
  }

  function removeStep(stepId: string): void {
    update((current) => ({ ...current, steps: current.steps.filter((step) => step.id !== stepId) }));
  }

  function handleStepDragStart(event: DragEvent<HTMLButtonElement>, stepId: string): void {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(MACRO_STEP_DRAG_MIME, stepId);
    event.dataTransfer.setData("text/plain", stepId);
    setDraggedStepId(stepId);
    setDropTargetStepId(null);
  }

  function clearStepDragState(): void {
    setDraggedStepId(null);
    setDropTargetStepId(null);
  }

  function handleStepDragOver(event: DragEvent<HTMLDivElement>, targetStepId: string): void {
    if (!draggedStepId || draggedStepId === targetStepId) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropTargetStepId(targetStepId);
  }

  function handleStepDrop(event: DragEvent<HTMLDivElement>, targetStepId: string): void {
    event.preventDefault();
    const sourceStepId = event.dataTransfer.getData(MACRO_STEP_DRAG_MIME) || event.dataTransfer.getData("text/plain");

    if (sourceStepId && sourceStepId !== targetStepId) {
      moveStepById(sourceStepId, targetStepId);
    }

    clearStepDragState();
  }

  function handleStepDragEnd(): void {
    clearStepDragState();
  }

  return (
    <>
          <aside className="grid content-start gap-4">
            <Surface className="p-4" padding="none" variant="inset">
              <FormField
                label={t("macroForm.activation")}
                description={t("macroForm.activationDescription")}
              >
                <SegmentedControl<MacroActivationMode>
                  className={cn(
                    "w-full grid-cols-2 p-0.5 [&>button]:h-6",
                    isSaving && "pointer-events-none opacity-45"
                  )}
                  aria-disabled={isSaving}
                  items={[
                    { value: "toggle", label: t("macroForm.activation.toggle"), icon: Check },
                    { value: "while_held", label: t("macroForm.activation.whileHeld"), icon: Keyboard }
                ]}
                value={form.activationMode ?? "toggle"}
                onValueChange={(activationMode) => {
                  if (!isSaving) update((current) => ({ ...current, activationMode }));
                }}
                />
              </FormField>
            </Surface>

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
                              intervalMs: form.repeat.type === "loop"
                                ? form.repeat.intervalMs
                                : macroSettings.defaultLoopDelayMs
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

            {form.repeat.type === "loop" || form.steps.some(
              (step) => step.type === "key" && step.action === "hold_until_stop"
            ) ? (
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
                          isDragging={draggedStepId === step.id}
                          isDropTarget={dropTargetStepId === step.id}
                          isSaving={isSaving}
                          macroTargetOptions={macroTargetOptions}
                          step={step}
                          t={t}
                          onDragEnd={handleStepDragEnd}
                          onDragOver={(event) => handleStepDragOver(event, step.id)}
                          onDragStart={(event) => handleStepDragStart(event, step.id)}
                          onDrop={(event) => handleStepDrop(event, step.id)}
                          onDuplicate={() => duplicateStep(step.id)}
                          onRemove={() => removeStep(step.id)}
                          onUpdate={(nextStep) => updateStep(step.id, nextStep)}
                        />
                      ))}
                    </div>
                  )}

                  <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border/50 pt-3">
                    {addStepOptions.map((option) => (
                      <Button
                        key={`${option.type}-${option.label}-${option.action ?? "default"}`}
                        type="button"
                        variant="outline"
                        onClick={() => addStep(option.type, option.action)}
                        disabled={isSaving}
                      >
                        <Plus size={14} />
                        {option.label}
                      </Button>
                    ))}
                  </div>
                </div>
              </FormField>
            </Surface>
          </div>
    </>
  );
}

interface AffixedInputProps {
  "aria-label": string;
  disabled: boolean;
  max: number;
  min: number;
  onChange: (value: number) => void;
  onPaste?: (event: ClipboardEvent<HTMLInputElement>) => void;
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
  onPaste,
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
        <span className="pointer-events-none shrink-0 pl-2.5 text-[13px] font-normal text-muted-foreground">
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
        onPaste={onPaste}
        disabled={disabled}
      />
      {suffix ? (
        <span className="pointer-events-none shrink-0 pr-2.5 text-[13px] font-normal text-muted-foreground">
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
  const [unit, setUnit] = useState<TimeUnit>("s");
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
        <div className="flex min-w-0 gap-2">
          <AffixedInput
            aria-label={t("macroForm.intervalCustomValue")}
            disabled={disabled}
            max={getTimeUnitMax(unit)}
            min={0}
            step={getTimeUnitStep(unit)}
            suffix={unit}
            value={toDisplayTime(value, unit)}
            widthClassName="h-[30px] min-w-0 flex-1"
            onChange={(next) => onChange(fromDisplayTime(next, unit))}
          />
          <TimeUnitSelect disabled={disabled} t={t} unit={unit} onChange={setUnit} />
        </div>
      ) : null}
      {isValidMacroInterval(value) && value < 250 ? (
        <p
          className="flex items-start gap-1.5 text-[11px] font-medium leading-4 text-amber-600 dark:text-amber-300"
          role="status"
        >
          <AlertTriangle className="mt-px shrink-0" size={14} aria-hidden="true" />
          <span>{t("macroForm.intervalLowWarning")}</span>
        </p>
      ) : null}
    </div>
  );
}

type TimeUnit = "ms" | "s" | "min" | "h" | "d";

const TIME_UNIT_FACTORS: Record<TimeUnit, number> = {
  ms: 1,
  s: 1_000,
  min: 60_000,
  h: 3_600_000,
  d: 86_400_000
};

function getTimeUnitMax(unit: TimeUnit): number {
  return MACRO_DELAY_MAX_MS / TIME_UNIT_FACTORS[unit];
}

function getTimeUnitStep(unit: TimeUnit): number {
  return unit === "ms" ? 1 : 0.001;
}

function toDisplayTime(ms: number, unit: TimeUnit): number {
  return unit === "ms" ? ms : Number((ms / TIME_UNIT_FACTORS[unit]).toFixed(3));
}

function fromDisplayTime(value: number, unit: TimeUnit): number {
  return Math.round(value * TIME_UNIT_FACTORS[unit]);
}

function TimeUnitSelect({
  disabled,
  onChange,
  t,
  unit
}: {
  disabled: boolean;
  onChange: (unit: TimeUnit) => void;
  t: Translator;
  unit: TimeUnit;
}): JSX.Element {
  return (
    <Select value={unit} disabled={disabled} onValueChange={(value) => onChange(value as TimeUnit)}>
      <SelectTrigger aria-label={t("macroForm.timeUnit")} className="w-fit shrink-0"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value="ms">{t("macroForm.milliseconds")}</SelectItem>
        <SelectItem value="s">{t("macroForm.seconds")}</SelectItem>
        <SelectItem value="min">{t("macroForm.minutes")}</SelectItem>
        <SelectItem value="h">{t("macroForm.hours")}</SelectItem>
        <SelectItem value="d">{t("macroForm.days")}</SelectItem>
      </SelectContent>
    </Select>
  );
}

interface ShortcutRecorderProps {
  onChange: (trigger: MacroTrigger | undefined) => void;
  t: Translator;
  trigger: MacroTrigger | undefined;
}

function ShortcutRecorder({ onChange, t, trigger }: ShortcutRecorderProps): JSX.Element {
  const [isRecording, setIsRecording] = useState(false);
  const selectedCode = trigger?.code ?? "";
  const selectedModifiers = getMacroTriggerModifiers(trigger);
  const selectedModifierValue = selectedModifiers.length > 0
    ? selectedModifiers.join(",")
    : MODIFIERS_NONE_VALUE;
  const mainKeyIsModifier = isPureModifierCode(selectedCode);

  function updateShortcut(code: string, modifiers: MacroKeyModifier[]): void {
    if (!code) {
      return;
    }

    onChange({
      code,
      ...getMacroTriggerModifierFlags(modifiers)
    });
  }

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
        ...getMacroTriggerModifierFlags([
          ...(event.ctrlKey ? ["ctrl" as const] : []),
          ...(event.altKey ? ["alt" as const] : []),
          ...(event.shiftKey ? ["shift" as const] : []),
          ...(event.metaKey ? ["meta" as const] : [])
        ])
      });
      setIsRecording(false);
    }

    window.addEventListener("keydown", handleKeyDown, true);

    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [isRecording, onChange]);

  return (
    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto_auto]">
      <Select
        value={selectedModifierValue}
        onValueChange={(value) => updateShortcut(selectedCode, parseModifierComboValue(value))}
        disabled={isRecording || !selectedCode || mainKeyIsModifier}
      >
        <SelectTrigger className="w-full min-w-0" aria-label={t("macroForm.modifiers")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {getModifierComboOptions(t).map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={selectedCode}
        onValueChange={(code) => updateShortcut(code, selectedModifiers)}
        disabled={isRecording}
      >
        <SelectTrigger className="w-full min-w-0" aria-label={t("macro.step.key")}>
          <SelectValue
            placeholder={isRecording ? t("macroForm.shortcutRecording") : t("macroForm.shortcut")}
          >
            {isRecording || selectedCode ? (isRecording ? t("macroForm.shortcutRecording") : formatMacroCode(selectedCode)) : undefined}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {commonMacroKeyCodes.map((code) => (
            <SelectItem key={code} value={code}>
              {formatMacroCode(code)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <RecordingButton
        isRecording={isRecording}
        t={t}
        onRecordingChange={setIsRecording}
      />
      <Button
        type="button"
        variant="ghost"
        onClick={() => {
          setIsRecording(false);
          onChange(undefined);
        }}
        disabled={!trigger}
      >
        <X size={14} />
        {t("macroForm.clearShortcut")}
      </Button>
    </div>
  );
}

function getMacroTriggerModifiers(trigger: MacroTrigger | undefined): MacroKeyModifier[] {
  return canonicalizeMacroKeyModifiers([
    ...(trigger?.ctrl ? ["ctrl" as const] : []),
    ...(trigger?.alt ? ["alt" as const] : []),
    ...(trigger?.shift ? ["shift" as const] : []),
    ...(trigger?.meta ? ["meta" as const] : [])
  ]);
}

function getMacroTriggerModifierFlags(
  modifiers: readonly MacroKeyModifier[]
): Pick<MacroTrigger, "ctrl" | "alt" | "shift" | "meta"> {
  const primaryModifier = document.documentElement.dataset.platform === "mac" ? "meta" : "ctrl";
  return {
    ctrl: modifiers.includes("ctrl") || (modifiers.includes("primary") && primaryModifier === "ctrl"),
    alt: modifiers.includes("alt"),
    shift: modifiers.includes("shift"),
    meta: modifiers.includes("meta") || (modifiers.includes("primary") && primaryModifier === "meta")
  };
}

interface RecordingButtonProps {
  disabled?: boolean;
  isRecording: boolean;
  onRecordingChange: (isRecording: boolean) => void;
  t: Translator;
}

function RecordingButton({
  disabled = false,
  isRecording,
  onRecordingChange,
  t
}: RecordingButtonProps): JSX.Element {
  const label = t(isRecording ? "macroForm.stopRecording" : "macroForm.recordKey");

  return (
    <Button
      aria-label={label}
      aria-pressed={isRecording}
      className={cn(
        isRecording &&
          "border-destructive/50 bg-destructive/10 text-destructive shadow-sm shadow-destructive/10 hover:border-destructive/60 hover:bg-destructive/15 hover:text-destructive"
      )}
      disabled={disabled}
      size="icon"
      title={label}
      type="button"
      variant="outline"
      onClick={() => onRecordingChange(!isRecording)}
    >
      {isRecording ? (
        <Square className="fill-current" size={11} aria-hidden="true" />
      ) : (
        <CircleDot size={15} aria-hidden="true" />
      )}
    </Button>
  );
}

interface MacroStepEditorProps {
  index: number;
  isDragging: boolean;
  isDropTarget: boolean;
  isSaving: boolean;
  macroTargetOptions: MacroTargetOption[];
  onDragEnd: () => void;
  onRemove: () => void;
  onDragOver: (event: DragEvent<HTMLDivElement>) => void;
  onDragStart: (event: DragEvent<HTMLButtonElement>) => void;
  onDrop: (event: DragEvent<HTMLDivElement>) => void;
  onDuplicate: () => void;
  onUpdate: (step: MacroStep) => void;
  step: MacroStep;
  t: Translator;
}

function MacroStepEditor({
  index,
  isDragging,
  isDropTarget,
  isSaving,
  macroTargetOptions,
  onDragEnd,
  onDuplicate,
  onRemove,
  onDragOver,
  onDragStart,
  onDrop,
  onUpdate,
  step,
  t
}: MacroStepEditorProps): JSX.Element {
    return (
      <div
      data-testid={`macro-step-${step.id}`}
      className={cn(
        "glass-divider flex flex-wrap items-center gap-2 border-b p-2.5 transition-[box-shadow,opacity] duration-200",
        isDragging && "opacity-50",
        isDropTarget && "ring-2 ring-primary/70 ring-offset-2 ring-offset-background"
      )}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon"
        draggable
        aria-label={t("macroForm.dragStep")}
        title={t("macroForm.dragStep")}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        disabled={isSaving}
      >
        <GripVertical size={14} />
      </Button>

      <span className="mr-2 shrink-0 text-[11px] text-muted-foreground">
        {String(index + 1).padStart(2, "0")}
      </span>

      <Select
        value={step.type}
        onValueChange={(value) =>
          onUpdate(createStep(
            value as MacroStep["type"],
            step.id,
            macroTargetOptions.find((option) => !option.unavailableReason)?.macro.id
          ))
        }
        disabled={isSaving}
      >
        <SelectTrigger className="w-fit shrink-0" aria-label={t("macroForm.stepType")}>
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

      <MacroStepFields
        className="ml-0 flex-1"
        isSaving={isSaving}
        macroTargetOptions={macroTargetOptions}
        step={step}
        t={t}
        onUpdate={onUpdate}
      />

      <div className="ml-auto flex shrink-0 justify-end gap-1">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          title={t("macros.copy")}
          onClick={onDuplicate}
          disabled={isSaving}
        >
          <Copy size={14} />
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

const macroStepTypeOrder: Array<MacroStep["type"]> = ["key", "click", "delay", "macro"];
const macroKeyModifiers: MacroKeyModifier[] = ["primary", "ctrl", "alt", "shift", "meta"];
const MODIFIERS_NONE_VALUE = "__no_modifiers__";

function macroClickAnchorLabel(anchor: MacroClickAnchor, t: Translator): string {
  switch (anchor) {
    case "top-left": return t("macroForm.clickAnchor.topLeft");
    case "top-center": return t("macroForm.clickAnchor.topCenter");
    case "top-right": return t("macroForm.clickAnchor.topRight");
    case "center-left": return t("macroForm.clickAnchor.centerLeft");
    case "center": return t("macroForm.clickAnchor.center");
    case "center-right": return t("macroForm.clickAnchor.centerRight");
    case "bottom-left": return t("macroForm.clickAnchor.bottomLeft");
    case "bottom-center": return t("macroForm.clickAnchor.bottomCenter");
    case "bottom-right": return t("macroForm.clickAnchor.bottomRight");
  }
}

function getModifierComboOptions(t: Translator): Array<{ value: string; label: string }> {
  const combinations: Array<{ value: string; label: string }> = [];

  for (let mask = 0; mask < (1 << macroKeyModifiers.length); mask += 1) {
    const selectedModifiers: MacroKeyModifier[] = [];

    for (let index = 0; index < macroKeyModifiers.length; index += 1) {
      if (mask & (1 << index)) {
        selectedModifiers.push(macroKeyModifiers[index]);
      }
    }

    if (
      selectedModifiers.includes("primary") &&
      (selectedModifiers.includes("ctrl") || selectedModifiers.includes("meta"))
    ) {
      continue;
    }

    const normalizedModifiers = canonicalizeMacroKeyModifiers(selectedModifiers);
    const value = normalizedModifiers.length > 0
      ? normalizedModifiers.join(",")
      : MODIFIERS_NONE_VALUE;
    const label = normalizedModifiers.length > 0
      ? normalizedModifiers.map((modifier) => formatMacroModifierLabel(modifier, t)).join(" + ")
      : t("macroForm.modifiersNone");

    combinations.push({ value, label });
  }

  return combinations.sort((left, right) => {
    const leftModifiers = left.value === MODIFIERS_NONE_VALUE
      ? []
      : left.value.split(",");
    const rightModifiers = right.value === MODIFIERS_NONE_VALUE
      ? []
      : right.value.split(",");

    if (leftModifiers.length !== rightModifiers.length) {
      return leftModifiers.length - rightModifiers.length;
    }

    const leftOrder = leftModifiers.map((item) => macroKeyModifiers.indexOf(item as MacroKeyModifier));
    const rightOrder = rightModifiers.map((item) => macroKeyModifiers.indexOf(item as MacroKeyModifier));

    for (let index = 0; index < leftOrder.length; index += 1) {
      if (leftOrder[index] !== rightOrder[index]) {
        return leftOrder[index] - rightOrder[index];
      }
    }

    return 0;
  });
}

function parseModifierComboValue(value: string): MacroKeyModifier[] {
  if (value === MODIFIERS_NONE_VALUE) {
    return [];
  }

  if (!value) {
    return [];
  }

  const parsed = value
    .split(",")
    .map((rawModifier) => (
      macroKeyModifiers.includes(rawModifier as MacroKeyModifier)
        ? rawModifier as MacroKeyModifier
        : undefined
    ))
    .filter((modifier): modifier is MacroKeyModifier => modifier !== undefined);

  return canonicalizeMacroKeyModifiers(parsed);
}

function getMacroStepTypeLabel(type: MacroStep["type"], t: Translator): string {
  switch (type) {
    case "key":
      return t("macro.step.key");
    case "click":
      return t("macro.step.click");
    case "delay":
      return t("macro.step.delay");
    case "macro":
      return t("macro.step.macro");
  }
}

function getMacroTargetOptionLabel(
  option: MacroTargetOption,
  t: Translator,
  callMode: MacroCallMode = "wait"
): string {
  const details: string[] = [];
  if (option.macro.repeat.type === "loop") {
    details.push(t(callMode === "trigger"
      ? "macroForm.macroTargetRunsConfigured"
      : "macroForm.macroTargetRunsOnce"));
  }
  if (!option.macro.enabled) {
    details.push(t("macroForm.macroTargetDisabled"));
  }
  switch (option.unavailableReason) {
    case "self":
      details.push(t("macroForm.macroTargetSelf"));
      break;
    case "hold":
      details.push(t("macroForm.macroTargetHoldsKey"));
      break;
    case "cycle":
      details.push(t("macroForm.macroTargetCreatesCycle"));
      break;
    case "missing":
      details.push(t("macroForm.macroTargetUnavailable"));
      break;
  }
  return details.length > 0
    ? `${option.macro.name} (${details.join(" · ")})`
    : option.macro.name;
}

function MacroStepFields({
  isSaving,
  macroTargetOptions,
  className,
  onUpdate,
  step,
  t
}: {
  className?: string;
  isSaving: boolean;
  macroTargetOptions: MacroTargetOption[];
  onUpdate: (step: MacroStep) => void;
  step: MacroStep;
  t: Translator;
}): JSX.Element {
  const [isRecording, setIsRecording] = useState(false);
  const [timeUnit, setTimeUnit] = useState<TimeUnit>("s");
  const isKeyStep = step.type === "key";

  useEffect(() => {
    if (!isKeyStep) {
      setIsRecording(false);
    }
  }, [isKeyStep]);

  if (isKeyStep) {
    const modifiers = step.modifiers ?? [];
    const canonicalModifiers = canonicalizeMacroKeyModifiers(modifiers);
    const mainKeyIsModifier = isPureModifierCode(step.code);
    const modifierComboOptions = getModifierComboOptions(t);
    const selectedModifierValue = canonicalModifiers.length > 0
      ? canonicalModifiers.join(",")
      : MODIFIERS_NONE_VALUE;
    const updateKeyInput = (code: string, nextModifiers: MacroKeyModifier[]): void => {
      const normalizedModifiers = canonicalizeMacroKeyModifiers(nextModifiers);
      onUpdate({
        ...step,
        code,
        ...(normalizedModifiers.length > 0 ? { modifiers: normalizedModifiers } : { modifiers: undefined }),
        label: formatMacroKeyCombination(code, normalizedModifiers, t)
      });
    };

    return (
      <div className={cn("grid min-w-0 gap-2", className)}>
        <div className="flex min-w-0 items-center gap-2">
          <Select
            value={selectedModifierValue}
            onValueChange={(value) => updateKeyInput(step.code, parseModifierComboValue(value))}
            disabled={isSaving || isRecording || mainKeyIsModifier}
          >
            <SelectTrigger
              className="w-fit shrink-0"
              aria-label={t("macroForm.modifiers")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {modifierComboOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={step.code}
            onValueChange={(value) => updateKeyInput(value, canonicalModifiers)}
            disabled={isSaving || isRecording}
          >
            <SelectTrigger className="w-fit shrink-0" aria-label={t("macro.step.key")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {commonMacroKeyCodes.map((code) => (
                <SelectItem
                  key={code}
                  value={code}
                  disabled={canonicalModifiers.length > 0 && isPureModifierCode(code)}
                >
                  {formatMacroCode(code)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <KeyRecorder
            disabled={isSaving}
            isRecording={isRecording}
            t={t}
            onRecordingChange={setIsRecording}
            onRecord={({ code, modifiers: recordedModifiers }) =>
              updateKeyInput(code, recordedModifiers)
            }
          />
          <Select
            disabled={isSaving}
            value={step.action ?? "tap"}
            onValueChange={(action) => onUpdate({
              ...step,
              action: action as Extract<MacroStep, { type: "key" }>["action"]
            })}
          >
            <SelectTrigger className="w-fit shrink-0" aria-label={t("macroForm.keyAction")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="tap">{t("macroForm.keyAction.tap")}</SelectItem>
              <SelectItem value="hold_until_stop">
                {canonicalModifiers.length > 0
                  ? t("macroForm.keyAction.holdCombination")
                  : t("macroForm.keyAction.hold")}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        {mainKeyIsModifier ? (
          <p className="text-[11px] leading-4 text-muted-foreground">
            {t("macroForm.modifiersNeedMainKey")}
          </p>
        ) : null}
      </div>
    );
  }

  if (step.type === "click") {
    const unit: MacroClickUnit = step.unit ?? "percent";
    const isPixel = unit === "px";
    const anchor = step.anchor ?? DEFAULT_MACRO_CLICK_ANCHOR;
    const storedAnchor = anchor === DEFAULT_MACRO_CLICK_ANCHOR ? {} : { anchor };
    const x = step.unit === "px" ? step.xPx : step.xPercent;
    const y = step.unit === "px" ? step.yPx : step.yPercent;
    const handleCoordinatePaste = (event: ClipboardEvent<HTMLInputElement>): void => {
      const measurement = parseMacroCoordinateClipboard(event.clipboardData.getData("text"));
      const nextAnchor = measurement?.anchor ?? anchor;
      const offset = measurement
        ? convertMacroCoordinateToOffset(measurement, nextAnchor, unit)
        : undefined;
      if (!offset) {
        return;
      }

      event.preventDefault();
      const nextStoredAnchor = nextAnchor === DEFAULT_MACRO_CLICK_ANCHOR ? {} : { anchor: nextAnchor };
      onUpdate(isPixel
        ? { id: step.id, type: "click", unit: "px", ...nextStoredAnchor, xPx: offset.x, yPx: offset.y }
        : {
            id: step.id,
            type: "click",
            ...nextStoredAnchor,
            xPercent: offset.x,
            yPercent: offset.y
          });
    };
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-2 md:flex-nowrap">
        <Select
          disabled={isSaving}
          value={unit}
          onValueChange={(nextUnit) => onUpdate(nextUnit === "px"
            ? { id: step.id, type: "click", unit: "px", ...storedAnchor, xPx: step.unit === "px" ? step.xPx : step.xPercent, yPx: step.unit === "px" ? step.yPx : step.yPercent }
            : { id: step.id, type: "click", ...storedAnchor, xPercent: step.unit === "px" ? step.xPx : step.xPercent, yPercent: step.unit === "px" ? step.yPx : step.yPercent })}
        >
          <SelectTrigger aria-label={t("macroForm.clickUnit")} className="w-fit shrink-0"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="percent">%</SelectItem>
            <SelectItem value="px">px</SelectItem>
          </SelectContent>
        </Select>
        <Select
          disabled={isSaving}
          value={anchor}
          onValueChange={(nextAnchor) => {
            const nextStoredAnchor = nextAnchor === DEFAULT_MACRO_CLICK_ANCHOR
              ? {}
              : { anchor: nextAnchor as MacroClickAnchor };
            onUpdate(isPixel
              ? { id: step.id, type: "click", unit: "px", ...nextStoredAnchor, xPx: x, yPx: y }
              : { id: step.id, type: "click", ...nextStoredAnchor, xPercent: x, yPercent: y });
          }}
        >
          <SelectTrigger aria-label={t("macroForm.clickAnchor")} className="w-fit shrink-0"><SelectValue /></SelectTrigger>
          <SelectContent>
            {MACRO_CLICK_ANCHORS.map((option) => (
              <SelectItem key={option} value={option}>{macroClickAnchorLabel(option, t)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <AffixedInput
          aria-label={t("macroForm.clickXOffset")}
          disabled={isSaving}
          max={unit === "px" ? Number.MAX_SAFE_INTEGER : 100}
          min={unit === "px" ? Number.MIN_SAFE_INTEGER : -100}
          prefix={t("macroForm.clickXOffset")}
          suffix={unit === "px" ? "px" : "%"}
          step={unit === "px" ? 1 : 0.01}
          value={x}
          widthClassName="w-full max-w-36 shrink-0"
          onChange={(value) => onUpdate(isPixel
            ? { id: step.id, type: "click", unit: "px", ...storedAnchor, xPx: value, yPx: y }
            : { id: step.id, type: "click", ...storedAnchor, xPercent: value, yPercent: y })}
          onPaste={handleCoordinatePaste}
        />
        <AffixedInput
          aria-label={t("macroForm.clickYOffset")}
          disabled={isSaving}
          max={unit === "px" ? Number.MAX_SAFE_INTEGER : 100}
          min={unit === "px" ? Number.MIN_SAFE_INTEGER : -100}
          prefix={t("macroForm.clickYOffset")}
          suffix={unit === "px" ? "px" : "%"}
          step={unit === "px" ? 1 : 0.01}
          value={y}
          widthClassName="w-full max-w-36 shrink-0"
          onChange={(value) => onUpdate(isPixel
            ? { id: step.id, type: "click", unit: "px", ...storedAnchor, xPx: x, yPx: value }
            : { id: step.id, type: "click", ...storedAnchor, xPercent: x, yPercent: value })}
          onPaste={handleCoordinatePaste}
        />
      </div>
    );
  }

  if (step.type === "macro") {
    const selectedTarget = macroTargetOptions.find((option) => option.macro.id === step.macroId);
    const hasCallableTarget = macroTargetOptions.some((option) => !option.unavailableReason);
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Select
          disabled={isSaving}
          value={step.callMode ?? "wait"}
          onValueChange={(callMode) => onUpdate({
            ...step,
            callMode: callMode as MacroCallMode
          })}
        >
          <SelectTrigger className="w-fit shrink-0" aria-label={t("macroForm.macroCallMode")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="wait">{t("macroForm.macroCallMode.wait")}</SelectItem>
            <SelectItem value="trigger">{t("macroForm.macroCallMode.trigger")}</SelectItem>
          </SelectContent>
        </Select>
        <Select
          disabled={isSaving || !hasCallableTarget}
          value={step.macroId || undefined}
          onValueChange={(macroId) => onUpdate({ ...step, macroId })}
        >
          <SelectTrigger className="w-fit max-w-full" aria-label={t("macroForm.macroTarget")}>
            <SelectValue placeholder={t("macroForm.macroTargetPlaceholder")} />
          </SelectTrigger>
          <SelectContent>
            {macroTargetOptions.map((option) => (
              <SelectItem
                key={option.macro.id}
                value={option.macro.id}
                disabled={Boolean(option.unavailableReason)}
              >
                {getMacroTargetOptionLabel(option, t, step.callMode ?? "wait")}
              </SelectItem>
            ))}
            {!selectedTarget && step.macroId ? (
              <SelectItem value={step.macroId}>{t("macroForm.macroTargetUnavailable")}</SelectItem>
            ) : null}
          </SelectContent>
        </Select>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 items-center gap-2">
      <AffixedInput
      aria-label={t("macroForm.delayMs")}
      disabled={isSaving}
      max={getTimeUnitMax(timeUnit)}
      min={0}
      step={getTimeUnitStep(timeUnit)}
      suffix={timeUnit}
      value={toDisplayTime(step.ms, timeUnit)}
      widthClassName="w-fit shrink-0"
      onChange={(value) => onUpdate({ ...step, ms: fromDisplayTime(value, timeUnit) })}
      />
      <TimeUnitSelect disabled={isSaving} t={t} unit={timeUnit} onChange={setTimeUnit} />
    </div>
  );
}

function KeyRecorder({
  disabled,
  isRecording,
  onRecord,
  onRecordingChange,
  t
}: {
  disabled: boolean;
  isRecording: boolean;
  onRecord: (input: { code: string; modifiers: MacroKeyModifier[] }) => void;
  onRecordingChange: (isRecording: boolean) => void;
  t: Translator;
}): JSX.Element {
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

      onRecord({
        code: event.code,
        modifiers: canonicalizeMacroKeyModifiers([
          ...(event.ctrlKey ? ["ctrl" as const] : []),
          ...(event.altKey ? ["alt" as const] : []),
          ...(event.shiftKey ? ["shift" as const] : []),
          ...(event.metaKey ? ["meta" as const] : [])
        ])
      });
      onRecordingChange(false);
    }

    window.addEventListener("keydown", handleKeyDown, true);

    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [isRecording, onRecord, onRecordingChange]);

  return (
    <RecordingButton
      disabled={disabled}
      isRecording={isRecording}
      t={t}
      onRecordingChange={onRecordingChange}
    />
  );
}

function createStep(
  type: MacroStep["type"],
  id = createClientId(),
  macroId = "",
  activationMode: MacroActivationMode = "toggle",
  keyAction?: MacroKeyAction
): MacroStep {
  switch (type) {
    case "key":
      return {
        id,
        type: "key",
        code: "Tab",
        action: keyAction ?? (activationMode === "while_held" ? "hold_until_stop" : "tap"),
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
    case "macro":
      return {
        id,
        type: "macro",
        macroId,
        callMode: "wait"
      };
  }
}

function duplicateStepState(step: MacroStep): MacroStep {
  return {
    ...step,
    id: createClientId()
  };
}

export default MacroEditorRoute;
