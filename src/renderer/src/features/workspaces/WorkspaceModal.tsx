import { Check, Eraser, GripHorizontal, GripVertical, Plus, Save } from "lucide-react";
import {
  type DragEvent as ReactDragEvent,
  type FormEvent,
  type JSX,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { useNavigate, useParams } from "react-router";

import { EditorNotFound, EditorPage } from "../../components/EditorPage";
import { Button } from "../../components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { FieldHeader, FormField, Surface } from "../../components/ui/patterns";
import { areEditorFormsEqual, createNewWorkspaceForm, createWorkspaceFormState } from "../../app/editorFormState";
import type { WorkspaceFormState } from "../../app/types";
import { useUnsavedChangesGuard } from "../../hooks/useUnsavedChangesGuard";
import type { Translator } from "../../i18n";
import { cn } from "../../lib/utils";
import type {
  Game,
  InheritableBrowserLaunchMode,
  LaunchWorkspace,
  LaunchWorkspaceSlot,
  NormalizedRect,
  Role,
  RoleStatus,
  WorkspaceDisplayInfo,
  WorkspaceBrowserZoomPercent,
  WorkspaceLayoutTemplate,
  WorkspaceResourceMode
} from "../../../../shared/types";
import {
  workspaceBrowserZoomPercents,
  workspaceLayoutTemplates
} from "../../../../shared/workspaceLayout";
import {
  formatWorkspaceResizeRatio,
  snapWorkspaceResizePosition
} from "../../../../shared/workspaceResize";
import {
  createWorkspaceDisplayTarget,
  resolveWorkspaceDisplayTarget
} from "../../../../shared/workspaceDisplays";
import { workspaceTemplateIcons, workspaceTemplateLabelKeys } from "./workspaceConstants";
import { formatWorkspaceDisplayLabel } from "./workspaceDisplayUtils";
import {
  applyWorkspaceSplits,
  applyWorkspaceTemplate,
  assignRoleToWorkspaceSlot,
  createWorkspaceSlotBackground,
  getWorkspaceHorizontalResizeHandles,
  getWorkspaceResizeAffectedSlotIndexes,
  getWorkspaceSplitRange,
  getWorkspaceSplits,
  getWorkspaceVerticalResizeHandles,
  readRoleDragId,
  readWorkspaceSlotDragIndex,
  rectToPreviewStyle,
  swapWorkspaceSlotRoles,
  type WorkspaceSplitAxis
} from "./workspaceLayoutUtils";

const FOLLOW_APP_DISPLAY_SELECT_VALUE = "__follow_app_display__";
const UNAVAILABLE_DISPLAY_SELECT_VALUE = "__unavailable_display__";

interface WorkspaceEditorRouteProps {
  games: Game[];
  isSaving: boolean;
  roles: Role[];
  statusByRole: Map<string, RoleStatus>;
  t: Translator;
  workspaceDisplays: WorkspaceDisplayInfo[];
  workspaces: LaunchWorkspace[];
  onSave: (form: WorkspaceFormState) => Promise<LaunchWorkspace | undefined>;
}

function WorkspaceEditorRoute(props: WorkspaceEditorRouteProps): JSX.Element {
  const { id } = useParams();
  const navigate = useNavigate();
  const selectedWorkspace = id ? props.workspaces.find((workspace) => workspace.id === id) : undefined;

  if (id && !selectedWorkspace) {
    return (
      <EditorNotFound
        title={props.t("editor.notFound.title")}
        description={props.t("editor.notFound.workspace")}
        actionLabel={props.t("editor.back.workspaces")}
        onAction={() => navigate("/workspaces", { replace: true })}
      />
    );
  }

  const initialForm = selectedWorkspace
    ? createWorkspaceFormState(selectedWorkspace, props.workspaceDisplays)
    : createNewWorkspaceForm(props.workspaces, props.t);
  return <WorkspaceEditor key={id ?? "new"} {...props} initialForm={initialForm} />;
}

function WorkspaceEditor({
  initialForm,
  games,
  isSaving,
  roles,
  statusByRole,
  t,
  workspaceDisplays,
  onSave
}: WorkspaceEditorRouteProps & { initialForm: WorkspaceFormState }): JSX.Element {
  const navigate = useNavigate();
  const initialFormRef = useRef(initialForm);
  const [form, setForm] = useState(initialForm);
  const isDirty = !areEditorFormsEqual(initialFormRef.current, form);
  const canSubmit = form.name.trim().length > 0;
  const confirmationOptions = useMemo(() => ({
    title: t("confirm.unsaved.title"),
    description: t("confirm.unsaved.description"),
    cancelLabel: t("confirm.unsaved.continue"),
    confirmLabel: t("confirm.unsaved.discard"),
    tone: "destructive" as const
  }), [t]);
  const allowNavigation = useUnsavedChangesGuard(isDirty, confirmationOptions, isSaving);

  function handleCancel(): void {
    navigate("/workspaces", { replace: true });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const savedWorkspace = await onSave(form);
    if (savedWorkspace) {
      allowNavigation();
      navigate("/workspaces", { replace: true });
    }
  }

  return (
    <EditorPage
      backActionLabel={t("editor.back")}
      backLabel={t("editor.back.workspaces")}
      canSubmit={canSubmit}
      description={form.id ? t("workspaceForm.description.edit") : t("workspaceForm.description.new")}
      isSaving={isSaving}
      onCancel={handleCancel}
      onSubmit={(event) => void handleSubmit(event)}
      onTitleChange={(name) => setForm((current) => ({ ...current, name }))}
      saveIcon={form.id ? <Save size={16} /> : <Check size={16} />}
      saveLabel={form.id ? t("workspaceForm.saveChanges") : t("workspaceForm.createWorkspace")}
      title={form.name}
      titleAriaLabel={t("workspaceForm.name")}
      titlePlaceholder={t("workspaceForm.namePlaceholder")}
    >
      <WorkspaceLayoutFormEditor
        form={form}
        games={games}
        isSaving={isSaving}
        roles={roles}
        statusByRole={statusByRole}
        t={t}
        workspaceDisplays={workspaceDisplays}
        onChange={setForm}
      />
    </EditorPage>
  );
}

interface WorkspaceLayoutFormEditorProps {
  form: WorkspaceFormState;
  games: Game[];
  isSaving: boolean;
  onChange: (form: WorkspaceFormState) => void;
  roles: Role[];
  statusByRole: Map<string, RoleStatus>;
  t: Translator;
  workspaceDisplays: WorkspaceDisplayInfo[];
}

interface WorkspaceActiveResize {
  affectedSlotIndexes: number[];
  axis: WorkspaceSplitAxis;
  splitIndex: number;
}

function WorkspaceLayoutFormEditor({
  form,
  games,
  isSaving,
  onChange,
  roles,
  statusByRole,
  t,
  workspaceDisplays
}: WorkspaceLayoutFormEditorProps): JSX.Element {
  const [activeResize, setActiveResize] = useState<WorkspaceActiveResize | null>(null);
  const [dragSlots, setDragSlots] = useState<LaunchWorkspaceSlot[] | null>(null);
  const [dropTargetSlotIndex, setDropTargetSlotIndex] = useState<number | null>(null);
  const [selectedSlotIndex, setSelectedSlotIndex] = useState(0);
  const dragPayloadRef = useRef<{ roleId?: string; slotIndex?: number } | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const resizeAbortRef = useRef<AbortController | null>(null);
  const roleById = useMemo(() => new Map(roles.map((role) => [role.id, role])), [roles]);
  const gameNameById = useMemo(() => new Map(games.map((game) => [game.id, game.name])), [games]);
  const slots = dragSlots ?? form.slots;
  const assignedSlotByRoleId = new Map(
    slots.flatMap((slot, index) => (slot.roleId ? [[slot.roleId, index] as const] : []))
  );
  const selectedSlot = slots[selectedSlotIndex] ?? slots[0];
  const selectedSlotLabel = t("workspaces.slot").replace("{index}", String(selectedSlotIndex + 1));
  const resolvedTargetDisplay = resolveWorkspaceDisplayTarget(form.targetDisplay, workspaceDisplays);
  const targetDisplaySelectValue = !form.targetDisplay
    ? FOLLOW_APP_DISPLAY_SELECT_VALUE
    : resolvedTargetDisplay
      ? String(resolvedTargetDisplay.id)
      : UNAVAILABLE_DISPLAY_SELECT_VALUE;

  useEffect(() => {
    resizeAbortRef.current?.abort();
    resizeAbortRef.current = null;
    setActiveResize(null);
    setDragSlots(null);
  }, [form.id, form.template, form.slots]);

  useEffect(() => () => resizeAbortRef.current?.abort(), []);

  useEffect(() => {
    setSelectedSlotIndex((current) => Math.min(current, Math.max(form.slots.length - 1, 0)));
  }, [form.slots.length]);

  function updateSlots(nextSlots: LaunchWorkspaceSlot[]): void {
    onChange({
      ...form,
      slots: nextSlots
    });
  }

  function handleTemplateChange(template: WorkspaceLayoutTemplate): void {
    const nextSlots = applyWorkspaceTemplate(slots, template);

    onChange({
      ...form,
      template,
      slots: nextSlots
    });
    setSelectedSlotIndex((current) => Math.min(current, Math.max(nextSlots.length - 1, 0)));
  }

  function handleRoleSelect(roleId: string): void {
    updateSlots(assignRoleToWorkspaceSlot(slots, selectedSlotIndex, roleId));
  }

  function handleClearSelectedSlot(): void {
    updateSlots(assignRoleToWorkspaceSlot(slots, selectedSlotIndex, undefined));
  }

  function handleSlotDragStart(event: ReactDragEvent, slotIndex: number): void {
    dragPayloadRef.current = { slotIndex };
    event.dataTransfer.setData("application/x-rion-workspace-slot", String(slotIndex));
    event.dataTransfer.setData("text/plain", `slot:${slotIndex}`);
    event.dataTransfer.effectAllowed = "move";
  }

  function handleRoleDragStart(event: ReactDragEvent, roleId: string): void {
    dragPayloadRef.current = { roleId };
    event.dataTransfer.setData("application/x-rion-role", roleId);
    event.dataTransfer.setData("text/plain", `role:${roleId}`);
    event.dataTransfer.effectAllowed = "copyMove";
  }

  function handleSlotDrop(event: ReactDragEvent, slotIndex: number): void {
    event.preventDefault();
    event.stopPropagation();
    setSelectedSlotIndex(slotIndex);
    setDropTargetSlotIndex(null);
    const sourceSlotIndex = readWorkspaceSlotDragIndex(event) ?? dragPayloadRef.current?.slotIndex;
    const roleId = readRoleDragId(event) ?? dragPayloadRef.current?.roleId;
    dragPayloadRef.current = null;

    if (sourceSlotIndex !== undefined) {
      updateSlots(swapWorkspaceSlotRoles(slots, sourceSlotIndex, slotIndex));
      return;
    }

    if (roleId) {
      updateSlots(assignRoleToWorkspaceSlot(slots, slotIndex, roleId));
    }
  }

  function handleDragEnd(): void {
    dragPayloadRef.current = null;
    setDropTargetSlotIndex(null);
  }

  function startResize(
    event: ReactPointerEvent<HTMLButtonElement>,
    axis: WorkspaceSplitAxis,
    splitIndex: number
  ): void {
    if (!previewRef.current) {
      return;
    }

    event.preventDefault();
    const previewBounds = previewRef.current.getBoundingClientRect();
    const initialSplits = getWorkspaceSplits(form.template, slots);
    const splitRange = getWorkspaceSplitRange(form.template, initialSplits, axis, splitIndex);
    const initialPosition = initialSplits[axis][splitIndex];
    if (initialPosition === undefined) {
      return;
    }

    resizeAbortRef.current?.abort();
    const controller = new AbortController();
    resizeAbortRef.current = controller;
    const affectedSlotIndexes = getWorkspaceResizeAffectedSlotIndexes(form.template, slots, axis, splitIndex);
    let nextSlots = slots;
    let previousPosition = initialPosition;
    setActiveResize({ affectedSlotIndexes, axis, splitIndex });

    const handlePointerMove = (pointerEvent: PointerEvent): void => {
      if (pointerEvent.pointerId !== event.pointerId) {
        return;
      }

      const pointerPosition =
        axis === "vertical"
          ? (pointerEvent.clientX - previewBounds.left) / previewBounds.width
          : (pointerEvent.clientY - previewBounds.top) / previewBounds.height;
      const nextSplits = {
        horizontal: [...initialSplits.horizontal],
        vertical: [...initialSplits.vertical]
      };

      const snappedPosition = snapWorkspaceResizePosition(pointerPosition, {
        initialPosition,
        max: splitRange.max,
        min: splitRange.min,
        previousPosition
      });
      if (Math.abs(snappedPosition - previousPosition) < 0.000_001) {
        return;
      }

      previousPosition = snappedPosition;
      nextSplits[axis][splitIndex] = snappedPosition;
      nextSlots = applyWorkspaceSplits(form.template, slots, nextSplits);
      setDragSlots(nextSlots);
    };

    const finishResize = (): void => {
      if (controller.signal.aborted) {
        return;
      }

      controller.abort();
      if (resizeAbortRef.current === controller) {
        resizeAbortRef.current = null;
      }
      setActiveResize(null);
      setDragSlots(null);

      if (nextSlots !== slots) {
        updateSlots(nextSlots);
      }
    };

    const handlePointerEnd = (pointerEvent: PointerEvent): void => {
      if (pointerEvent.pointerId === event.pointerId) {
        finishResize();
      }
    };

    event.currentTarget.setPointerCapture?.(event.pointerId);
    window.addEventListener("pointermove", handlePointerMove, { signal: controller.signal });
    window.addEventListener("pointerup", handlePointerEnd, { signal: controller.signal });
    window.addEventListener("pointercancel", handlePointerEnd, { signal: controller.signal });
    window.addEventListener("blur", finishResize, { signal: controller.signal });
  }

  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-3 gap-4">
        <Surface className="p-4" padding="none" variant="inset">
          <FormField htmlFor="workspace-browser-mode" label={t("workspaces.browserMode")} description={t("workspaces.browserModeDescription")}>
            <Select value={form.browserLaunchMode} disabled={isSaving} onValueChange={(value) => onChange({ ...form, browserLaunchMode: value as InheritableBrowserLaunchMode })}>
              <SelectTrigger id="workspace-browser-mode"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="inherit">{t("games.mode.inherit")}</SelectItem><SelectItem value="auto">{t("games.mode.auto")}</SelectItem><SelectItem value="embedded">{t("games.mode.embedded")}</SelectItem><SelectItem value="external">{t("games.mode.external")}</SelectItem></SelectContent>
            </Select>
          </FormField>
        </Surface>

        <Surface className="p-4" padding="none" variant="inset">
          <FormField
            htmlFor="workspace-layout-template"
            label={t("workspaces.layout")}
            description={t("workspaces.layoutDescription")}
          >
            <Select
              value={form.template}
              onValueChange={(value) => handleTemplateChange(value as WorkspaceLayoutTemplate)}
              disabled={isSaving}
            >
              <SelectTrigger id="workspace-layout-template">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {workspaceLayoutTemplates.map((template) => {
                  const Icon = workspaceTemplateIcons[template];
                  const label = t(workspaceTemplateLabelKeys[template]);

                  return (
                    <SelectItem key={template} value={template} textValue={label}>
                      <Icon className="size-4 shrink-0" aria-hidden="true" />
                      <span className="truncate">{label}</span>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </FormField>
        </Surface>

        <Surface className="p-4" padding="none" variant="inset">
          <FormField
            htmlFor="workspace-browser-zoom"
            label={t("workspaces.browserZoom")}
            description={t("workspaces.browserZoomDescription")}
          >
            <Select
              value={form.browserZoomMode === "adaptive" ? "adaptive" : String(form.browserZoomPercent)}
              disabled={isSaving}
              onValueChange={(value) =>
                onChange({
                  ...form,
                  browserZoomMode: value === "adaptive" ? "adaptive" : "fixed",
                  ...(value === "adaptive"
                    ? {}
                    : { browserZoomPercent: Number(value) as WorkspaceBrowserZoomPercent })
                })
              }
            >
              <SelectTrigger id="workspace-browser-zoom">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="adaptive">{t("workspaces.browserZoomAdaptive")}</SelectItem>
                {workspaceBrowserZoomPercents.map((zoomPercent) => (
                  <SelectItem key={zoomPercent} value={String(zoomPercent)}>
                    {zoomPercent}%
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
        </Surface>

        <Surface className="p-4" padding="none" variant="inset">
          <FormField
            htmlFor="workspace-target-display"
            label={t("workspaces.targetDisplay")}
            description={t("workspaces.targetDisplayDescription")}
          >
            <Select
              value={targetDisplaySelectValue}
              disabled={isSaving}
              onValueChange={(value) => {
                if (value === FOLLOW_APP_DISPLAY_SELECT_VALUE) {
                  const { targetDisplay: _targetDisplay, ...nextForm } = form;
                  onChange(nextForm);
                  return;
                }
                const display = workspaceDisplays.find((candidate) => candidate.id === Number(value));
                if (display) {
                  onChange({ ...form, targetDisplay: createWorkspaceDisplayTarget(display) });
                }
              }}
            >
              <SelectTrigger id="workspace-target-display">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={FOLLOW_APP_DISPLAY_SELECT_VALUE}>
                  {t("workspaces.targetDisplayFollowApp")}
                </SelectItem>
                {form.targetDisplay && !resolvedTargetDisplay ? (
                  <SelectItem value={UNAVAILABLE_DISPLAY_SELECT_VALUE} disabled>
                    {t("workspaces.targetDisplayUnavailable").replace("{id}", String(form.targetDisplay.id))}
                  </SelectItem>
                ) : null}
                {workspaceDisplays.map((display, index) => (
                  <SelectItem key={display.id} value={String(display.id)}>
                    {formatWorkspaceDisplayLabel(display, index, t)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
        </Surface>

        <Surface className="p-4" padding="none" variant="inset">
          <FormField
            htmlFor="workspace-resource-mode"
            label={t("workspaces.resourceMode")}
            description={t("workspaces.resourceModeDescription")}
          >
            <Select
              value={form.resourcePolicy.mode}
              disabled={isSaving}
              onValueChange={(value) => onChange({
                ...form,
                resourcePolicy: { mode: value as WorkspaceResourceMode }
              })}
            >
              <SelectTrigger id="workspace-resource-mode"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="adaptive">{t("workspaces.resourceModeAdaptive")}</SelectItem>
                <SelectItem value="unrestricted">{t("workspaces.resourceModeUnrestricted")}</SelectItem>
              </SelectContent>
            </Select>
          </FormField>
        </Surface>
      </div>

      <Surface
        className="grid overflow-hidden min-[1180px]:grid-cols-[minmax(0,1fr)_270px]"
        padding="none"
        variant="panel"
      >
        <div className="grid gap-3 p-4">
          <div
            ref={previewRef}
            className="relative aspect-[16/9] min-h-[280px] overflow-hidden"
          >
            {slots.map((slot, index) => {
              const role = slot.roleId ? roleById.get(slot.roleId) : undefined;

              return (
                <WorkspaceSlotDropZone
                  key={slot.id}
                  index={index}
                  isDropTarget={index === dropTargetSlotIndex}
                  isSelected={index === selectedSlotIndex}
                  isSaving={isSaving}
                  launchGameName={role ? gameNameById.get(role.gameId) : undefined}
                  role={role}
                  rect={slot.rect}
                  resizeIndicator={
                    activeResize?.affectedSlotIndexes.includes(index)
                      ? formatWorkspaceResizeRatio(slot.rect)
                      : undefined
                  }
                  t={t}
                  onClick={() => setSelectedSlotIndex(index)}
                  onDragEnd={handleDragEnd}
                  onDragEnter={() => setDropTargetSlotIndex(index)}
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = dragPayloadRef.current?.slotIndex === undefined ? "copy" : "move";
                    setDropTargetSlotIndex(index);
                  }}
                  onDrop={(event) => handleSlotDrop(event, index)}
                  onSlotDragStart={(event) => handleSlotDragStart(event, index)}
                />
              );
            })}

            <WorkspaceResizeHandles
              activeResize={activeResize}
              template={form.template}
              slots={slots}
              t={t}
              onResizeStart={startResize}
            />
          </div>
        </div>

        <div
          data-workspace-role-panel
          className="flex min-h-0 flex-col border-t border-border min-[1180px]:overflow-hidden min-[1180px]:border-l min-[1180px]:border-t-0 min-[1180px]:[contain:size]"
        >
          <div className="flex shrink-0 items-start justify-between gap-3 p-4 pb-3">
            <FieldHeader
              title={t("workspaces.rolePicker")}
              description={t("workspaces.rolePickerDescription").replace("{slot}", selectedSlotLabel)}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              title={t("workspaces.clearSelectedSlot")}
              aria-label={t("workspaces.clearSelectedSlot")}
              onClick={handleClearSelectedSlot}
              disabled={isSaving || !selectedSlot?.roleId}
            >
              <Eraser size={15} />
            </Button>
          </div>
          <div
            data-workspace-role-scroll
            className="max-h-[clamp(320px,45vh,440px)] overflow-x-hidden overflow-y-auto min-[1180px]:min-h-0 min-[1180px]:max-h-none min-[1180px]:flex-1"
          >
            <div
              data-workspace-role-list
              className="grid auto-rows-max content-start gap-2 px-4 pb-4 pt-0.5"
            >
              {roles.length === 0 ? (
                <p className="text-xs leading-5 text-muted-foreground">{t("workspaces.noRoles")}</p>
              ) : (
                roles.map((role) => {
                  const assignedSlotIndex = assignedSlotByRoleId.get(role.id);
                  const isAssigned = assignedSlotIndex !== undefined;
                  const isSelectedSlotRole = selectedSlot?.roleId === role.id;
                  const status = statusByRole.get(role.id);
                  const launchGameName = gameNameById.get(role.gameId) ?? role.launchUrl;

                  return (
                    <button
                      key={role.id}
                      data-workspace-role-id={role.id}
                      className={cn(
                        "glass-control flex h-[52px] min-w-0 items-center gap-2 rounded-lg p-2 text-left transition-colors",
                        isSelectedSlotRole && "border-primary/45 bg-primary/12 text-foreground",
                        isAssigned && !isSelectedSlotRole && "border-primary/25 bg-primary/6"
                      )}
                      type="button"
                      draggable={!isSaving}
                      disabled={isSaving}
                      onClick={() => handleRoleSelect(role.id)}
                      onDragEnd={handleDragEnd}
                      onDragStart={(event) => handleRoleDragStart(event, role.id)}
                    >
                      <div
                        className="size-8 shrink-0 rounded-md bg-cover bg-center ring-1 ring-inset ring-border/60"
                        style={createWorkspaceSlotBackground(role)}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="min-w-0 truncate text-xs font-semibold">
                          <span className="min-w-0 truncate">{role.name}</span>
                        </p>
                        <p className="mt-0.5 truncate text-[10px] font-medium text-muted-foreground">
                          {launchGameName}
                          {status ? ` · ${t("status.running")}` : ""}
                        </p>
                      </div>
                      {isAssigned ? (
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-sm bg-background/40 px-1.5 py-1 text-[11px] font-semibold text-muted-foreground">
                          {isSelectedSlotRole ? <Check size={13} /> : null}
                          {t("workspaces.slotShort").replace("{index}", String(assignedSlotIndex + 1))}
                        </span>
                      ) : null}
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </div>
      </Surface>
    </div>
  );
}

interface WorkspaceSlotDropZoneProps {
  index: number;
  isDropTarget: boolean;
  isSelected: boolean;
  isSaving: boolean;
  launchGameName?: string;
  onClick: () => void;
  onDragEnd: () => void;
  onDragEnter: () => void;
  onDragOver: (event: ReactDragEvent) => void;
  onDrop: (event: ReactDragEvent) => void;
  onSlotDragStart: (event: ReactDragEvent) => void;
  role?: Role;
  rect: NormalizedRect;
  resizeIndicator?: string;
  t: Translator;
}

function WorkspaceSlotDropZone({
  index,
  isDropTarget,
  isSelected,
  isSaving,
  launchGameName,
  onClick,
  onDragEnd,
  onDragEnter,
  onDragOver,
  onDrop,
  onSlotDragStart,
  role,
  rect,
  resizeIndicator,
  t
}: WorkspaceSlotDropZoneProps): JSX.Element {
  const resolvedLaunchGameName = launchGameName ?? role?.launchUrl ?? "";
  const slotInsetStyle = {
    top: rect.y > 0 ? 10 : 0,
    right: rect.x + rect.width < 0.999 ? 10 : 0,
    bottom: rect.y + rect.height < 0.999 ? 10 : 0,
    left: rect.x > 0 ? 10 : 0
  };

  return (
    <div
      className="absolute"
      style={rectToPreviewStyle(rect)}
      onDragEnter={(event) => {
        event.preventDefault();
        onDragEnter();
      }}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <button
        className={cn(
          "group/slot absolute isolate flex min-h-0 flex-col justify-between overflow-hidden rounded-none border bg-cover bg-center p-3 text-left transition-[background-color,border-color,box-shadow,transform] duration-150 [--workspace-slot-radius:0px] [contain:paint]",
          role
            ? "border-border/70 bg-card/72 shadow-sm"
            : "border-border/40 bg-card/50 shadow-[inset_0_1px_0_hsl(var(--glass-highlight-muted))] hover:border-border/65 hover:bg-card/60",
          isSelected && cn("border-primary/60 shadow-none", role && "bg-primary/[0.035]"),
          isDropTarget && cn("border-primary/75 shadow-none", role && "bg-primary/10")
        )}
        type="button"
        aria-pressed={isSelected}
        data-workspace-assigned-role-id={role?.id ?? ""}
        data-workspace-slot-index={index}
        disabled={isSaving}
        style={{ ...slotInsetStyle, ...createWorkspaceSlotBackground(role) }}
        onClick={onClick}
      >
        {role?.coverImageDataUrl ? <div className="absolute inset-0 bg-black/10" /> : null}
        {resizeIndicator ? (
          <span
            className="glass-popover pointer-events-none absolute left-1/2 top-2.5 z-30 -translate-x-1/2 whitespace-nowrap rounded-full border border-primary/35 px-2 py-1 text-[10px] font-semibold leading-none text-foreground shadow-md backdrop-blur-md"
            data-workspace-resize-indicator
          >
            {resizeIndicator}
          </span>
        ) : null}
        <div className="relative z-10 flex min-w-0 items-start gap-2">
          <p className="rounded-md border border-border/35 bg-background/45 px-2 py-1 text-[11px] font-semibold leading-none text-muted-foreground backdrop-blur-md">
            {t("workspaces.slot").replace("{index}", String(index + 1))}
          </p>
        </div>

        {role ? (
          <span
            data-workspace-slot-drag-handle
            className="glass-popover absolute right-2.5 top-2.5 z-20 grid size-7 cursor-grab place-items-center rounded-md text-muted-foreground opacity-0 shadow-sm transition-[opacity,color,transform] hover:text-foreground active:cursor-grabbing active:scale-95 group-hover/slot:opacity-100"
            draggable={!isSaving}
            onDragEnd={onDragEnd}
            onDragStart={(event) => {
              event.stopPropagation();
              onSlotDragStart(event);
            }}
          >
            <GripVertical size={14} />
          </span>
        ) : null}

        {role ? (
          <div className="workspace-slot-caption">
            <p className="workspace-slot-name-chip flex min-w-0 text-sm font-semibold">
              <span className="workspace-role-chip-text">
                <span className="min-w-0 truncate">{role.name}</span>
                <span className="workspace-role-game-label min-w-0 truncate">{resolvedLaunchGameName}</span>
              </span>
            </p>
          </div>
        ) : (
          <div className="pointer-events-none absolute inset-0 grid place-items-center p-10 text-center">
            <div className="grid justify-items-center gap-2 text-muted-foreground/75 transition-colors group-hover/slot:text-muted-foreground">
              <span className="glass-control grid size-9 place-items-center rounded-full border-border/35 bg-background/25 shadow-none">
                <Plus size={17} />
              </span>
              <span className="text-xs font-semibold">{t("workspaces.emptySlot")}</span>
            </div>
          </div>
        )}
      </button>
    </div>
  );
}

interface WorkspaceResizeHandlesProps {
  activeResize: WorkspaceActiveResize | null;
  onResizeStart: (
    event: ReactPointerEvent<HTMLButtonElement>,
    axis: WorkspaceSplitAxis,
    splitIndex: number
  ) => void;
  slots: LaunchWorkspaceSlot[];
  t: Translator;
  template: WorkspaceLayoutTemplate;
}

function WorkspaceResizeHandles({
  activeResize,
  onResizeStart,
  slots,
  t,
  template
}: WorkspaceResizeHandlesProps): JSX.Element | null {
  const splits = getWorkspaceSplits(template, slots);
  const verticalHandles = getWorkspaceVerticalResizeHandles(template, splits);
  const horizontalHandles = getWorkspaceHorizontalResizeHandles(template, splits);

  if (splits.vertical.length === 0 && splits.horizontal.length === 0) {
    return null;
  }

  return (
    <>
      {verticalHandles.map((handle) => {
        const isActive = activeResize?.axis === "vertical" && activeResize.splitIndex === handle.splitIndex;

        return (
          <button
            key={`vertical-${handle.splitIndex}`}
            className="group/resize absolute z-20 grid h-12 w-[30px] -translate-x-1/2 -translate-y-1/2 cursor-col-resize place-items-center bg-transparent focus-visible:outline-none"
            type="button"
            aria-label={t("workspaces.resizeColumns").replace("{index}", String(handle.splitIndex + 1))}
            style={{ left: `${handle.x * 100}%`, top: `${handle.y * 100}%` }}
            onPointerDown={(event) => onResizeStart(event, "vertical", handle.splitIndex)}
          >
            <span
              className={cn(
                "glass-popover grid h-9 w-3.5 place-items-center rounded-full border-border/55 text-muted-foreground/80 shadow-sm transition-[border-color,color,transform,box-shadow] group-hover/resize:scale-105 group-hover/resize:border-primary/45 group-hover/resize:text-foreground group-focus-visible/resize:ring-2 group-focus-visible/resize:ring-ring/25",
                isActive && "scale-110 border-primary/70 text-foreground shadow-lg ring-2 ring-primary/20"
              )}
            >
              <GripVertical size={12} />
            </span>
          </button>
        );
      })}

      {horizontalHandles.map((handle, handleIndex) => {
        const isActive = activeResize?.axis === "horizontal" && activeResize.splitIndex === handle.splitIndex;

        return (
          <button
            key={`horizontal-${handle.splitIndex}-${handleIndex}`}
            className="group/resize absolute z-20 grid h-[30px] w-12 -translate-x-1/2 -translate-y-1/2 cursor-row-resize place-items-center bg-transparent focus-visible:outline-none"
            type="button"
            aria-label={t("workspaces.resizeRows").replace("{index}", String(handle.splitIndex + 1))}
            style={{
              left: `${handle.x * 100}%`,
              top: `${handle.y * 100}%`
            }}
            onPointerDown={(event) => onResizeStart(event, "horizontal", handle.splitIndex)}
          >
            <span
              className={cn(
                "glass-popover grid h-3.5 w-9 place-items-center rounded-full border-border/55 text-muted-foreground/80 shadow-sm transition-[border-color,color,transform,box-shadow] group-hover/resize:scale-105 group-hover/resize:border-primary/45 group-hover/resize:text-foreground group-focus-visible/resize:ring-2 group-focus-visible/resize:ring-ring/25",
                isActive && "scale-110 border-primary/70 text-foreground shadow-lg ring-2 ring-primary/20"
              )}
            >
              <GripHorizontal size={12} />
            </span>
          </button>
        );
      })}
    </>
  );
}

export default WorkspaceEditorRoute;
