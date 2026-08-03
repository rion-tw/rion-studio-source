// Focused implementation extracted from MacroModal.tsx.
import { AlertTriangle, CircleDot, Plus, Square, X } from "lucide-react";

import { type ClipboardEvent, type JSX, type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "../../components/ui/button";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";

import { Textarea } from "../../components/ui/textarea";

import { StatusCallout, Surface } from "../../components/ui/patterns";

import type { Translator } from "../../i18n";

import { cn } from "../../lib/utils";

import { isReservedRuntimeTabSwitchMacroTrigger } from "../../../../shared/macroShortcuts";

import { MACRO_DELAY_MAX_MS } from "../../../../shared/macroSettings";

import { canonicalizeMacroKeyModifiers } from "../../../../shared/macroKeys";

import type { Macro, MacroKeyModifier, MacroStep, MacroTrigger } from "../../../../shared/types";

import { commonMacroKeyCodes, formatMacroCode, formatMacroIntervalPreset, formatMacroStep, isMacroIntervalPreset, isValidMacroInterval, MACRO_INTERVAL_CUSTOM_VALUE, MACRO_INTERVAL_OPTIONS, isPureModifierCode } from "./macroUtils";

import { MACRO_COMMAND_MAX_STEPS, parseMacroCommand, type MacroCommandIssue, type MacroCommandParseResult } from "./macroCommandParser";

import { MODIFIERS_NONE_VALUE, getModifierComboOptions, parseModifierComboValue } from "./MacroStepEditor";

export function MacroHelpSection({ children, title }: { children: ReactNode; title: string }): JSX.Element {
  return (
    <section className="grid max-w-[72ch] gap-1 text-xs leading-5 text-muted-foreground">
      <h2 className="text-caption font-semibold text-foreground">{title}</h2>
      <ul className="grid list-disc gap-1 pl-4">{children}</ul>
    </section>
  );
}

interface MacroCommandImportDialogProps {
  currentMacroId?: string;
  existingStepCount: number;
  isOpen: boolean;
  macros: Macro[];
  onClose: () => void;
  onImport: (steps: MacroStep[]) => void;
  t: Translator;
}

export function MacroCommandImportDialog({
  currentMacroId,
  existingStepCount,
  isOpen,
  macros,
  onClose,
  onImport,
  t
}: MacroCommandImportDialogProps): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [input, setInput] = useState("");
  const maxImportSteps = Math.max(0, MACRO_COMMAND_MAX_STEPS - existingStepCount);
  const result = useMemo<MacroCommandParseResult>(
    () => parseMacroCommand(input, {
      currentMacroId,
      macros,
      maxSteps: maxImportSteps
    }),
    [currentMacroId, input, macros, maxImportSteps]
  );
  const macroNameById = useMemo(
    () => new Map(macros.map((macro) => [macro.id, macro.name])),
    [macros]
  );
  const hasStepLimitIssue = result.issues.some((issue) => issue.code === "stepLimit");
  const canImport = result.steps.length > 0 && !hasStepLimitIssue;

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setInput("");
  }, [isOpen]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }

    if (isOpen && !dialog.open) {
      dialog.showModal();
    } else if (!isOpen && dialog.open) {
      dialog.close();
    }
  }, [isOpen]);

  function handleImport(): void {
    if (!canImport) {
      return;
    }

    onImport(result.steps);
  }

  return (
    <dialog
      ref={dialogRef}
      aria-describedby="macro-command-import-description"
      aria-labelledby="macro-command-import-title"
      className="app-dialog m-auto w-[min(720px,calc(100vw-2rem))] max-w-none border-0 bg-transparent p-0 text-foreground"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
    >
      <Surface className="grid max-h-[calc(100vh-2rem)] gap-4 overflow-auto p-5" radius="lg" variant="modal">
        <div className="grid gap-1.5">
          <h2 id="macro-command-import-title" className="text-title font-semibold">
            {t("macroForm.commandImport.title")}
          </h2>
          <p id="macro-command-import-description" className="text-control font-medium text-muted-foreground">
            {t("macroForm.commandImport.description")}
          </p>
        </div>

        <Textarea
          aria-label={t("macroForm.commandImport.input")}
          autoFocus
          className="min-h-28 font-mono text-caption"
          placeholder={t("macroForm.commandImport.placeholder")}
          rows={5}
          value={input}
          onChange={(event) => setInput(event.target.value)}
        />

        <div className="grid gap-2">
          <div className="flex items-center justify-between gap-3">
            <p className="text-control font-semibold text-foreground">
              {t("macroForm.commandImport.preview")}
            </p>
            <p className="text-caption font-medium text-muted-foreground">
              {t("macroForm.commandImport.stepCount")
                .replace("{count}", String(result.steps.length))
                .replace("{remaining}", String(maxImportSteps))}
            </p>
          </div>

          {result.steps.length > 0 ? (
            <ol className="glass-control grid max-h-44 gap-1 overflow-auto rounded-sm p-2 text-caption font-medium text-muted-foreground">
              {result.steps.map((step, index) => (
                <li key={step.id} className="flex gap-2">
                  <span className="w-5 shrink-0 text-right text-micro text-muted-foreground/70">
                    {index + 1}.
                  </span>
                  <span className="min-w-0 break-words text-foreground">
                    {formatMacroStep(step, t, macroNameById)}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <div className="glass-control rounded-sm border border-dashed border-border/60 p-3 text-caption font-medium text-muted-foreground">
              {t("macroForm.commandImport.noSteps")}
            </div>
          )}
        </div>

        {result.issues.length > 0 ? (
          <StatusCallout className="grid gap-2 p-3" tone="warning">
            <p className="text-xs font-semibold text-foreground">
              {t("macroForm.commandImport.warnings")}
            </p>
            <ul className="grid gap-1 text-caption font-medium text-muted-foreground">
              {result.issues.map((issue, index) => (
                <li key={`${issue.code}-${issue.token}-${index}`}>
                  {formatMacroCommandIssue(issue, t)}
                </li>
              ))}
            </ul>
          </StatusCallout>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            {t("macroForm.cancel")}
          </Button>
          <Button type="button" disabled={!canImport} onClick={handleImport}>
            <Plus size={14} />
            {t("macroForm.commandImport.confirm").replace("{count}", String(result.steps.length))}
          </Button>
        </div>
      </Surface>
    </dialog>
  );
}

function formatMacroCommandIssue(issue: MacroCommandIssue, t: Translator): string {
  switch (issue.code) {
    case "callToggle":
      return t("macroForm.commandImport.warning.callToggle").replace("{name}", issue.detail ?? issue.token);
    case "invalidClick":
      return t("macroForm.commandImport.warning.invalidClick").replace("{token}", issue.token);
    case "invalidKeyCombination":
      return t("macroForm.commandImport.warning.invalidKeyCombination").replace("{token}", issue.token);
    case "invalidWait":
      return t("macroForm.commandImport.warning.invalidWait").replace("{token}", issue.token);
    case "missingMacro":
      return t("macroForm.commandImport.warning.missingMacro").replace("{name}", issue.detail ?? issue.token);
    case "stepLimit":
      return t("macroForm.commandImport.warning.stepLimit").replace("{limit}", issue.detail ?? "0");
    case "unclosedQuote":
      return t("macroForm.commandImport.warning.unclosedQuote");
    case "unavailableMacro":
      return t("macroForm.commandImport.warning.unavailableMacro").replace("{name}", issue.detail ?? issue.token);
    case "unknownCommand":
      return t("macroForm.commandImport.warning.unknownCommand").replace("{token}", issue.token);
    case "unknownKey":
      return t("macroForm.commandImport.warning.unknownKey").replace("{token}", issue.token);
    case "unsupported":
      return t("macroForm.commandImport.warning.unsupported").replace("{token}", issue.token);
  }
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

export function AffixedInput({
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
        "glass-control flex h-[var(--control-height)] min-w-0 items-center overflow-hidden rounded-md focus-within:border-ring/30 focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring/20",
        widthClassName
      )}
    >
      {prefix ? (
        <span className="pointer-events-none shrink-0 pl-2.5 text-body font-normal text-muted-foreground">
          {prefix}
        </span>
      ) : null}
      <input
        aria-label={ariaLabel}
        className="h-full min-w-0 flex-1 bg-transparent px-2 text-body font-semibold leading-none text-foreground focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-45"
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
        <span className="pointer-events-none shrink-0 pr-2.5 text-body font-normal text-muted-foreground">
          {suffix}
        </span>
      ) : null}
    </label>
  );
}

export function MacroIntervalControl({
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
            widthClassName="h-[var(--control-height)] min-w-0 flex-1"
            onChange={(next) => onChange(fromDisplayTime(next, unit))}
          />
          <TimeUnitSelect disabled={disabled} t={t} unit={unit} onChange={setUnit} />
        </div>
      ) : null}
      {isValidMacroInterval(value) && value < 250 ? (
        <p
          className="flex items-start gap-1.5 text-caption font-medium text-warning-foreground"
          role="status"
        >
          <AlertTriangle className="mt-px shrink-0" size={14} aria-hidden="true" />
          <span>{t("macroForm.intervalLowWarning")}</span>
        </p>
      ) : null}
    </div>
  );
}

export type TimeUnit = "ms" | "s" | "min" | "h" | "d";

const TIME_UNIT_FACTORS: Record<TimeUnit, number> = {
  ms: 1,
  s: 1_000,
  min: 60_000,
  h: 3_600_000,
  d: 86_400_000
};

export function getTimeUnitMax(unit: TimeUnit): number {
  return MACRO_DELAY_MAX_MS / TIME_UNIT_FACTORS[unit];
}

export function getTimeUnitStep(unit: TimeUnit): number {
  return unit === "ms" ? 1 : 0.001;
}

export function toDisplayTime(ms: number, unit: TimeUnit): number {
  return unit === "ms" ? ms : Number((ms / TIME_UNIT_FACTORS[unit]).toFixed(3));
}

export function fromDisplayTime(value: number, unit: TimeUnit): number {
  return Math.round(value * TIME_UNIT_FACTORS[unit]);
}

export function TimeUnitSelect({
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

export function ShortcutRecorder({ onChange, t, trigger }: ShortcutRecorderProps): JSX.Element {
  const [isRecording, setIsRecording] = useState(false);
  const selectedCode = trigger?.code ?? "";
  const selectedModifiers = getMacroTriggerModifiers(trigger);
  const modifierOptions = getModifierComboOptions(t).filter((option) => !isReservedRuntimeTabSwitchMacroTrigger({
    code: selectedCode,
    ...getMacroTriggerModifierFlags(parseModifierComboValue(option.value))
  }));
  const keyCodes = commonMacroKeyCodes.filter((code) => !isReservedRuntimeTabSwitchMacroTrigger({
    code,
    ...getMacroTriggerModifierFlags(selectedModifiers)
  }));
  const selectedModifierValue = selectedModifiers.length > 0
    ? selectedModifiers.join(",")
    : MODIFIERS_NONE_VALUE;
  const mainKeyIsModifier = isPureModifierCode(selectedCode);

  function updateShortcut(code: string, modifiers: MacroKeyModifier[]): void {
    if (!code) {
      return;
    }

    const nextTrigger = {
      code,
      ...getMacroTriggerModifierFlags(modifiers)
    };
    if (isReservedRuntimeTabSwitchMacroTrigger(nextTrigger)) {
      return;
    }
    onChange(nextTrigger);
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

      const nextTrigger = {
        code: event.code,
        ...getMacroTriggerModifierFlags([
          ...(event.ctrlKey ? ["ctrl" as const] : []),
          ...(event.altKey ? ["alt" as const] : []),
          ...(event.shiftKey ? ["shift" as const] : []),
          ...(event.metaKey ? ["meta" as const] : [])
        ])
      };
      if (!isReservedRuntimeTabSwitchMacroTrigger(nextTrigger)) {
        onChange(nextTrigger);
      }
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
          {modifierOptions.map((option) => (
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
          {keyCodes.map((code) => (
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

export function RecordingButton({
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
