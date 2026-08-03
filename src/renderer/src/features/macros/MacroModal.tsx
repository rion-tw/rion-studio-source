import { Check, Keyboard, ListChecks, Plus, Repeat, Save } from "lucide-react";

import { type FormEvent, type JSX, useMemo, useRef, useState } from "react";

import { useLocation, useNavigate, useParams } from "react-router";

import { EditorNotFound, EditorPage } from "../../components/EditorPage";

import { moveItemById } from "../../app/reorderItems";

import { Button } from "../../components/ui/button";

import { Switch } from "../../components/ui/switch";

import { FormField, HelpPanel, SegmentedControl, Surface } from "../../components/ui/patterns";

import { areEditorFormsEqual, createMacroFormState, createNewMacroForm } from "../../app/editorFormState";

import { readRequestedMacroRoleId } from "../../app/editorNavigation";

import type { MacroFormState } from "../../app/types";

import { useUnsavedChangesGuard } from "../../hooks/useUnsavedChangesGuard";

import { getPointerDragTargetId, usePointerDrag } from "../../hooks/usePointerDrag";

import type { Translator } from "../../i18n";

import { cn } from "../../lib/utils";

import { areMacroTriggersEqual, isReservedBrowserZoomMacroTrigger, isReservedRuntimeTabSwitchMacroTrigger, macroRoleAssignmentsOverlap, MACRO_OVERLAY_TRIGGER } from "../../../../shared/macroShortcuts";

import { DEFAULT_MACRO_SETTINGS } from "../../../../shared/macroSettings";

import type { Game, Macro, MacroActivationMode, MacroKeyAction, MacroRepeat, MacroSettings, MacroStep, Role } from "../../../../shared/types";

import { createClientId, getMacroTargetOptions, isCallableMacroTarget, isValidMacroInterval } from "./macroUtils";

import { MacroStepEditor, createStep, duplicateStepState } from "./MacroStepEditor";

import { MacroCommandImportDialog, MacroHelpSection, MacroIntervalControl, ShortcutRecorder } from "./MacroEditorControls";

import { MacroRoleCombobox } from "./MacroRoleCombobox";

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
    if (isReservedRuntimeTabSwitchMacroTrigger(form.trigger)) {
      return t("macroForm.shortcutRuntimeTabReserved");
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
      contentClassName="editor-layout editor-layout-macro"
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
  const [isCommandImportOpen, setIsCommandImportOpen] = useState(false);
  const stepDrag = usePointerDrag<string>({
    disabled: isSaving,
    getScrollContainer: () => document.querySelector<HTMLElement>("#app-editor-form"),
    getTargetId: (clientX, clientY) =>
      getPointerDragTargetId(clientX, clientY, "data-macro-step-id"),
    onDrop: (sourceStepId, targetStepId) => {
      if (sourceStepId !== targetStepId) {
        moveStepById(sourceStepId, targetStepId);
      }
    }
  });

  function update(updater: (current: MacroFormState) => MacroFormState): void {
    onChange(updater);
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

  return (
    <>
          <aside className="grid content-start gap-4">
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
                  <p className="mt-2 text-caption font-semibold text-destructive">
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
                htmlFor="macro-role"
                label={t("macroForm.roles")}
                description={t("macroForm.rolesDescription")}
              >
                {roles.length > 0 ? (
                  <MacroRoleCombobox
                    disabled={isSaving}
                    games={games}
                    roles={roles}
                    t={t}
                    value={form.roleIds}
                    onValueChange={(roleIds) => update((current) => ({ ...current, roleIds }))}
                  />
                ) : (
                  <div className="glass-control flex h-[var(--control-height)] items-center rounded-md px-2.5 text-control text-muted-foreground">
                    {t("macroForm.noRoles")}
                  </div>
                )}
              </FormField>
            </Surface>
          </aside>

          <div className="grid content-start gap-4">

            <Surface className="grid min-h-[360px] content-start gap-3 p-4" padding="none" variant="inset">
              <FormField label={t("macroForm.steps")} description={t("macroForm.stepsDescription")}>
                <div className="grid gap-3">
                  {form.steps.length === 0 ? (
                    <div className="glass-control grid min-h-44 place-items-center rounded-md border border-dashed border-border/60 p-6 text-center">
                      <div className="grid max-w-xs gap-2 text-muted-foreground">
                        <ListChecks className="mx-auto" size={24} />
                        <p className="text-xs font-semibold leading-5">{t("macroForm.stepsEmpty")}</p>
                        <p className="text-caption font-medium">{t("macroForm.stepsEmptyHint")}</p>
                      </div>
                    </div>
                  ) : (
                    <div className="glass-control grid overflow-hidden rounded-md [&>*:last-child]:border-b-0">
                      {form.steps.map((step, index) => (
                        <MacroStepEditor
                          key={step.id}
                          index={index}
                          isDragging={stepDrag.activePayload === step.id}
                          isDropTarget={stepDrag.targetId === step.id && stepDrag.activePayload !== step.id}
                          isSaving={isSaving}
                          macroTargetOptions={macroTargetOptions}
                          step={step}
                          t={t}
                          onReorderPointerDown={(event) => stepDrag.start(event, step.id)}
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
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setIsCommandImportOpen(true)}
                      disabled={isSaving}
                    >
                      <Plus size={14} />
                      {t("macroForm.addCommand")}
                    </Button>
                  </div>
                </div>
              </FormField>
            </Surface>

            <div className="editor-layout-macro-help grid gap-4" data-macro-help-list>
              <HelpPanel data-macro-help="activation">
                <MacroHelpSection title={t("macroForm.help.activationTitle")}>
                  <li>{t("macroForm.help.activationRoles")}</li>
                  <li>{t("macroForm.help.activationModes")}</li>
                  <li>{t("macroForm.help.activationRepeat")}</li>
                </MacroHelpSection>
              </HelpPanel>

              <HelpPanel data-macro-help="calls">
                <MacroHelpSection title={t("macroForm.help.callsTitle")}>
                  <li>{t("macroForm.help.callsRequirements")}</li>
                  <li>{t("macroForm.help.callsWait")}</li>
                  <li>{t("macroForm.help.callsTrigger")}</li>
                  <li>{t("macroForm.help.callsDuplicate")}</li>
                </MacroHelpSection>
              </HelpPanel>

              <HelpPanel data-macro-help="stop">
                <MacroHelpSection title={t("macroForm.help.stopTitle")}>
                  <li>{t("macroForm.help.stopRun")}</li>
                  <li>{t("macroForm.help.stopChild")}</li>
                  <li>{t("macroForm.help.stopRole")}</li>
                </MacroHelpSection>
              </HelpPanel>
            </div>
          </div>

          <MacroCommandImportDialog
            currentMacroId={form.id}
            existingStepCount={form.steps.length}
            isOpen={isCommandImportOpen}
            macros={macros}
            t={t}
            onClose={() => setIsCommandImportOpen(false)}
            onImport={(steps) => {
              update((current) => ({
                ...current,
                steps: [
                  ...current.steps,
                  ...steps.map((step) => ({ ...step, id: createClientId() }))
                ]
              }));
              setIsCommandImportOpen(false);
            }}
          />
    </>
  );
}

export default MacroEditorRoute;

export { MacroCommandImportDialog } from "./MacroEditorControls";
