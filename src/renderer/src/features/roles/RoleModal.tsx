import { Check, ImagePlus, Loader2, LogIn, Save, Trash2 } from "lucide-react";
import { type ChangeEvent, type FormEvent, type JSX, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";

import { EditorNotFound, EditorPage } from "../../components/EditorPage";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { FieldHeader, FormField, FormGrid, Surface } from "../../components/ui/patterns";
import { Select } from "../../components/ui/select";
import { Textarea } from "../../components/ui/textarea";
import { launchUrlOptions } from "../../app/constants";
import {
  CUSTOM_LAUNCH_URL_OPTION,
  resolveLaunchUrlFromSelection,
  resolveLaunchUrlSelection
} from "../../app/launchUrlSelection";
import { DEFAULT_ROLE_COVER_COLOR, roleCoverPlaceholderUrl } from "../../app/roleCoverPlaceholder";
import { shouldShowLoginGuidance } from "../../app/statusUtils";
import type { RoleFormState } from "../../app/types";
import { areEditorFormsEqual, createNewRoleForm, createRoleFormState } from "../../app/editorFormState";
import { useUnsavedChangesGuard } from "../../hooks/useUnsavedChangesGuard";
import type { Translator } from "../../i18n";
import type { AuthFlowStatus, LaunchPreset, Role, RoleDefaults } from "../../../../shared/types";
import { createRoleCardStyle } from "./roleCardStyle";
import { createCoverImageDataUrl } from "./roleCover";
import { LoginSessionGuide } from "./LoginSessionGuide";

interface RoleEditorRouteProps {
  authStatusByRole: Map<string, AuthFlowStatus>;
  busyRoleId: string | null;
  isSaving: boolean;
  roleDefaults: RoleDefaults;
  roles: Role[];
  t: Translator;
  onError: (error: unknown | null) => void;
  onRelogin: (roleId: string) => void;
  onSave: (form: RoleFormState) => Promise<Role | undefined>;
}

interface RoleFormProps {
  authStatus?: AuthFlowStatus;
  form: RoleFormState;
  isLoginBusy: boolean;
  isSaving: boolean;
  selectedRole?: Role;
  t: Translator;
  onChange: (form: RoleFormState | ((current: RoleFormState) => RoleFormState)) => void;
  onError: (error: unknown | null) => void;
  onRelogin: (roleId: string) => void;
}

function RoleEditorRoute(props: RoleEditorRouteProps): JSX.Element {
  const { id } = useParams();
  const navigate = useNavigate();
  const selectedRole = id ? props.roles.find((role) => role.id === id) : undefined;

  if (id && !selectedRole) {
    return (
      <EditorNotFound
        title={props.t("editor.notFound.title")}
        description={props.t("editor.notFound.role")}
        actionLabel={props.t("editor.back.roles")}
        onAction={() => navigate("/roles", { replace: true })}
      />
    );
  }

  const initialForm = selectedRole ? createRoleFormState(selectedRole) : createNewRoleForm(props.roleDefaults);
  return <RoleEditor key={id ?? "new"} {...props} initialForm={initialForm} selectedRole={selectedRole} />;
}

function RoleEditor({
  authStatusByRole,
  busyRoleId,
  initialForm,
  isSaving,
  selectedRole,
  t,
  onError,
  onRelogin,
  onSave
}: RoleEditorRouteProps & { initialForm: RoleFormState; selectedRole?: Role }): JSX.Element {
  const navigate = useNavigate();
  const initialFormRef = useRef(initialForm);
  const [form, setForm] = useState(initialForm);
  const isDirty = !areEditorFormsEqual(initialFormRef.current, form);
  const confirmationOptions = useMemo(() => ({
    title: t("confirm.unsaved.title"),
    description: t("confirm.unsaved.description"),
    cancelLabel: t("confirm.unsaved.continue"),
    confirmLabel: t("confirm.unsaved.discard"),
    tone: "destructive" as const
  }), [t]);
  const allowNavigation = useUnsavedChangesGuard(isDirty, confirmationOptions, isSaving);
  const authStatus = selectedRole ? authStatusByRole.get(selectedRole.id) : undefined;
  const isLoginBusy = Boolean(
    selectedRole && (busyRoleId === selectedRole.id || shouldShowLoginGuidance(authStatus))
  );

  function handleCancel(): void {
    navigate("/roles", { replace: true });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const savedRole = await onSave(form);
    if (savedRole) {
      allowNavigation();
      navigate("/roles", { replace: true });
    }
  }

  return (
    <EditorPage
      backLabel={t("editor.back.roles")}
      cancelLabel={t("roleForm.cancel")}
      description={form.id ? t("roleForm.description.edit") : t("roleForm.description.new")}
      isSaving={isSaving}
      onCancel={handleCancel}
      onSubmit={(event) => void handleSubmit(event)}
      saveIcon={form.id ? <Save size={16} /> : <Check size={16} />}
      saveLabel={form.id ? t("roleForm.saveChanges") : t("roleForm.createRole")}
      title={form.id ? t("roleForm.title.edit") : t("roleForm.title.new")}
      contentClassName="min-[1180px]:grid-cols-[240px_minmax(0,1fr)] min-[1180px]:items-start xl:grid-cols-[minmax(280px,340px)_minmax(0,1fr)]"
    >
      <RoleForm
        authStatus={authStatus}
        form={form}
        isLoginBusy={isLoginBusy}
        isSaving={isSaving}
        selectedRole={selectedRole}
        t={t}
        onChange={setForm}
        onError={onError}
        onRelogin={onRelogin}
      />
    </EditorPage>
  );
}

function RoleForm({
  authStatus,
  form,
  isLoginBusy,
  isSaving,
  selectedRole,
  t,
  onChange,
  onError,
  onRelogin
}: RoleFormProps): JSX.Element {
  const coverInputRef = useRef<HTMLInputElement>(null);
  const hasCoverPreview = Boolean(form.coverImageDataUrl);
  const previewStyle = createRoleCardStyle({
    color: form.coverImageDominantColor ?? DEFAULT_ROLE_COVER_COLOR,
    hasCoverImage: true,
    isActive: false
  });
  const selectedLaunchOption = launchUrlOptions.find((option) => option.value === form.launchUrl);
  const launchUrlSelection = resolveLaunchUrlSelection(
    form.launchUrl,
    launchUrlOptions.map((option) => option.value)
  );
  const isCustomLaunchUrl = launchUrlSelection === CUSTOM_LAUNCH_URL_OPTION;

  async function handleCoverImageChange(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";

    if (!file) {
      return;
    }

    try {
      const coverImage = await createCoverImageDataUrl(file);
      onChange((current) => ({ ...current, ...coverImage }));
      onError(null);
    } catch (coverError) {
      onError(coverError);
    }
  }

  function removeCoverImage(): void {
    onChange((current) => ({
      ...current,
      coverImageDataUrl: undefined,
      coverImageDominantColor: undefined
    }));
    onError(null);
  }

  return (
    <>
          <Surface className="grid gap-3 p-4" padding="none" variant="inset">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between lg:flex-col lg:items-stretch">
              <FieldHeader title={t("roleForm.cover")} description={t("roleForm.coverDescription")} />
              <div className="flex shrink-0 gap-2">
                <Button
                  className="flex-1"
                  type="button"
                  variant="outline"
                  onClick={() => coverInputRef.current?.click()}
                  disabled={isSaving}
                >
                  <ImagePlus size={15} />
                  {hasCoverPreview ? t("roleForm.coverReplace") : t("roleForm.coverChoose")}
                </Button>
                {hasCoverPreview ? (
                  <Button type="button" variant="ghost" onClick={removeCoverImage} disabled={isSaving}>
                    <Trash2 size={15} />
                    {t("roleForm.coverRemove")}
                  </Button>
                ) : null}
              </div>
            </div>

            <input
              ref={coverInputRef}
              className="sr-only"
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              onChange={(event) => void handleCoverImageChange(event)}
              disabled={isSaving}
            />

            {hasCoverPreview ? (
              <div
                className="role-cover-card relative aspect-[4/5] w-full overflow-hidden rounded-lg"
                style={previewStyle}
              >
                <div
                  className="absolute inset-0 bg-cover bg-center"
                  style={{ backgroundImage: `url("${form.coverImageDataUrl}")` }}
                />
              </div>
            ) : (
              <button
                className="role-cover-card relative aspect-[4/5] w-full overflow-hidden rounded-lg bg-cover bg-center text-left transition-colors"
                type="button"
                style={{
                  ...previewStyle,
                  backgroundImage: `url("${roleCoverPlaceholderUrl}")`
                }}
                onClick={() => coverInputRef.current?.click()}
                disabled={isSaving}
              >
                <div className="absolute inset-0 bg-black/10" />
                <div className="absolute inset-0 grid place-items-center text-center text-white">
                  <div className="grid gap-2 px-5">
                    <ImagePlus className="mx-auto drop-shadow-sm" size={24} />
                    <p className="role-cover-title text-xs font-medium">{t("roleForm.coverEmpty")}</p>
                  </div>
                </div>
              </button>
            )}
          </Surface>

          <div className="grid gap-4">
            <Surface className="grid gap-3 p-4" padding="none" variant="inset">
              <FieldHeader
                title={t("roleForm.section.identity")}
                description={t("roleForm.section.identityDescription")}
              />
              <FormGrid columns={2}>
                <FormField htmlFor="role-name" label={t("roleForm.name")}>
                  <Input
                    id="role-name"
                    value={form.name}
                    onChange={(event) => onChange((current) => ({ ...current, name: event.target.value }))}
                    required
                    maxLength={80}
                    placeholder={t("roleForm.namePlaceholder")}
                  />
                </FormField>
                <FormField htmlFor="role-launch-url" label={t("roleForm.launchUrl")}>
                  <div className="relative">
                    {selectedLaunchOption?.iconSrc ? (
                      <img
                        className="pointer-events-none absolute left-2.5 top-1/2 z-10 size-4 -translate-y-1/2 rounded-[4px] object-cover ring-1 ring-white/45"
                        src={selectedLaunchOption.iconSrc}
                        alt=""
                        aria-hidden="true"
                      />
                    ) : null}
                    <Select
                      id="role-launch-url"
                      className={selectedLaunchOption?.iconSrc ? "pl-8" : undefined}
                      value={launchUrlSelection}
                      onChange={(event) =>
                        onChange((current) => ({
                          ...current,
                          launchUrl: resolveLaunchUrlFromSelection(event.target.value)
                        }))
                      }
                      required
                    >
                      {launchUrlOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {"label" in option ? option.label : t(option.labelKey)}
                        </option>
                      ))}
                      <option value={CUSTOM_LAUNCH_URL_OPTION}>{t("roleForm.launchUrl.custom")}</option>
                    </Select>
                  </div>
                  {isCustomLaunchUrl ? (
                    <FormField htmlFor="role-custom-launch-url" label={t("roleForm.launchUrl.customUrl")}>
                      <Input
                        id="role-custom-launch-url"
                        type="url"
                        value={form.launchUrl}
                        onChange={(event) =>
                          onChange((current) => ({ ...current, launchUrl: event.target.value }))
                        }
                        required
                        maxLength={2048}
                        pattern="https?://.+"
                        placeholder={t("roleForm.launchUrl.customPlaceholder")}
                      />
                    </FormField>
                  ) : null}
                </FormField>
              </FormGrid>
            </Surface>

            <Surface className="grid gap-3 p-4" padding="none" variant="inset">
              <FieldHeader
                title={t("roleForm.section.launch")}
                description={t("roleForm.section.launchDescription")}
              />
              <FormGrid columns={3}>
                <FormField htmlFor="role-window-width" label={t("roleForm.width")}>
                  <Input
                    id="role-window-width"
                    type="number"
                    min={640}
                    max={7680}
                    value={form.windowWidth}
                    onChange={(event) =>
                      onChange((current) => ({ ...current, windowWidth: Number(event.target.value) }))
                    }
                  />
                </FormField>
                <FormField htmlFor="role-window-height" label={t("roleForm.height")}>
                  <Input
                    id="role-window-height"
                    type="number"
                    min={640}
                    max={7680}
                    value={form.windowHeight}
                    onChange={(event) =>
                      onChange((current) => ({ ...current, windowHeight: Number(event.target.value) }))
                    }
                  />
                </FormField>
                <FormField htmlFor="role-launch-preset" label={t("roleForm.launchPreset")}>
                  <Select
                    id="role-launch-preset"
                    value={form.launchPreset}
                    onChange={(event) =>
                      onChange((current) => ({ ...current, launchPreset: event.target.value as LaunchPreset }))
                    }
                  >
                    <option value="performance">{t("preset.performance")}</option>
                    <option value="balanced">{t("preset.balanced")}</option>
                  </Select>
                </FormField>
              </FormGrid>
            </Surface>

            <Surface className="grid gap-3 p-4" padding="none" variant="inset">
              <FormField htmlFor="role-notes" label={t("roleForm.notes")}>
                <Textarea
                  id="role-notes"
                  value={form.notes}
                  onChange={(event) => onChange((current) => ({ ...current, notes: event.target.value }))}
                  rows={4}
                  placeholder={t("roleForm.notesPlaceholder")}
                />
              </FormField>

              {selectedRole && shouldShowLoginGuidance(authStatus) ? (
                <LoginSessionGuide authStatus={authStatus} roleName={selectedRole.name} t={t} />
              ) : null}

              {selectedRole?.authState === "authenticated" ? (
                <Button
                  type="button"
                  variant="secondary"
                  className="w-full"
                  onClick={() => onRelogin(selectedRole.id)}
                  disabled={isSaving || isLoginBusy}
                >
                  {isLoginBusy ? <Loader2 className="spin" size={17} /> : <LogIn size={17} />}
                  {t("roleForm.relogin")}
                </Button>
              ) : null}
            </Surface>
          </div>
    </>
  );
}

export default RoleEditorRoute;
