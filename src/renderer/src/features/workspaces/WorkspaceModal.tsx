import { Check, Eraser, GripVertical, Loader2, Save, X } from "lucide-react";
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
import { Label } from "../../components/ui/label";
import { RoleRunDot } from "../../components/RoleRunDot";
import { FieldHeader, Surface } from "../../components/ui/patterns";
import type { WorkspaceFormState } from "../../app/types";
import type { Translator } from "../../i18n";
import { cn } from "../../lib/utils";
import type { LaunchWorkspaceSlot, NormalizedRect, Role, RoleStatus, WorkspaceLayoutTemplate } from "../../../../shared/types";
import { workspaceLayoutTemplates } from "../../../../shared/workspaceLayout";
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
    <div className="fixed inset-0 z-50 grid place-items-center p-5">
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
    <Surface className="flex max-h-[calc(100vh-4rem)] flex-col overflow-hidden text-card-foreground" radius="lg" variant="modal">
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
        <div className="grid gap-4 overflow-auto p-5">
          <Surface className="grid gap-2" padding="md" variant="inset">
            <Label className="max-w-2xl">
              <span>{t("workspaceForm.name")}</span>
              <Input
                value={form.name}
                onChange={(event) => onChange({ ...form, name: event.target.value })}
                required
                maxLength={80}
                placeholder={t("workspaceForm.namePlaceholder")}
              />
            </Label>
          </Surface>

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
  const [selectedSlotIndex, setSelectedSlotIndex] = useState(0);
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
    event.dataTransfer.setData("application/x-rion-workspace-slot", String(slotIndex));
    event.dataTransfer.setData("text/plain", `slot:${slotIndex}`);
    event.dataTransfer.effectAllowed = "move";
  }

  function handleRoleDragStart(event: ReactDragEvent, roleId: string): void {
    event.dataTransfer.setData("application/x-rion-role", roleId);
    event.dataTransfer.setData("text/plain", `role:${roleId}`);
    event.dataTransfer.effectAllowed = "copyMove";
  }

  function handleSlotDrop(event: ReactDragEvent, slotIndex: number): void {
    event.preventDefault();
    event.stopPropagation();
    setSelectedSlotIndex(slotIndex);
    const sourceSlotIndex = readWorkspaceSlotDragIndex(event);
    const roleId = readRoleDragId(event);

    if (sourceSlotIndex !== undefined) {
      updateSlots(swapWorkspaceSlotRoles(slots, sourceSlotIndex, slotIndex));
      return;
    }

    if (roleId) {
      updateSlots(assignRoleToWorkspaceSlot(slots, slotIndex, roleId));
    }
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
    <Surface className="grid gap-4" padding="lg" variant="inset">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <FieldHeader title={t("workspaces.layout")} description={t("workspaces.layoutDescription")} />
        <div className="grid grid-cols-4 gap-2">
          {workspaceLayoutTemplates.map((template) => {
            const Icon = workspaceTemplateIcons[template];
            const isActive = form.template === template;

            return (
              <button
                key={template}
                className={cn(
                  "glass-control flex h-[30px] w-8 items-center justify-center rounded-md text-muted-foreground transition-colors",
                  isActive && "border-primary/35 bg-primary/10 text-foreground"
                )}
                type="button"
                title={t(workspaceTemplateLabelKeys[template])}
                aria-label={t(workspaceTemplateLabelKeys[template])}
                aria-pressed={isActive}
                onClick={() => handleTemplateChange(template)}
                disabled={isSaving}
              >
                <Icon size={18} />
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
        <div
          ref={previewRef}
          className="relative aspect-[16/9] min-h-[340px] overflow-hidden rounded-md border border-border/60 bg-background/30"
        >
          {slots.map((slot, index) => {
            const role = slot.roleId ? roleById.get(slot.roleId) : undefined;

            return (
              <WorkspaceSlotDropZone
                key={slot.id}
                index={index}
                isActive={role ? statusByRole.has(role.id) : false}
                isSelected={index === selectedSlotIndex}
                isSaving={isSaving}
                role={role}
                rect={slot.rect}
                t={t}
                onClick={() => setSelectedSlotIndex(index)}
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
                    className={cn(
                      "glass-control flex min-w-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors",
                      isSelectedSlotRole && "border-primary/45 bg-primary/12 text-foreground",
                      isAssigned && !isSelectedSlotRole && "border-primary/25 bg-primary/6"
                    )}
                    type="button"
                    draggable={!isSaving}
                    disabled={isSaving}
                    onClick={() => handleRoleSelect(role.id)}
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
    </Surface>
  );
}

interface WorkspaceSlotDropZoneProps {
  index: number;
  isActive: boolean;
  isSelected: boolean;
  isSaving: boolean;
  onClick: () => void;
  onDrop: (event: ReactDragEvent) => void;
  onSlotDragStart: (event: ReactDragEvent) => void;
  role?: Role;
  rect: NormalizedRect;
  t: Translator;
}

function WorkspaceSlotDropZone({
  index,
  isActive,
  isSelected,
  isSaving,
  onClick,
  onDrop,
  onSlotDragStart,
  role,
  rect,
  t
}: WorkspaceSlotDropZoneProps): JSX.Element {
  return (
    <div
      className="absolute p-1.5"
      style={rectToPreviewStyle(rect)}
      onDragEnter={(event) => event.preventDefault()}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      }}
      onDrop={onDrop}
    >
      <button
        className={cn(
          "relative flex h-full min-h-0 w-full flex-col justify-between overflow-hidden rounded-md border bg-card/72 bg-cover bg-center p-3 text-left shadow-sm transition-colors",
          role ? "border-border" : "border-dashed border-muted-foreground/35",
          isSelected && "border-primary/70 shadow-lg ring-2 ring-primary/35"
        )}
        type="button"
        draggable={Boolean(role) && !isSaving}
        disabled={isSaving}
        style={createWorkspaceSlotBackground(role)}
        onClick={onClick}
        onDragStart={onSlotDragStart}
      >
        {role?.coverImageDataUrl ? <div className="absolute inset-0 bg-black/10" /> : null}
        <div className="relative z-10 flex min-w-0 items-start justify-between gap-2">
          <p className="rounded-sm bg-background/58 px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-normal text-muted-foreground backdrop-blur-md">
            {t("workspaces.slot").replace("{index}", String(index + 1))}
          </p>
          <GripVertical className="shrink-0 text-muted-foreground" size={15} />
        </div>

        <div className="workspace-slot-caption">
          <p className="workspace-slot-name-chip flex min-w-0 items-center gap-1.5 px-2 py-1 text-sm font-semibold">
            {role ? (
              <>
                <RoleRunDot
                  className="size-2 border-white/75"
                  isActive={isActive}
                  label={t(isActive ? "role.statusDot.active" : "role.statusDot.inactive")}
                />
                <span className="min-w-0 truncate">{role.name}</span>
              </>
            ) : (
              <span className="min-w-0 truncate">{t("workspaces.emptySlot")}</span>
            )}
          </p>
        </div>
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

  if (splits.vertical.length === 0 && splits.horizontal.length === 0) {
    return null;
  }

  return (
    <>
      {splits.vertical.map((position, index) => (
        <button
          key={`vertical-${index}`}
          className="absolute top-0 z-20 h-full w-3 -translate-x-1/2 cursor-col-resize bg-transparent"
          type="button"
          aria-label={`Resize columns ${index + 1}`}
          style={{ left: `${position * 100}%` }}
          onPointerDown={(event) => onResizeStart(event, "vertical", index)}
        >
          <span className="mx-auto block h-full w-0.5 rounded-full bg-primary/45" />
        </button>
      ))}

      {splits.horizontal.map((position, index) => (
        <button
          key={`horizontal-${index}`}
          className="absolute z-20 h-3 -translate-y-1/2 cursor-row-resize bg-transparent"
          type="button"
          aria-label={`Resize rows ${index + 1}`}
          style={{
            left: template === "main_left_stack_right" ? `${splitX * 100}%` : 0,
            top: `${position * 100}%`,
            width: template === "main_left_stack_right" ? `${(1 - splitX) * 100}%` : "100%"
          }}
          onPointerDown={(event) => onResizeStart(event, "horizontal", index)}
        >
          <span className="block h-0.5 w-full rounded-full bg-primary/45" />
        </button>
      ))}
    </>
  );
}

export default WorkspaceModal;
