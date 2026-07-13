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
import { Select } from "../../components/ui/select";
import { launchUrlOptions } from "../../app/constants";
import { FieldHeader, FormField, Surface } from "../../components/ui/patterns";
import { areEditorFormsEqual, createNewWorkspaceForm, createWorkspaceFormState } from "../../app/editorFormState";
import type { WorkspaceFormState } from "../../app/types";
import { useUnsavedChangesGuard } from "../../hooks/useUnsavedChangesGuard";
import type { Translator } from "../../i18n";
import { cn } from "../../lib/utils";
import type {
  LaunchWorkspace,
  LaunchWorkspaceSlot,
  NormalizedRect,
  Role,
  RoleStatus,
  WorkspaceBrowserZoomPercent,
  WorkspaceLayoutTemplate
} from "../../../../shared/types";
import {
  getDefaultWorkspaceBrowserZoomPercent,
  workspaceBrowserZoomPercents,
  workspaceLayoutTemplates
} from "../../../../shared/workspaceLayout";
import { workspaceTemplateIcons, workspaceTemplateLabelKeys } from "./workspaceConstants";
import {
  applyWorkspaceSplits,
  applyWorkspaceTemplate,
  assignRoleToWorkspaceSlot,
  clamp,
  createWorkspaceSlotBackground,
  getWorkspaceSplitRange,
  getWorkspaceSplits,
  readRoleDragId,
  readWorkspaceSlotDragIndex,
  rectToPreviewStyle,
  swapWorkspaceSlotRoles,
  type WorkspaceSplitAxis
} from "./workspaceLayoutUtils";

interface WorkspaceEditorRouteProps {
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
  return <WorkspaceEditor key={id ?? "new"} {...props} initialForm={initialForm} />;
}

function WorkspaceEditor({
  initialForm,
  isSaving,
  roles,
  statusByRole,
  t,
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
      backLabel={t("editor.back.workspaces")}
      cancelLabel={t("workspaceForm.cancel")}
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
  isSaving: boolean;
  onChange: (form: WorkspaceFormState) => void;
  roles: Role[];
  statusByRole: Map<string, RoleStatus>;
  t: Translator;
}

function WorkspaceLayoutFormEditor({
  form,
  isSaving,
  onChange,
  roles,
  statusByRole,
  t
}: WorkspaceLayoutFormEditorProps): JSX.Element {
  const [dragSlots, setDragSlots] = useState<LaunchWorkspaceSlot[] | null>(null);
  const [dropTargetSlotIndex, setDropTargetSlotIndex] = useState<number | null>(null);
  const [selectedSlotIndex, setSelectedSlotIndex] = useState(0);
  const dragPayloadRef = useRef<{ roleId?: string; slotIndex?: number } | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const roleById = useMemo(() => new Map(roles.map((role) => [role.id, role])), [roles]);
  const slots = dragSlots ?? form.slots;
  const assignedSlotByRoleId = new Map(
    slots.flatMap((slot, index) => (slot.roleId ? [[slot.roleId, index] as const] : []))
  );
  const selectedSlot = slots[selectedSlotIndex] ?? slots[0];
  const selectedSlotLabel = t("workspaces.slot").replace("{index}", String(selectedSlotIndex + 1));

  useEffect(() => {
    setDragSlots(null);
  }, [form.id, form.template, form.slots]);

  useEffect(() => {
    setSelectedSlotIndex((current) => Math.min(current, Math.max(form.slots.length - 1, 0)));
  }, [form.slots.length]);

  function updateSlots(nextSlots: LaunchWorkspaceSlot[]): void {
    onChange({ ...form, slots: nextSlots });
  }

  function handleTemplateChange(template: WorkspaceLayoutTemplate): void {
    const nextSlots = applyWorkspaceTemplate(slots, template);

    onChange({
      ...form,
      template,
      browserZoomPercent: getDefaultWorkspaceBrowserZoomPercent(template),
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
    let nextSlots = slots;

    const handlePointerMove = (pointerEvent: PointerEvent): void => {
      const pointerPosition =
        axis === "vertical"
          ? (pointerEvent.clientX - previewBounds.left) / previewBounds.width
          : (pointerEvent.clientY - previewBounds.top) / previewBounds.height;
      const nextSplits = {
        horizontal: [...initialSplits.horizontal],
        vertical: [...initialSplits.vertical]
      };

      nextSplits[axis][splitIndex] = clamp(pointerPosition, splitRange.min, splitRange.max);
      nextSlots = applyWorkspaceSplits(form.template, slots, nextSplits);
      setDragSlots(nextSlots);
    };

    const handlePointerUp = (): void => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      setDragSlots(null);

      if (nextSlots !== slots) {
        updateSlots(nextSlots);
      }
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  }

  return (
    <div className="grid gap-4">
      <div className="grid gap-4 min-[1180px]:grid-cols-[minmax(240px,1.3fr)_minmax(150px,0.7fr)]">
        <Surface className="p-4" padding="none" variant="inset">
          <FormField label={t("workspaces.layout")} description={t("workspaces.layoutDescription")}>
            <div className="grid grid-cols-7 gap-1.5">
              {workspaceLayoutTemplates.map((template) => {
                const Icon = workspaceTemplateIcons[template];
                const isActive = form.template === template;

                return (
                  <button
                    key={template}
                    className={cn(
                      "glass-control flex h-[30px] min-w-0 items-center justify-center rounded-md text-muted-foreground transition-[background-color,border-color,color,box-shadow]",
                      isActive ? "glass-control-selected text-foreground" : "hover:bg-accent/35 hover:text-foreground"
                    )}
                    type="button"
                    title={t(workspaceTemplateLabelKeys[template])}
                    aria-label={t(workspaceTemplateLabelKeys[template])}
                    aria-pressed={isActive}
                    onClick={() => handleTemplateChange(template)}
                    disabled={isSaving}
                  >
                    <Icon size={17} />
                  </button>
                );
              })}
            </div>
          </FormField>
        </Surface>

        <Surface className="p-4" padding="none" variant="inset">
          <FormField
            htmlFor="workspace-browser-zoom"
            label={t("workspaces.browserZoom")}
            description={t("workspaces.browserZoomDescription")}
          >
            <Select
              id="workspace-browser-zoom"
              value={form.browserZoomPercent}
              disabled={isSaving}
              onChange={(event) =>
                onChange({
                  ...form,
                  browserZoomPercent: Number(event.target.value) as WorkspaceBrowserZoomPercent
                })
              }
            >
              {workspaceBrowserZoomPercents.map((zoomPercent) => (
                <option key={zoomPercent} value={zoomPercent}>
                  {zoomPercent}%
                </option>
              ))}
            </Select>
          </FormField>
        </Surface>
      </div>

      <div className="grid gap-4 min-[1180px]:grid-cols-[minmax(0,1fr)_270px]">
        <Surface className="p-4" padding="none" variant="panel">
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
                  role={role}
                  rect={slot.rect}
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

            <WorkspaceResizeHandles template={form.template} slots={slots} onResizeStart={startResize} />
          </div>
        </Surface>

        <Surface className="grid content-start gap-3 p-4" padding="none" variant="panel">
          <div className="flex items-start justify-between gap-3">
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
          <div className="grid max-h-[360px] gap-2 overflow-auto pr-1">
            {roles.length === 0 ? (
              <p className="text-xs leading-5 text-muted-foreground">{t("workspaces.noRoles")}</p>
            ) : (
              roles.map((role) => {
                const assignedSlotIndex = assignedSlotByRoleId.get(role.id);
                const isAssigned = assignedSlotIndex !== undefined;
                const isSelectedSlotRole = selectedSlot?.roleId === role.id;
                const status = statusByRole.get(role.id);
                const launchGameName = resolveWorkspaceRoleLaunchGameName(role.launchUrl, t);

                return (
                  <button
                    key={role.id}
                    data-workspace-role-id={role.id}
                    className={cn(
                      "glass-control flex min-w-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors",
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
                      className="size-8 shrink-0 rounded-md border border-border/60 bg-cover bg-center"
                      style={createWorkspaceSlotBackground(role)}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="min-w-0 truncate text-xs font-semibold">
                        <span className="min-w-0 truncate">{role.name}</span>
                      </p>
                      <p className="mt-0.5 truncate text-[11px] font-medium text-muted-foreground">
                        {launchGameName}
                        {" · "}
                        {role.authState === "authenticated" ? t("role.auth.authenticated") : t("role.auth.needsLogin")}
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
        </Surface>
      </div>
    </div>
  );
}

interface WorkspaceSlotDropZoneProps {
  index: number;
  isDropTarget: boolean;
  isSelected: boolean;
  isSaving: boolean;
  onClick: () => void;
  onDragEnd: () => void;
  onDragEnter: () => void;
  onDragOver: (event: ReactDragEvent) => void;
  onDrop: (event: ReactDragEvent) => void;
  onSlotDragStart: (event: ReactDragEvent) => void;
  role?: Role;
  rect: NormalizedRect;
  t: Translator;
}

function WorkspaceSlotDropZone({
  index,
  isDropTarget,
  isSelected,
  isSaving,
  onClick,
  onDragEnd,
  onDragEnter,
  onDragOver,
  onDrop,
  onSlotDragStart,
  role,
  rect,
  t
}: WorkspaceSlotDropZoneProps): JSX.Element {
  const launchGameName = role ? resolveWorkspaceRoleLaunchGameName(role.launchUrl, t) : "";
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
          "group/slot absolute isolate flex min-h-0 flex-col justify-between overflow-hidden rounded-lg border bg-cover bg-center p-3 text-left transition-[background-color,border-color,box-shadow,transform] duration-150 [--workspace-slot-radius:0.5rem] [contain:paint]",
          role
            ? "border-border/70 bg-card/72 shadow-sm"
            : "border-border/40 bg-card/35 shadow-[inset_0_1px_0_hsl(var(--glass-highlight-muted))] hover:border-border/65 hover:bg-card/50",
          isSelected && "border-primary/60 bg-primary/[0.035] shadow-none",
          isDropTarget && "border-primary/75 bg-primary/10 shadow-none"
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
                <span className="workspace-role-game-label min-w-0 truncate">{launchGameName}</span>
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
  onResizeStart: (
    event: ReactPointerEvent<HTMLButtonElement>,
    axis: WorkspaceSplitAxis,
    splitIndex: number
  ) => void;
  slots: LaunchWorkspaceSlot[];
  template: WorkspaceLayoutTemplate;
}

function WorkspaceResizeHandles({ onResizeStart, slots, template }: WorkspaceResizeHandlesProps): JSX.Element | null {
  const splits = getWorkspaceSplits(template, slots);
  const splitX = splits.vertical[0] ?? 1;
  const verticalHandleY = template === "quad" || template === "six_grid" ? 0.25 : 0.5;
  const horizontalHandleX =
    template === "quad" || template === "six_grid"
      ? 0.25
      : template === "main_left_stack_right"
        ? splitX + (1 - splitX) / 2
        : template === "main_right_stack_left"
          ? splitX / 2
          : 0.5;

  if (splits.vertical.length === 0 && splits.horizontal.length === 0) {
    return null;
  }

  return (
    <>
      {splits.vertical.map((position, index) => (
        <button
          key={`vertical-${index}`}
          className="group/resize absolute z-20 grid h-12 w-6 -translate-x-1/2 -translate-y-1/2 cursor-col-resize place-items-center bg-transparent focus-visible:outline-none"
          type="button"
          aria-label={`Resize columns ${index + 1}`}
          style={{ left: `${position * 100}%`, top: `${verticalHandleY * 100}%` }}
          onPointerDown={(event) => onResizeStart(event, "vertical", index)}
        >
          <span className="glass-popover grid h-9 w-3.5 place-items-center rounded-full border-border/55 text-muted-foreground/80 shadow-sm transition-[border-color,color,transform] group-hover/resize:scale-105 group-hover/resize:border-primary/45 group-hover/resize:text-foreground group-focus-visible/resize:ring-2 group-focus-visible/resize:ring-ring/25">
            <GripVertical size={12} />
          </span>
        </button>
      ))}

      {splits.horizontal.map((position, index) => (
        <button
          key={`horizontal-${index}`}
          className="group/resize absolute z-20 grid h-6 w-12 -translate-x-1/2 -translate-y-1/2 cursor-row-resize place-items-center bg-transparent focus-visible:outline-none"
          type="button"
          aria-label={`Resize rows ${index + 1}`}
          style={{
            left: `${horizontalHandleX * 100}%`,
            top: `${position * 100}%`
          }}
          onPointerDown={(event) => onResizeStart(event, "horizontal", index)}
        >
          <span className="glass-popover grid h-3.5 w-9 place-items-center rounded-full border-border/55 text-muted-foreground/80 shadow-sm transition-[border-color,color,transform] group-hover/resize:scale-105 group-hover/resize:border-primary/45 group-hover/resize:text-foreground group-focus-visible/resize:ring-2 group-focus-visible/resize:ring-ring/25">
            <GripHorizontal size={12} />
          </span>
        </button>
      ))}
    </>
  );
}

function resolveWorkspaceRoleLaunchGameName(launchUrl: string, t: Translator): string {
  const option = launchUrlOptions.find((launchOption) => launchOption.value === launchUrl);

  if (option) {
    return "labelKey" in option ? t(option.labelKey) : option.label;
  }

  try {
    return new URL(launchUrl).hostname;
  } catch {
    return t("roleForm.launchUrl.current");
  }
}

export default WorkspaceEditorRoute;
