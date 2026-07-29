import { Check, Eraser, GripHorizontal, GripVertical, Plus, Save } from "lucide-react";
import {
  type FormEvent,
  type JSX,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { useNavigate, useParams } from "react-router";

import { EditorNotFound, EditorPage } from "../../components/EditorPage";
import { Button } from "../../components/ui/button";
import { FieldHeader, FormField, HelpPanel, Surface } from "../../components/ui/patterns";
import { areEditorFormsEqual, createNewWorkspaceForm, createWorkspaceFormState } from "../../app/editorFormState";
import type { WorkspaceFormState } from "../../app/types";
import { useUnsavedChangesGuard } from "../../hooks/useUnsavedChangesGuard";
import { getPointerDragTargetId, usePointerDrag } from "../../hooks/usePointerDrag";
import type { Translator } from "../../i18n";
import { cn } from "../../lib/utils";
import type {
  Game,
  LaunchWorkspace,
  LaunchWorkspaceSlot,
  NormalizedRect,
  Role,
  RoleStatus,
  WorkspaceLayoutTemplate
} from "../../../../shared/types";
import { workspaceLayoutTemplates } from "../../../../shared/workspaceLayout";
import {
  formatWorkspaceResizeRatio,
  snapWorkspaceResizePosition
} from "../../../../shared/workspaceResize";
import { workspaceTemplateIcons, workspaceTemplateLabelKeys } from "./workspaceConstants";
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
  mergeWorkspaceRoleZoomOverrides,
  rectToPreviewStyle,
  swapWorkspaceSlotRoles,
  type WorkspaceSplitAxis
} from "./workspaceLayoutUtils";

interface WorkspaceEditorRouteProps {
  games: Game[];
  isSaving: boolean;
  roles: Role[];
  statusByRole: Map<string, RoleStatus>;
  t: Translator;
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
    ? createWorkspaceFormState(selectedWorkspace)
    : createNewWorkspaceForm(props.workspaces, props.t);
  return (
    <WorkspaceEditor
      key={id ?? "new"}
      {...props}
      initialForm={initialForm}
      persistedSlots={selectedWorkspace?.slots}
    />
  );
}

function WorkspaceEditor({
  initialForm,
  games,
  isSaving,
  roles,
  statusByRole,
  t,
  onSave,
  persistedSlots
}: WorkspaceEditorRouteProps & {
  initialForm: WorkspaceFormState;
  persistedSlots?: LaunchWorkspaceSlot[];
}): JSX.Element {
  const navigate = useNavigate();
  const initialFormRef = useRef(initialForm);
  const persistedSlotsRef = useRef(persistedSlots ?? initialForm.slots);
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

  useEffect(() => {
    if (!persistedSlots || persistedSlotsRef.current === persistedSlots) {
      return;
    }

    const previousPersistedSlots = persistedSlotsRef.current;
    setForm((current) => ({
      ...current,
      slots: mergeWorkspaceRoleZoomOverrides(current.slots, previousPersistedSlots, persistedSlots)
    }));
    initialFormRef.current = {
      ...initialFormRef.current,
      slots: mergeWorkspaceRoleZoomOverrides(
        initialFormRef.current.slots,
        previousPersistedSlots,
        persistedSlots
      )
    };
    persistedSlotsRef.current = persistedSlots;
  }, [persistedSlots]);

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
}

interface WorkspaceActiveResize {
  affectedSlotIndexes: number[];
  axis: WorkspaceSplitAxis;
  splitIndex: number;
}

type WorkspacePointerDragPayload =
  | { type: "role"; roleId: string }
  | { type: "slot"; slotIndex: number };

function WorkspaceLayoutFormEditor({
  form,
  games,
  isSaving,
  onChange,
  roles,
  statusByRole,
  t
}: WorkspaceLayoutFormEditorProps): JSX.Element {
  const [activeResize, setActiveResize] = useState<WorkspaceActiveResize | null>(null);
  const [dragSlots, setDragSlots] = useState<LaunchWorkspaceSlot[] | null>(null);
  const [selectedSlotIndex, setSelectedSlotIndex] = useState(0);
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
  const workspaceDrag = usePointerDrag<WorkspacePointerDragPayload>({
    disabled: isSaving,
    getScrollContainer: (_payload, clientX, clientY) =>
      document.elementFromPoint?.(clientX, clientY)
        ?.closest<HTMLElement>("[data-workspace-role-scroll]")
      ?? document.querySelector<HTMLElement>("#app-editor-form"),
    getTargetId: (clientX, clientY) =>
      getPointerDragTargetId(clientX, clientY, "data-workspace-slot-index"),
    onDrop: (payload, targetId) => {
      const targetSlotIndex = Number(targetId);
      if (!Number.isInteger(targetSlotIndex) || targetSlotIndex < 0 || targetSlotIndex >= slots.length) {
        return;
      }
      setSelectedSlotIndex(targetSlotIndex);
      if (payload.type === "slot") {
        updateSlots(swapWorkspaceSlotRoles(slots, payload.slotIndex, targetSlotIndex));
      } else {
        updateSlots(assignRoleToWorkspaceSlot(slots, targetSlotIndex, payload.roleId));
      }
    }
  });

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
    let pendingPointerPosition: { clientX: number; clientY: number } | undefined;
    let resizeFrameId: number | undefined;
    let previousPosition = initialPosition;
    setActiveResize({ affectedSlotIndexes, axis, splitIndex });

    const applyPointerPosition = ({ clientX, clientY }: { clientX: number; clientY: number }): void => {
      const pointerPosition =
        axis === "vertical"
          ? (clientX - previewBounds.left) / previewBounds.width
          : (clientY - previewBounds.top) / previewBounds.height;
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

    const cancelScheduledResize = (): void => {
      if (resizeFrameId !== undefined) {
        window.cancelAnimationFrame(resizeFrameId);
        resizeFrameId = undefined;
      }
      pendingPointerPosition = undefined;
    };

    const flushScheduledResize = (): void => {
      if (resizeFrameId !== undefined) {
        window.cancelAnimationFrame(resizeFrameId);
        resizeFrameId = undefined;
      }
      const pointerPosition = pendingPointerPosition;
      pendingPointerPosition = undefined;
      if (pointerPosition) {
        applyPointerPosition(pointerPosition);
      }
    };

    const handlePointerMove = (pointerEvent: PointerEvent): void => {
      if (pointerEvent.pointerId !== event.pointerId) {
        return;
      }

      pendingPointerPosition = {
        clientX: pointerEvent.clientX,
        clientY: pointerEvent.clientY
      };
      if (resizeFrameId === undefined) {
        resizeFrameId = window.requestAnimationFrame(() => {
          resizeFrameId = undefined;
          const pointerPosition = pendingPointerPosition;
          pendingPointerPosition = undefined;
          if (pointerPosition) {
            applyPointerPosition(pointerPosition);
          }
        });
      }
    };

    const finishResize = (): void => {
      if (controller.signal.aborted) {
        return;
      }

      flushScheduledResize();
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

    controller.signal.addEventListener("abort", cancelScheduledResize, { once: true });
    event.currentTarget.setPointerCapture?.(event.pointerId);
    window.addEventListener("pointermove", handlePointerMove, {
      passive: true,
      signal: controller.signal
    });
    window.addEventListener("pointerup", handlePointerEnd, { signal: controller.signal });
    window.addEventListener("pointercancel", handlePointerEnd, { signal: controller.signal });
    window.addEventListener("blur", finishResize, { signal: controller.signal });
  }

  return (
    <div className="grid gap-4">
      <div className="workspace-editor-fields grid gap-4">
        <Surface className="col-span-full p-4" padding="none" variant="inset">
          <FormField
            label={t("workspaces.layout")}
            description={t("workspaces.layoutDescription")}
          >
            <div
              aria-label={t("workspaces.layout")}
              className="flex flex-wrap gap-2"
              data-workspace-layout-options
              role="group"
            >
              {workspaceLayoutTemplates.map((template) => {
                const Icon = workspaceTemplateIcons[template];
                const label = t(workspaceTemplateLabelKeys[template]);
                const isSelected = form.template === template;

                return (
                  <button
                    key={template}
                    aria-pressed={isSelected}
                    className={cn(
                      "glass-control inline-flex h-[30px] min-h-[var(--control-min-size)] w-fit max-w-full flex-none items-center gap-1.5 rounded-md px-2.5 text-left text-[11px] font-semibold leading-none transition-[background-color,border-color,color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/25 disabled:cursor-not-allowed disabled:opacity-60",
                      isSelected
                        ? "macro-role-card-selected text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                    data-workspace-layout-option={template}
                    disabled={isSaving}
                    type="button"
                    onClick={() => handleTemplateChange(template)}
                  >
                    <Icon className="size-4 shrink-0" aria-hidden="true" />
                    <span className="min-w-0">{label}</span>
                  </button>
                );
              })}
            </div>
          </FormField>
        </Surface>

      </div>

      <Surface
        className="workspace-editor-surface grid overflow-hidden"
        padding="none"
        variant="panel"
      >
        <div className="grid gap-3 p-4">
          <div
            ref={previewRef}
            data-workspace-layout-preview
            className="relative aspect-[8/5] min-h-[320px] overflow-hidden"
          >
            {slots.map((slot, index) => {
              const role = slot.roleId ? roleById.get(slot.roleId) : undefined;

              return (
                <WorkspaceSlotDropZone
                  key={slot.id}
                  index={index}
                  isDragging={workspaceDrag.activePayload?.type === "slot" && workspaceDrag.activePayload.slotIndex === index}
                  isDropTarget={workspaceDrag.targetId === String(index) && !(
                    workspaceDrag.activePayload?.type === "slot" && workspaceDrag.activePayload.slotIndex === index
                  )}
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
                  onSlotPointerDown={(event) => workspaceDrag.start(event, { type: "slot", slotIndex: index })}
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
          className="workspace-editor-sidebar flex min-h-0 flex-col border-t border-border"
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
            className="workspace-editor-role-list max-h-[clamp(320px,45vh,440px)] overflow-x-hidden overflow-y-auto"
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
                        "glass-control flex h-[52px] min-w-0 touch-none items-center gap-2 rounded-lg p-2 text-left transition-[background-color,opacity]",
                        isSelectedSlotRole && "border-primary/45 bg-primary/12 text-foreground",
                        isAssigned && !isSelectedSlotRole && "border-primary/25 bg-primary/6",
                        workspaceDrag.activePayload?.type === "role" && workspaceDrag.activePayload.roleId === role.id
                          ? "cursor-grabbing opacity-50"
                          : "cursor-grab"
                      )}
                      type="button"
                      disabled={isSaving}
                      onClick={() => handleRoleSelect(role.id)}
                      onPointerDown={(event) => workspaceDrag.start(event, { type: "role", roleId: role.id })}
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

      <div className="grid gap-4">
        <HelpPanel data-workspace-help="editing">
          <WorkspaceHelpSection title={t("workspaces.help.editingTitle")}>
            <li>{t("workspaces.help.editingAssign")}</li>
            <li>{t("workspaces.help.editingResize")}</li>
            <li>{t("workspaces.help.editingTemplate")}</li>
          </WorkspaceHelpSection>
        </HelpPanel>

        <HelpPanel data-workspace-help="launch">
          <WorkspaceHelpSection title={t("workspaces.help.launchTitle")}>
            <li>{t("workspaces.help.launchRequirements")}</li>
            <li>{t("workspaces.help.launchWindow")}</li>
          </WorkspaceHelpSection>
        </HelpPanel>

        <HelpPanel data-workspace-help="runtime">
          <WorkspaceHelpSection title={t("workspaces.help.runtimeTitle")}>
            <li>{t("workspaces.help.runtimeZoom")}</li>
            <li>{t("workspaces.help.runtimeResource")}</li>
          </WorkspaceHelpSection>
        </HelpPanel>
      </div>
    </div>
  );
}

function WorkspaceHelpSection({ children, title }: { children: ReactNode; title: string }): JSX.Element {
  return (
    <section className="grid max-w-[72ch] gap-1 text-xs leading-5 text-muted-foreground">
      <h2 className="text-[11px] font-semibold leading-5 text-foreground">{title}</h2>
      <ul className="grid list-disc gap-1 pl-4">{children}</ul>
    </section>
  );
}

interface WorkspaceSlotDropZoneProps {
  index: number;
  isDragging: boolean;
  isDropTarget: boolean;
  isSelected: boolean;
  isSaving: boolean;
  launchGameName?: string;
  onClick: () => void;
  onSlotPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  role?: Role;
  rect: NormalizedRect;
  resizeIndicator?: string;
  t: Translator;
}

function WorkspaceSlotDropZone({
  index,
  isDragging,
  isDropTarget,
  isSelected,
  isSaving,
  launchGameName,
  onClick,
  onSlotPointerDown,
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
    >
      <button
        className={cn(
          "group/slot absolute isolate flex min-h-0 flex-col justify-between overflow-hidden rounded-none border bg-cover bg-center p-3 text-left transition-[background-color,border-color,box-shadow,transform] duration-150 [--workspace-slot-radius:0px] [contain:paint]",
          role
            ? "border-border/70 bg-card/72 shadow-sm"
            : "border-border/40 bg-card/50 shadow-[inset_0_1px_0_hsl(var(--glass-highlight-muted))] hover:border-border/65 hover:bg-card/60",
          isSelected && cn("border-primary/60 shadow-none", role && "bg-primary/[0.035]"),
          isDropTarget && cn("border-primary/75 shadow-none", role && "bg-primary/10"),
          isDragging && "opacity-50"
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
            className="glass-popover absolute right-2.5 top-2.5 z-20 grid size-7 touch-none cursor-grab place-items-center rounded-md text-muted-foreground opacity-0 shadow-sm transition-[opacity,color,transform] hover:text-foreground active:cursor-grabbing active:scale-95 group-hover/slot:opacity-100"
            onPointerDown={(event) => {
              event.stopPropagation();
              onSlotPointerDown(event);
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
            className="group/resize absolute z-20 grid h-12 w-[30px] touch-none -translate-x-1/2 -translate-y-1/2 cursor-col-resize place-items-center bg-transparent focus-visible:outline-none"
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
            className="group/resize absolute z-20 grid h-[30px] w-12 touch-none -translate-x-1/2 -translate-y-1/2 cursor-row-resize place-items-center bg-transparent focus-visible:outline-none"
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
