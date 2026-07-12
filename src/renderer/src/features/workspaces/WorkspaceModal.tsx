import { Check, Eraser, GripHorizontal, GripVertical, Loader2, Plus, Save, X } from "lucide-react";
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

import { Button } from "../../components/ui/button";
import { CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Select } from "../../components/ui/select";
import { RoleRunDot } from "../../components/RoleRunDot";
import { FieldHeader, FormField, FormGrid, Surface } from "../../components/ui/patterns";
import type { WorkspaceFormState } from "../../app/types";
import type { Translator } from "../../i18n";
import { cn } from "../../lib/utils";
import type {
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

interface WorkspaceModalProps {
  form: WorkspaceFormState;
  isSaving: boolean;
  onCancel: () => void;
  onChange: (form: WorkspaceFormState) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  roles: Role[];
  statusByRole: Map<string, RoleStatus>;
  t: Translator;
}

function WorkspaceModal(props: WorkspaceModalProps): JSX.Element {
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
    <div className="fixed inset-0 z-50 grid place-items-center p-4">
      <button
        className="app-modal-backdrop absolute inset-0 cursor-default"
        type="button"
        aria-label={t("workspaceForm.aria.close")}
        onClick={onCancel}
      />
      <div
        className="relative z-10 w-full max-w-6xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-form-title"
      >
        <WorkspaceForm {...props} />
      </div>
    </div>
  );
}

function WorkspaceForm({
  form,
  isSaving,
  onCancel,
  onChange,
  onSubmit,
  roles,
  statusByRole,
  t
}: WorkspaceModalProps): JSX.Element {
  return (
    <Surface className="flex max-h-[calc(100vh-2rem)] flex-col overflow-hidden text-card-foreground" radius="lg" variant="modal">
      <CardHeader className="glass-divider flex-row items-start justify-between gap-3 border-b">
        <div className="min-w-0">
          <CardTitle id="workspace-form-title">
            {form.id ? t("workspaceForm.title.edit") : t("workspaceForm.title.new")}
          </CardTitle>
          <CardDescription className="mt-1">
            {form.id ? t("workspaceForm.description.edit") : t("workspaceForm.description.new")}
          </CardDescription>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          title={t("workspaceForm.cancelTitle")}
          onClick={onCancel}
          disabled={isSaving}
        >
          <X size={17} />
        </Button>
      </CardHeader>

      <form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => onSubmit(event)}>
        <div className="grid gap-4 overflow-auto p-4 md:p-5">
          <WorkspaceLayoutFormEditor
            form={form}
            isSaving={isSaving}
            roles={roles}
            statusByRole={statusByRole}
            t={t}
            onChange={onChange}
          />
        </div>

        <div className="glass-divider flex flex-col gap-2 border-t p-4 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" className="sm:min-w-[120px]" onClick={onCancel} disabled={isSaving}>
            {t("workspaceForm.cancel")}
          </Button>
          <Button className="sm:min-w-[160px]" type="submit" disabled={isSaving}>
            {isSaving ? <Loader2 className="spin" size={17} /> : form.id ? <Save size={17} /> : <Check size={17} />}
            {form.id ? t("workspaceForm.saveChanges") : t("workspaceForm.createWorkspace")}
          </Button>
        </div>
      </form>
    </Surface>
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
      <Surface padding="md" variant="inset">
        <FormGrid
          columns={3}
          className="md:grid-cols-[minmax(220px,1.2fr)_minmax(240px,1.3fr)_minmax(150px,0.7fr)]"
        >
          <FormField htmlFor="workspace-name" label={t("workspaceForm.name")}>
            <Input
              id="workspace-name"
              value={form.name}
              onChange={(event) => onChange({ ...form, name: event.target.value })}
              required
              maxLength={80}
              placeholder={t("workspaceForm.namePlaceholder")}
            />
          </FormField>

          <FormField label={t("workspaces.layout")} description={t("workspaces.layoutDescription")}>
            <div className="grid grid-cols-5 gap-1.5">
              {workspaceLayoutTemplates.map((template) => {
                const Icon = workspaceTemplateIcons[template];
                const isActive = form.template === template;

                return (
                  <button
                    key={template}
                    className={cn(
                      "glass-control flex h-[30px] min-w-0 items-center justify-center rounded-md text-muted-foreground transition-colors",
                      isActive && "border-primary/35 bg-primary/10 text-foreground"
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
        </FormGrid>
      </Surface>

      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_270px]">
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
                isActive={role ? statusByRole.has(role.id) : false}
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

        <Surface className="grid content-start gap-3" padding="md" variant="panel">
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
                const isActive = Boolean(status);

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
                      <p className="flex min-w-0 items-center gap-1.5 text-xs font-semibold">
                        <RoleRunDot
                          isActive={isActive}
                          label={t(isActive ? "role.statusDot.active" : "role.statusDot.inactive")}
                        />
                        <span className="min-w-0 truncate">{role.name}</span>
                      </p>
                      <p className="mt-0.5 truncate text-[11px] font-medium text-muted-foreground">
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
  isActive: boolean;
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
  isActive,
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
          "group/slot absolute flex min-h-0 flex-col justify-between overflow-hidden rounded-lg border bg-cover bg-center p-3 text-left transition-[background-color,border-color,box-shadow,transform] duration-150",
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
            <p className="workspace-slot-name-chip flex min-w-0 items-center gap-1.5 px-2 py-1 text-sm font-semibold">
              <RoleRunDot
                className="size-2 border-white/75"
                isActive={isActive}
                label={t(isActive ? "role.statusDot.active" : "role.statusDot.inactive")}
              />
              <span className="min-w-0 truncate">{role.name}</span>
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
  const verticalHandleY = template === "quad" ? 0.25 : 0.5;
  const horizontalHandleX =
    template === "quad" ? 0.25 : template === "main_left_stack_right" ? splitX + (1 - splitX) / 2 : 0.5;

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

export default WorkspaceModal;
