import { Check, Eraser, ImagePlus, Loader2, Save, Trash2 } from "lucide-react";
import { type ChangeEvent, type FormEvent, type JSX, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";

import { EditorNotFound, EditorPage } from "../../components/EditorPage";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { FieldHeader, FormField, FormGrid, Surface } from "../../components/ui/patterns";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { DEFAULT_ROLE_COVER_COLOR, roleCoverPlaceholderUrl } from "../../app/roleCoverPlaceholder";
import type { RoleFormState } from "../../app/types";
import { areEditorFormsEqual, createNewRoleForm, createRoleFormState } from "../../app/editorFormState";
import { useUnsavedChangesGuard } from "../../hooks/useUnsavedChangesGuard";
import type { Translator } from "../../i18n";
import type { Game, Role } from "../../../../shared/types";
import { createRoleCardStyle } from "./roleCardStyle";
import { createCoverImageDataUrl } from "./roleCover";

interface RoleEditorRouteProps {
  busyRoleIds?: ReadonlySet<string>;
  games: Game[];
  isSaving: boolean;
  roles: Role[];
  t: Translator;
  onError: (error: unknown | null) => void;
  onClearBrowserData: (role: Role) => Promise<boolean>;
  onSave: (form: RoleFormState) => Promise<Role | undefined>;
}

interface RoleFormProps {
  form: RoleFormState;
  games: Game[];
  roles: Role[];
  isGameLocked: boolean;
  isSaving: boolean;
  selectedRole?: Role;
  t: Translator;
  onChange: (form: RoleFormState | ((current: RoleFormState) => RoleFormState)) => void;
  onClearBrowserData: (role: Role) => Promise<boolean>;
  onError: (error: unknown | null) => void;
}

function RoleEditorRoute(props: RoleEditorRouteProps): JSX.Element {
  const { id } = useParams();
  const location = useLocation();
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

  const requestedGameId = new URLSearchParams(location.search).get("gameId") ?? undefined;
  const requestedGame = props.games.find((game) => game.id === requestedGameId) ?? props.games[0];
  const initialForm = selectedRole ? createRoleFormState(selectedRole) : createNewRoleForm(requestedGame);
  return <RoleEditor key={`${id ?? "new"}:${requestedGameId ?? ""}`} {...props} initialForm={initialForm} isGameLocked={!id && Boolean(requestedGameId && requestedGame)} selectedRole={selectedRole} />;
}

function RoleEditor({
  games,
  roles,
  initialForm,
  isGameLocked,
  isSaving,
  selectedRole,
  t,
  onError,
  onClearBrowserData,
  onSave
}: RoleEditorRouteProps & { initialForm: RoleFormState; isGameLocked: boolean; selectedRole?: Role }): JSX.Element {
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
      backActionLabel={t("editor.back")}
      backLabel={t("editor.back.roles")}
      canSubmit={canSubmit}
      description={form.id ? t("roleForm.description.edit") : t("roleForm.description.new")}
      isSaving={isSaving}
      onCancel={handleCancel}
      onSubmit={(event) => void handleSubmit(event)}
      onTitleChange={(name) => setForm((current) => ({ ...current, name }))}
      saveIcon={form.id ? <Save size={16} /> : <Check size={16} />}
      saveLabel={form.id ? t("roleForm.saveChanges") : t("roleForm.createRole")}
      title={form.name}
      titleAriaLabel={t("roleForm.name")}
      titlePlaceholder={t("roleForm.namePlaceholder")}
      contentClassName="min-[1180px]:grid-cols-[minmax(0,1fr)_240px] min-[1180px]:items-start xl:grid-cols-[minmax(0,1fr)_minmax(280px,340px)]"
    >
      <RoleForm
        form={form}
        games={games}
        roles={roles}
        isGameLocked={isGameLocked}
        isSaving={isSaving}
        selectedRole={selectedRole}
        t={t}
        onChange={setForm}
        onClearBrowserData={onClearBrowserData}
        onError={onError}
      />
    </EditorPage>
  );
}

function RoleForm({
  form,
  games,
  roles,
  isGameLocked,
  isSaving,
  selectedRole,
  t,
  onChange,
  onClearBrowserData,
  onError,
}: RoleFormProps): JSX.Element {
  const coverInputRef = useRef<HTMLInputElement>(null);
  const hasCoverPreview = Boolean(form.coverImageDataUrl);
  const previewStyle = createRoleCardStyle({
    color: form.coverImageDominantColor ?? DEFAULT_ROLE_COVER_COLOR,
    hasCoverImage: true,
    isActive: false
  });
  const gameChanged = Boolean(selectedRole && selectedRole.gameId !== form.gameId);
  const selectedGame = games.find((game) => game.id === form.gameId);
  const formOrigin = safeLaunchOrigin(form.launchUrl);
  const dependentRoles = selectedRole
    ? roles.filter((role) => role.localStorageSourceRoleId === selectedRole.id)
    : [];
  const eligibleSourceRoles = roles.filter((role) =>
    role.id !== selectedRole?.id
    && role.gameId === form.gameId
    && !role.localStorageSourceRoleId
    && formOrigin !== undefined
    && safeLaunchOrigin(role.launchUrl) === formOrigin
  );
  const bindingDisabled = !selectedGame?.localStorageSyncKeys.length
    || dependentRoles.length > 0
    || eligibleSourceRoles.length === 0;

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
          <div className="grid gap-4">
            <Surface className="grid gap-3 p-4" padding="none" variant="inset">
              <FormGrid columns={2}>
                <FormField
                  htmlFor="role-game"
                  label={t("roleForm.game")}
                  description={isGameLocked ? t("roleForm.gameLocked") : t("roleForm.gameDescription")}
                >
                  <Select
                    value={form.gameId}
                    disabled={isGameLocked}
                    onValueChange={(gameId) => {
                      const game = games.find((item) => item.id === gameId);
                      if (!game) return;
                      onChange((current) => ({
                        ...current,
                        gameId,
                        launchUrl: game.defaultLaunchUrl,
                        localStorageSourceRoleId: undefined
                      }));
                    }}
                    required
                  >
                    <SelectTrigger id="role-game"><SelectValue /></SelectTrigger>
                    <SelectContent>{games.map((game) => <SelectItem key={game.id} value={game.id}>{game.name}</SelectItem>)}</SelectContent>
                  </Select>
                  {gameChanged ? <p className="text-xs leading-5 text-warning-foreground">{t("roleForm.gameChangeWarning")}</p> : null}
                </FormField>
                <FormField
                  htmlFor="role-launch-url"
                  label={t("roleForm.launchUrl")}
                  description={t("roleForm.launchUrlDescription")}
                >
                  <Input id="role-launch-url" type="url" value={form.launchUrl} onChange={(event) => onChange((current) => {
                    const launchUrl = event.target.value;
                    return {
                      ...current,
                      launchUrl,
                      localStorageSourceRoleId: safeLaunchOrigin(launchUrl) === safeLaunchOrigin(current.launchUrl)
                        ? current.localStorageSourceRoleId
                        : undefined
                    };
                  })} required maxLength={2048} pattern="https?://.+" placeholder={t("roleForm.launchUrl.customPlaceholder")} />
                </FormField>
              </FormGrid>
            </Surface>

            <Surface className="grid gap-3 p-4" padding="none" variant="inset">
              <FieldHeader
                title={t("roleForm.localStorageBinding")}
                description={t("roleForm.localStorageBindingDescription")}
              />
              <FormField htmlFor="role-local-storage-source" label={t("roleForm.localStorageSource")}>
                <Select
                  value={form.localStorageSourceRoleId ?? "none"}
                  disabled={bindingDisabled && !form.localStorageSourceRoleId}
                  onValueChange={(value) => onChange((current) => ({
                    ...current,
                    localStorageSourceRoleId: value === "none" ? undefined : value
                  }))}
                >
                  <SelectTrigger id="role-local-storage-source"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{t("roleForm.localStorageSourceNone")}</SelectItem>
                    {eligibleSourceRoles.map((role) => <SelectItem key={role.id} value={role.id}>{role.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </FormField>
              {form.localStorageSourceRoleId ? (
                <div className="rounded-md bg-muted/60 px-3 py-2 text-xs leading-5 text-muted-foreground">
                  <p>{t("roleForm.localStorageDirection").replace("{source}", eligibleSourceRoles.find((role) => role.id === form.localStorageSourceRoleId)?.name ?? t("roleForm.localStorageUnknownSource"))}</p>
                  <p className="break-all">{t("roleForm.localStorageManagedKeys").replace("{keys}", selectedGame?.localStorageSyncKeys.join(", ") ?? "")}</p>
                </div>
              ) : null}
              {!selectedGame?.localStorageSyncKeys.length ? <p className="text-xs text-muted-foreground">{t("roleForm.localStorageNoKeys")}</p> : null}
              {dependentRoles.length > 0 ? <p className="text-xs text-muted-foreground">{t("roleForm.localStorageHasDependents").replace("{names}", dependentRoles.map((role) => role.name).join(", "))}</p> : null}
              {selectedGame?.localStorageSyncKeys.length && dependentRoles.length === 0 && eligibleSourceRoles.length === 0 ? <p className="text-xs text-muted-foreground">{t("roleForm.localStorageNoSources")}</p> : null}
            </Surface>

            {selectedRole ? (
              <Surface className="grid gap-3 p-4" padding="none" variant="inset">
                <FieldHeader
                  title={t("roleForm.savedData")}
                  description={t("roleForm.savedDataDescription")}
                />
                <Button
                  type="button"
                  variant="destructive"
                  className="w-full"
                  onClick={() => void onClearBrowserData(selectedRole)}
                  disabled={isSaving}
                >
                  {isSaving ? <Loader2 className="spin" size={17} /> : <Eraser size={17} />}
                  {t("role.clearSavedData")}
                </Button>
              </Surface>
            ) : null}
          </div>

          <Surface className="grid gap-3 p-4" padding="none" variant="inset">
            <FieldHeader title={t("roleForm.cover")} description={t("roleForm.coverDescription")} />

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

            {hasCoverPreview ? (
              <div className="flex gap-2">
                <Button
                  className="flex-1"
                  type="button"
                  variant="outline"
                  onClick={() => coverInputRef.current?.click()}
                  disabled={isSaving}
                >
                  <ImagePlus size={15} />
                  {t("roleForm.coverReplace")}
                </Button>
                <Button type="button" variant="ghost" onClick={removeCoverImage} disabled={isSaving}>
                  <Trash2 size={15} />
                  {t("roleForm.coverRemove")}
                </Button>
              </div>
            ) : null}
          </Surface>
    </>
  );
}

export default RoleEditorRoute;

function safeLaunchOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : undefined;
  } catch {
    return undefined;
  }
}
