// Focused implementation extracted from MacroModal.tsx.
import { Copy, GripVertical, Trash2 } from "lucide-react";

import { type ClipboardEvent, type JSX, type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";

import { Button } from "../../components/ui/button";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";

import type { Translator } from "../../i18n";

import { cn } from "../../lib/utils";

import { canonicalizeMacroKeyModifiers } from "../../../../shared/macroKeys";

import { convertMacroCoordinateToOffset, DEFAULT_MACRO_CLICK_ANCHOR, findNearestMacroClickAnchor, MACRO_CLICK_ANCHORS, parseMacroCoordinateClipboard } from "../../../../shared/macroCoordinates";

import { DEFAULT_MACRO_KEY_HOLD_DURATION_MS, MACRO_KEY_HOLD_DURATION_MIN_MS } from "../../../../shared/macroSettings";

import type { MacroActivationMode, MacroCallMode, MacroClickAnchor, MacroClickUnit, MacroKeyAction, MacroKeyModifier, MacroMouseButton, MacroStep } from "../../../../shared/types";

import { commonMacroKeyCodes, createClientId, formatMacroCode, formatMacroKeyCombination, formatMacroModifierLabel, type MacroTargetOption, isPureModifierCode } from "./macroUtils";

import { AffixedInput, RecordingButton, TimeUnitSelect, fromDisplayTime, getTimeUnitMax, getTimeUnitStep, toDisplayTime } from "./MacroEditorControls";

import type { TimeUnit } from "./MacroEditorControls";

interface MacroStepEditorProps {
  index: number;
  isDragging: boolean;
  isDropTarget: boolean;
  isMindMapTarget?: boolean;
  isSaving: boolean;
  macroTargetOptions: MacroTargetOption[];
  onRemove: () => void;
  onReorderPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onDuplicate: () => void;
  onUpdate: (step: MacroStep) => void;
  step: MacroStep;
  t: Translator;
}

export function MacroStepEditor({
  index,
  isDragging,
  isDropTarget,
  isMindMapTarget = false,
  isSaving,
  macroTargetOptions,
  onDuplicate,
  onRemove,
  onReorderPointerDown,
  onUpdate,
  step,
  t
}: MacroStepEditorProps): JSX.Element {
    return (
      <div
      data-testid={`macro-step-${step.id}`}
      data-macro-step-id={step.id}
      className={cn(
        "glass-divider flex flex-wrap items-center gap-2 border-b p-2.5 transition-[box-shadow,opacity] duration-200",
        isDragging && "opacity-50",
        isDropTarget && "ring-2 ring-activity/70 ring-offset-2 ring-offset-background",
        isMindMapTarget && "relative z-[1] bg-activity/8 ring-2 ring-inset ring-activity/45"
      )}
    >
      <Button
        className="touch-none cursor-grab active:cursor-grabbing"
        type="button"
        variant="ghost"
        size="icon"
        aria-label={t("macroForm.dragStep")}
        title={t("macroForm.dragStep")}
        onPointerDown={onReorderPointerDown}
        disabled={isSaving}
      >
        <GripVertical size={14} />
      </Button>

      <span className="mr-2 shrink-0 text-caption text-muted-foreground">
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

export const MODIFIERS_NONE_VALUE = "__no_modifiers__";

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

export function getModifierComboOptions(t: Translator): Array<{ value: string; label: string }> {
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

export function parseModifierComboValue(value: string): MacroKeyModifier[] {
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
  const pastedMeasurementRef = useRef<{
    measurement: NonNullable<ReturnType<typeof parseMacroCoordinateClipboard>>;
    stepId: string;
  } | undefined>(undefined);
  const isKeyStep = step.type === "key";

  useEffect(() => {
    if (!isKeyStep) {
      setIsRecording(false);
    }
  }, [isKeyStep]);

  useEffect(() => {
    if (step.type !== "click" || pastedMeasurementRef.current?.stepId !== step.id) {
      pastedMeasurementRef.current = undefined;
    }
  }, [step.id, step.type]);

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
              {(commonMacroKeyCodes.includes(step.code as typeof commonMacroKeyCodes[number])
                ? commonMacroKeyCodes
                : [step.code, ...commonMacroKeyCodes]
              ).map((code) => (
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
            onValueChange={(action) => {
              const nextAction = action as MacroKeyAction;
              const { durationMs: _durationMs, ...stepWithoutDuration } = step;
              onUpdate(nextAction === "hold_for_duration"
                ? {
                    ...stepWithoutDuration,
                    action: nextAction,
                    durationMs: step.action === "hold_for_duration"
                      ? step.durationMs ?? DEFAULT_MACRO_KEY_HOLD_DURATION_MS
                      : DEFAULT_MACRO_KEY_HOLD_DURATION_MS
                  }
                : { ...stepWithoutDuration, action: nextAction });
            }}
          >
            <SelectTrigger className="w-fit shrink-0" aria-label={t("macroForm.keyAction")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="tap">{t("macroForm.keyAction.tap")}</SelectItem>
              <SelectItem value="hold_for_duration">
                {canonicalModifiers.length > 0
                  ? t("macroForm.keyAction.holdCombinationForDuration")
                  : t("macroForm.keyAction.holdForDuration")}
              </SelectItem>
              <SelectItem value="hold_until_stop">
                {canonicalModifiers.length > 0
                  ? t("macroForm.keyAction.holdCombination")
                  : t("macroForm.keyAction.hold")}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        {step.action === "hold_for_duration" ? (
          <div className="flex min-w-0 items-center gap-2">
            <AffixedInput
              aria-label={t("macroForm.holdDuration")}
              disabled={isSaving}
              max={getTimeUnitMax(timeUnit)}
              min={toDisplayTime(MACRO_KEY_HOLD_DURATION_MIN_MS, timeUnit)}
              step={getTimeUnitStep(timeUnit)}
              suffix={timeUnit}
              value={toDisplayTime(
                step.durationMs ?? DEFAULT_MACRO_KEY_HOLD_DURATION_MS,
                timeUnit
              )}
              widthClassName="w-fit shrink-0"
              onChange={(value) => onUpdate({
                ...step,
                durationMs: fromDisplayTime(value, timeUnit)
              })}
            />
            <TimeUnitSelect
              disabled={isSaving}
              t={t}
              unit={timeUnit}
              onChange={setTimeUnit}
            />
          </div>
        ) : null}
        {mainKeyIsModifier ? (
          <p className="text-caption text-muted-foreground">
            {t("macroForm.modifiersNeedMainKey")}
          </p>
        ) : null}
      </div>
    );
  }

  if (step.type === "click") {
    const button: MacroMouseButton = step.button ?? "left";
    const unit: MacroClickUnit = step.unit ?? "percent";
    const isLegacyPixel = unit === "px";
    const isPixel = unit !== "percent";
    const anchor = step.anchor ?? DEFAULT_MACRO_CLICK_ANCHOR;
    const storedAnchor = anchor === DEFAULT_MACRO_CLICK_ANCHOR ? {} : { anchor };
    const x = step.unit === "px"
      ? step.xPx
      : step.unit === "reference-px"
        ? step.xReferencePx
        : step.xPercent;
    const y = step.unit === "px"
      ? step.yPx
      : step.unit === "reference-px"
        ? step.yReferencePx
        : step.yPercent;
    const createClickStep = (
      nextUnit: MacroClickUnit,
      nextStoredAnchor: { anchor?: MacroClickAnchor },
      nextX: number,
      nextY: number
    ): Extract<MacroStep, { type: "click" }> => {
      if (nextUnit === "px") {
        return {
          id: step.id,
          type: "click",
          ...(button === "left" ? {} : { button }),
          unit: "px",
          ...nextStoredAnchor,
          xPx: nextX,
          yPx: nextY
        };
      }
      if (nextUnit === "reference-px") {
        return {
          id: step.id,
          type: "click",
          ...(button === "left" ? {} : { button }),
          unit: "reference-px",
          ...nextStoredAnchor,
          xReferencePx: nextX,
          yReferencePx: nextY
        };
      }
      return {
        id: step.id,
        type: "click",
        ...(button === "left" ? {} : { button }),
        ...nextStoredAnchor,
        xPercent: nextX,
        yPercent: nextY
      };
    };
    const handleCoordinatePaste = (event: ClipboardEvent<HTMLInputElement>): void => {
      const measurement = parseMacroCoordinateClipboard(event.clipboardData.getData("text"));
      const pastedUnit: MacroClickUnit = measurement?.xReferencePx !== undefined &&
        measurement.yReferencePx !== undefined
        ? "reference-px"
        : unit;
      const nextAnchor = measurement?.anchor
        ?? (measurement ? findNearestMacroClickAnchor(measurement) : undefined)
        ?? anchor;
      const offset = measurement
        ? convertMacroCoordinateToOffset(measurement, nextAnchor, pastedUnit)
        : undefined;
      if (!measurement || !offset) {
        return;
      }

      event.preventDefault();
      pastedMeasurementRef.current = { measurement, stepId: step.id };
      const nextStoredAnchor = nextAnchor === DEFAULT_MACRO_CLICK_ANCHOR ? {} : { anchor: nextAnchor };
      onUpdate(createClickStep(pastedUnit, nextStoredAnchor, offset.x, offset.y));
    };
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-2 md:flex-nowrap">
        <Select
          disabled={isSaving}
          value={button}
          onValueChange={(nextButton) => onUpdate({
            ...step,
            button: nextButton === "left" ? undefined : nextButton as MacroMouseButton
          })}
        >
          <SelectTrigger aria-label={t("macroForm.mouseButton")} className="w-fit shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="left">{t("macroForm.mouseButton.left")}</SelectItem>
            <SelectItem value="middle">{t("macroForm.mouseButton.middle")}</SelectItem>
            <SelectItem value="right">{t("macroForm.mouseButton.right")}</SelectItem>
          </SelectContent>
        </Select>
        <Select
          disabled={isSaving}
          value={unit}
          onValueChange={(nextUnitValue) => {
            const nextUnit = nextUnitValue as MacroClickUnit;
            pastedMeasurementRef.current = undefined;
            onUpdate(createClickStep(nextUnit, storedAnchor, x, y));
          }}
        >
          <SelectTrigger aria-label={t("macroForm.clickUnit")} className="w-fit shrink-0"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="percent">%</SelectItem>
            <SelectItem value="reference-px">{t("macroForm.clickUnit.referencePx")}</SelectItem>
            {isLegacyPixel ? (
              <SelectItem value="px">{t("macroForm.clickUnit.legacyCssPx")}</SelectItem>
            ) : null}
          </SelectContent>
        </Select>
        <Select
          disabled={isSaving}
          value={anchor}
          onValueChange={(nextAnchor) => {
            const typedNextAnchor = nextAnchor as MacroClickAnchor;
            const nextStoredAnchor = nextAnchor === DEFAULT_MACRO_CLICK_ANCHOR
              ? {}
              : { anchor: typedNextAnchor };
            const measurement = pastedMeasurementRef.current?.stepId === step.id
              ? pastedMeasurementRef.current.measurement
              : undefined;
            const offset = measurement
              ? convertMacroCoordinateToOffset(measurement, typedNextAnchor, unit)
              : undefined;
            if (measurement && !offset) {
              pastedMeasurementRef.current = undefined;
            }
            onUpdate(createClickStep(
              unit,
              nextStoredAnchor,
              offset?.x ?? x,
              offset?.y ?? y
            ));
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
          max={isPixel ? Number.MAX_SAFE_INTEGER : 100}
          min={isPixel ? Number.MIN_SAFE_INTEGER : -100}
          prefix={t("macroForm.clickXOffset")}
          suffix={isPixel ? "px" : "%"}
          step={isPixel ? 1 : 0.01}
          value={x}
          widthClassName="w-full max-w-36 shrink-0"
          onChange={(value) => {
            pastedMeasurementRef.current = undefined;
            onUpdate(createClickStep(unit, storedAnchor, value, y));
          }}
          onPaste={handleCoordinatePaste}
        />
        <AffixedInput
          aria-label={t("macroForm.clickYOffset")}
          disabled={isSaving}
          max={isPixel ? Number.MAX_SAFE_INTEGER : 100}
          min={isPixel ? Number.MIN_SAFE_INTEGER : -100}
          prefix={t("macroForm.clickYOffset")}
          suffix={isPixel ? "px" : "%"}
          step={isPixel ? 1 : 0.01}
          value={y}
          widthClassName="w-full max-w-36 shrink-0"
          onChange={(value) => {
            pastedMeasurementRef.current = undefined;
            onUpdate(createClickStep(unit, storedAnchor, x, value));
          }}
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

export function createStep(
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
        ...(keyAction === "hold_for_duration"
          ? { durationMs: DEFAULT_MACRO_KEY_HOLD_DURATION_MS }
          : {}),
        label: "Tab"
      };
    case "click":
      return {
        id,
        type: "click",
        unit: "reference-px",
        anchor: "center",
        xReferencePx: 0,
        yReferencePx: 0
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

export function duplicateStepState(step: MacroStep): MacroStep {
  return {
    ...step,
    id: createClientId()
  };
}
