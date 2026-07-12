import {
  Check,
  ChevronDown,
  ChevronUp,
  Keyboard,
  ListChecks,
  Loader2,
  Plus,
  Repeat,
  Save,
  Trash2,
  X
} from "lucide-react";
import { type FormEvent, type JSX, type ReactNode, useEffect, useMemo, useState } from "react";

import { Button } from "../../components/ui/button";
import { CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Select } from "../../components/ui/select";
import {
  FieldHeader,
  FormField,
  FormGrid,
  SegmentedControl,
  Surface
} from "../../components/ui/patterns";
import type { MacroFormState } from "../../app/types";
import type { Translator } from "../../i18n";
import { cn } from "../../lib/utils";
import type { MacroRepeat, MacroStep, MacroTrigger, Role } from "../../../../shared/types";
import {
  commonMacroKeyCodes,
  createClientId,
  formatMacroCode,
  formatMacroShortcut,
  isPureModifierCode
} from "./macroUtils";

interface MacroModalProps {
  form: MacroFormState;
  isSaving: boolean;
  onCancel: () => void;
  onChange: (form: MacroFormState | ((current: MacroFormState) => MacroFormState)) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  roles: Role[];
  t: Translator;
}

function MacroModal(props: MacroModalProps): JSX.Element {
  const { onCancel, t } = props;

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        onCancel();
      }
    }

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onCancel]);

  return (
    <div className="app-no-drag fixed inset-0 z-50 grid place-items-center p-4">
      <button
        className="app-modal-backdrop absolute inset-0 cursor-default"
        type="button"
        aria-label={t("macroForm.aria.close")}
        onClick={onCancel}
      />
      <div className="relative z-10 w-full max-w-6xl" role="dialog" aria-modal="true" aria-labelledby="macro-form-title">
        <MacroForm {...props} />
      </div>
    </div>
  );
}

function MacroForm({ form, isSaving, onCancel, onChange, onSubmit, roles, t }: MacroModalProps): JSX.Element {
  const [newStepType, setNewStepType] = useState<MacroStep["type"]>("key");
  const assignedRole = useMemo(
    () => roles.find((role) => role.id === form.roleId),
    [form.roleId, roles]
  );
  const isAssignedRoleMissing = Boolean(form.roleId) && !assignedRole;
  const canSubmit = Boolean(form.roleId) && form.steps.length > 0 && !isSaving;
  const saveHint = !form.roleId
    ? t("macroForm.saveHint.needsRole")
    : form.steps.length === 0
      ? t("macroForm.saveHint.needsStep")
      : t("macroForm.saveHint.ready");

  function update(updater: (current: MacroFormState) => MacroFormState): void {
    onChange(updater);
  }

  function updateRoleId(roleId: string): void {
    update((current) => ({ ...current, roleId }));
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
    <Surface className="flex max-h-[calc(100vh-2rem)] flex-col overflow-hidden text-card-foreground" radius="lg" variant="modal">
      <CardHeader className="glass-divider flex-row items-start justify-between gap-4 border-b">
        <div className="min-w-0">
          <CardTitle id="macro-form-title">{form.id ? t("macroForm.title.edit") : t("macroForm.title.new")}</CardTitle>
          <CardDescription className="mt-1">
            {form.id ? t("macroForm.description.edit") : t("macroForm.description.new")}
          </CardDescription>
        </div>
        <Button type="button" variant="ghost" size="icon" title={t("macroForm.cancelTitle")} onClick={onCancel} disabled={isSaving}>
          <X size={17} />
        </Button>
      </CardHeader>

      <form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => onSubmit(event)}>
        <div className="grid min-h-0 flex-1 gap-4 overflow-auto p-4 md:p-5">
          <Surface padding="lg" variant="inset">
            <FormGrid columns={2}>
              <FormField
                htmlFor="macro-name"
                label={t("macroForm.name")}
                description={t("macroForm.nameDescription")}
              >
                <Input
                  id="macro-name"
                  value={form.name}
                  onChange={(event) => update((current) => ({ ...current, name: event.target.value }))}
                  required
                  maxLength={80}
                  placeholder={t("macroForm.namePlaceholder")}
                />
              </FormField>

              <FormField
                htmlFor={roles.length > 0 ? "macro-role" : undefined}
                label={t("macroForm.roles")}
                description={t("macroForm.rolesDescription")}
              >
                {roles.length > 0 ? (
                  <Select
                    id="macro-role"
                    value={form.roleId}
                    onChange={(event) => updateRoleId(event.target.value)}
                    disabled={isSaving}
                  >
                    <option value="" disabled>
                      {t("macroForm.noRoleSelected")}
                    </option>
                    {isAssignedRoleMissing ? (
                      <option value={form.roleId}>{t("macros.unknownRole")}</option>
                    ) : null}
                    {roles.map((role) => (
                      <option key={role.id} value={role.id}>
                        {role.name}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <div className="glass-control flex h-[30px] items-center rounded-md px-2.5 text-xs text-muted-foreground">
                    {t("macroForm.noRoles")}
                  </div>
                )}
              </FormField>

              <FormField label={t("macroForm.shortcut")} description={t("macroForm.shortcutDescription")}>
                <ShortcutRecorder
                  trigger={form.trigger}
                  t={t}
                  onChange={(trigger) => update((current) => ({ ...current, trigger }))}
                />
              </FormField>

              <FormField label={t("macroForm.repeat")} description={t("macroForm.repeatDescription")}>
                <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(120px,0.65fr)]">
                  <SegmentedControl<MacroRepeat["type"]>
                    className={cn(
                      "grid-cols-2 p-0.5 [&>button]:h-6",
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
                  <AffixedInput
                    aria-label={t("macroForm.intervalMs")}
                    disabled={isSaving || form.repeat.type !== "loop"}
                    max={600000}
                    min={0}
                    prefix={t("macroForm.intervalMs")}
                    suffix="ms"
                    value={form.repeat.type === "loop" ? form.repeat.intervalMs : 0}
                    widthClassName={cn("h-[30px] w-full", form.repeat.type !== "loop" && "opacity-60")}
                    onChange={(intervalMs) => updateRepeat({ type: "loop", intervalMs })}
                  />
                </div>
              </FormField>
            </FormGrid>
          </Surface>

          <Surface className="grid min-h-[300px] content-start gap-4" padding="lg" variant="inset">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex min-w-0 items-start gap-3">
                <div className="glass-control grid size-[30px] shrink-0 place-items-center rounded-md text-muted-foreground">
                  <ListChecks size={17} />
                </div>
                <FieldHeader
                  className="pt-0.5"
                  title={t("macroForm.steps")}
                  description={t("macroForm.stepsDescription")}
                />
              </div>
              <div className="grid gap-2 sm:grid-cols-[auto_auto] sm:items-center">
                <InlineControl label={t("macroForm.stepType")} controlClassName="w-28 flex-none">
                  <Select
                    className="h-8"
                    value={newStepType}
                    onChange={(event) => setNewStepType(event.target.value as MacroStep["type"])}
                    disabled={isSaving}
                    aria-label={t("macroForm.stepType")}
                  >
                    {macroStepTypeOrder.map((type) => (
                      <option key={type} value={type}>
                        {getMacroStepTypeLabel(type, t)}
                      </option>
                    ))}
                  </Select>
                </InlineControl>
                <Button
                  className="h-8"
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => addStep(newStepType)}
                  disabled={isSaving}
                >
                  <Plus size={14} />
                  {t("macroForm.addStep")}
                </Button>
              </div>
            </div>

            {form.steps.length === 0 ? (
              <div className="glass-control grid min-h-44 place-items-center rounded-md border border-dashed border-border/60 p-6 text-center">
                <div className="grid max-w-xs gap-2 text-muted-foreground">
                  <ListChecks className="mx-auto" size={24} />
                  <p className="text-xs font-semibold leading-5">{t("macroForm.stepsEmpty")}</p>
                  <p className="text-[11px] font-medium leading-5">{t("macroForm.stepsEmptyHint")}</p>
                </div>
              </div>
            ) : (
              <div className="grid gap-2">
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
          </Surface>
        </div>

        <div className="glass-divider flex flex-col gap-3 border-t p-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs font-medium leading-5 text-muted-foreground">{saveHint}</p>
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" className="sm:min-w-[120px]" onClick={onCancel} disabled={isSaving}>
              {t("macroForm.cancel")}
            </Button>
            <Button className="sm:min-w-[160px]" type="submit" disabled={!canSubmit}>
              {isSaving ? <Loader2 className="spin" size={17} /> : form.id ? <Save size={17} /> : <Check size={17} />}
              {form.id ? t("macroForm.saveChanges") : t("macroForm.createMacro")}
            </Button>
          </div>
        </div>
      </form>
    </Surface>
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
  value,
  widthClassName
}: AffixedInputProps): JSX.Element {
  return (
    <label
      className={cn(
        "glass-control flex h-8 min-w-0 items-center overflow-hidden rounded-md focus-within:border-ring/30 focus-within:ring-2 focus-within:ring-ring/20",
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
    <div className="glass-control grid gap-2 rounded-md p-2.5 md:grid-cols-[auto_128px_minmax(0,1fr)_auto] md:items-center">
      <span className="grid size-7 shrink-0 place-items-center rounded-md bg-background/35 text-[11px] font-bold text-muted-foreground">
        {index + 1}
      </span>

      <Select
        className="h-8"
        value={step.type}
        onChange={(event) => onUpdate(createStep(event.target.value as MacroStep["type"], step.id))}
        disabled={isSaving}
        aria-label={t("macroForm.stepType")}
      >
        {macroStepTypeOrder.map((type) => (
          <option key={type} value={type}>
            {getMacroStepTypeLabel(type, t)}
          </option>
        ))}
      </Select>

      <MacroStepFields step={step} t={t} onUpdate={onUpdate} isSaving={isSaving} />

      <div className="flex justify-end gap-1">
        <Button
          className="h-7 w-7"
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
          className="h-7 w-7"
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
          className="h-7 w-7"
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
          className="h-8 w-28 flex-none"
          value={step.code}
          onChange={(event) =>
            onUpdate({
              ...step,
              code: event.target.value,
              label: formatMacroCode(event.target.value)
            })
          }
          disabled={isSaving}
          aria-label={t("macro.step.key")}
        >
          {commonMacroKeyCodes.map((code) => (
            <option key={code} value={code}>
              {formatMacroCode(code)}
            </option>
          ))}
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
      className={cn("h-8 w-auto min-w-[88px] shrink-0 px-2.5", isRecording && "glass-focus")}
      type="button"
      variant="outline"
      size="sm"
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

export default MacroModal;
