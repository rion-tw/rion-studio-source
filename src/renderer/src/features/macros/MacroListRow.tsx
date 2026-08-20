import {
  Pointer,
  Repeat1,
  Timer,
  ToggleRight
} from "lucide-react";
import type { JSX, MouseEvent as ReactMouseEvent, RefCallback } from "react";

import { Badge } from "../../components/ui/badge";
import { ContextMenu, ContextMenuTrigger } from "../../components/ui/context-menu";
import type { Translator } from "../../i18n";
import { cn } from "../../lib/utils";
import type { Macro, MacroRunStatus, Role, RoleStatus } from "../../../../shared/types";
import {
  MacroActionMenu,
  MacroContextMenuContent,
  MacroFailureMessage,
  type MacroListRunActionState,
  MacroRoleBadge,
  MacroRunButton
} from "./MacroListControls";
import {
  formatMacroActivationMode,
  formatMacroIntervalPreset,
  formatMacroRepeat,
  formatMacroShortcut,
  summarizeMacroSteps
} from "./macroUtils";

interface MacroListRowProps {
  busyMacroIds: ReadonlySet<string>;
  isSelected: boolean;
  macro: Macro;
  macroNameById: Map<string, string>;
  macroStatusByRun: Map<string, MacroRunStatus>;
  onCopy: () => void;
  onDelete: () => void;
  onEdit: () => void;
  onSelectionClick: (event: ReactMouseEvent<HTMLElement>) => void;
  onSetEnabled?: (enabled: boolean) => void;
  onStartMacro: (macroId: string) => void;
  onStopMacro: (macroId: string) => void;
  roleById: Map<string, Role>;
  runState: MacroListRunActionState;
  selectionRef: RefCallback<HTMLElement>;
  showExecutionRoles: boolean;
  statusByRole: Map<string, RoleStatus>;
  t: Translator;
}

export function MacroListRow({
  busyMacroIds,
  isSelected,
  macro,
  macroNameById,
  macroStatusByRun,
  onCopy,
  onDelete,
  onEdit,
  onSelectionClick,
  onSetEnabled,
  onStartMacro,
  onStopMacro,
  roleById,
  runState,
  selectionRef,
  showExecutionRoles,
  statusByRole,
  t
}: MacroListRowProps): JSX.Element {
  const isActive = runState.isRunning || runState.isStopping;
  const rowTone = isActive
    ? "bg-activity/[0.08]"
    : macro.roleIds.length === 0
      ? "bg-warning/35"
      : isSelected
        ? "bg-activity/10"
        : undefined;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <tr
          ref={selectionRef}
          className={cn(
            "macro-list-row group align-middle transition-[background-color,box-shadow,opacity]",
            rowTone,
            !macro.enabled && "opacity-[0.55]"
          )}
          data-macro-active={isActive ? "true" : undefined}
          data-macro-disabled={!macro.enabled ? "true" : undefined}
          data-macro-id={macro.id}
          data-macro-unassigned={macro.roleIds.length === 0 ? "true" : undefined}
          data-selection-id={macro.id}
          tabIndex={-1}
          onClickCapture={onSelectionClick}
        >
          <td className="macro-list-column-name px-3 py-2 align-middle">
            <div className="flex min-w-0 items-start gap-2" data-macro-name-control>
              <div className="flex h-5 shrink-0 items-center" data-macro-run-control>
                <MacroRunButton
                  macro={macro}
                  runState={runState}
                  t={t}
                  onStartMacro={onStartMacro}
                  onStopMacro={onStopMacro}
                />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <button
                    className={cn(
                      "min-w-0 max-w-full rounded-sm text-left text-body font-medium leading-5 transition-colors hover:text-activity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20 disabled:cursor-not-allowed",
                      macro.enabled ? "text-foreground" : "text-muted-foreground"
                    )}
                    type="button"
                    title={t("macros.edit")}
                    disabled={isActive}
                    onClick={onEdit}
                  >
                    <span className="block truncate">{macro.name}</span>
                  </button>
                  <MacroStatusBadge runState={runState} t={t} />
                </div>
                <MacroFailureMessage
                  macro={macro}
                  macroStatusByRun={macroStatusByRun}
                  roleById={roleById}
                  t={t}
                />
              </div>
            </div>
          </td>

          {showExecutionRoles ? (
            <td className="macro-list-column-roles px-3 py-2 align-middle">
              <MacroRoleBadge
                macro={macro}
                roleById={roleById}
                statusByRole={statusByRole}
                t={t}
              />
            </td>
          ) : null}

          <td className="macro-list-column-shortcut px-3 py-2 align-middle">
            <div className="macro-list-row-shortcut flex min-w-0 flex-wrap items-center gap-2">
              <MacroShortcutIndicator macro={macro} t={t} />
              {macro.trigger && macro.shortcutSourceScope.type === "selected_roles" ? (
                <MacroRoleBadge
                  macro={macro}
                  roleIds={macro.shortcutSourceScope.roleIds}
                  roleById={roleById}
                  statusByRole={statusByRole}
                  t={t}
                />
              ) : null}
            </div>
          </td>

          <td className="macro-list-column-repeat px-3 py-2 align-middle text-muted-foreground">
            <div className="min-w-0">
              <MacroRepeatIndicator macro={macro} t={t} />
            </div>
          </td>

          <td className="macro-list-column-steps px-3 py-2 align-middle">
            <div
              className="min-w-0 truncate text-body leading-5 text-muted-foreground"
              title={summarizeMacroSteps(macro.steps, t, macroNameById)}
            >
              {summarizeMacroSteps(macro.steps, t, macroNameById)}
            </div>
          </td>

          <td className="macro-list-column-actions px-2 py-2 align-middle">
            <div className="flex items-center justify-end" data-macro-actions-control>
              <MacroActionMenu
                busyMacroIds={busyMacroIds}
                macro={macro}
                isActive={isActive}
                onCopy={onCopy}
                onDelete={onDelete}
                onEdit={onEdit}
                onSetEnabled={onSetEnabled}
                t={t}
              />
            </div>
          </td>
        </tr>
      </ContextMenuTrigger>
      <MacroContextMenuContent
        busyMacroIds={busyMacroIds}
        macro={macro}
        isActive={isActive}
        onCopy={onCopy}
        onDelete={onDelete}
        onEdit={onEdit}
        onSetEnabled={onSetEnabled}
        t={t}
      />
    </ContextMenu>
  );
}

function MacroStatusBadge({
  runState,
  t
}: {
  runState: MacroListRunActionState;
  t: Translator;
}): JSX.Element | null {
  if (runState.isStopping) {
    return <Badge variant="activity">{t("macros.status.stopping")}</Badge>;
  }
  if (runState.isRunning) {
    return <Badge variant="activity">{t("macros.status.running")}</Badge>;
  }

  switch (runState.disabledReason) {
    case "noRoles":
      return <Badge variant="warning">{t("macros.status.unassigned")}</Badge>;
    case "unassignedDependency":
      return <Badge variant="warning">{t("macros.status.unassignedDependency")}</Badge>;
    case "macroDisabled":
      return <Badge variant="muted">{t("macros.status.disabled")}</Badge>;
    case "rolesNotRunning":
      return null;
    case "automationUnavailable":
      return <Badge variant="warning">{t("macros.status.automationUnavailable")}</Badge>;
    default:
      return <Badge variant="outline">{t("macros.status.ready")}</Badge>;
  }
}

function MacroShortcutIndicator({ macro, t }: { macro: Macro; t: Translator }): JSX.Element | null {
  if (!macro.trigger) {
    return <span className="text-caption text-muted-foreground">{t("macros.noShortcutShort")}</span>;
  }

  const isWhileHeld = macro.activationMode === "while_held";
  const activationLabel = formatMacroActivationMode(macro.activationMode, t);
  const shortcutLabel = formatMacroShortcut(macro.trigger, t);

  return (
    <span className="inline-flex h-5 min-w-0 items-center gap-1.5 text-muted-foreground" data-macro-shortcut-indicator>
      <span aria-label={activationLabel} className="inline-flex shrink-0" role="img" title={activationLabel}>
        {isWhileHeld ? <Pointer aria-hidden="true" size={14} /> : <ToggleRight aria-hidden="true" size={14} />}
      </span>
      <span className="truncate text-body leading-5">{shortcutLabel}</span>
    </span>
  );
}

function MacroRepeatIndicator({ macro, t }: { macro: Macro; t: Translator }): JSX.Element {
  const label = formatMacroRepeat(macro.repeat, t);
  const delayLabel = macro.repeat.type === "loop"
    ? macro.repeat.intervalMs === 0
      ? t("macroForm.intervalMilliseconds").replace("{value}", "0")
      : formatMacroIntervalPreset(macro.repeat.intervalMs, t)
    : undefined;

  return (
    <span
      aria-label={label}
      className="inline-flex h-5 min-w-0 items-center gap-1.5 whitespace-nowrap"
      data-macro-repeat-indicator
      role="img"
      title={label}
    >
      {macro.repeat.type === "loop" ? (
        <>
          <Timer aria-hidden="true" size={14} />
          <span aria-hidden="true" className="truncate text-body leading-5 tabular-nums">{delayLabel}</span>
        </>
      ) : (
        <>
          <Repeat1 aria-hidden="true" size={14} />
          <span aria-hidden="true" className="truncate text-body leading-5">{label}</span>
        </>
      )}
    </span>
  );
}
