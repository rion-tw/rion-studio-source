import { Check, ImagePlus, Loader2, LogIn, Save, Trash2, X } from "lucide-react";
import { type ChangeEvent, type FormEvent, type JSX, useEffect, useRef } from "react";

import { Button } from "../../components/ui/button";
import { CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { FieldHeader, FormField, FormGrid, Surface } from "../../components/ui/patterns";
import { Select } from "../../components/ui/select";
import { Textarea } from "../../components/ui/textarea";
import { launchUrlOptions } from "../../app/constants";
import { shouldShowLoginGuidance } from "../../app/statusUtils";
import type { RoleFormState } from "../../app/types";
import type { Translator } from "../../i18n";
import type { AuthFlowStatus, LaunchPreset, Role } from "../../../../shared/types";
import { createRoleCardStyle } from "./roleCardStyle";
import { createCoverImageDataUrl } from "./roleCover";
import { LoginSessionGuide } from "./LoginSessionGuide";

interface RoleFormProps {
  authStatus?: AuthFlowStatus;
  form: RoleFormState;
  isLoginBusy: boolean;
  isSaving: boolean;
  selectedRole?: Role;
  t: Translator;
  onCancel: () => void;
  onChange: (form: RoleFormState | ((current: RoleFormState) => RoleFormState)) => void;
  onError: (error: unknown | null) => void;
  onRelogin: (roleId: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

function RoleModal(props: RoleFormProps): JSX.Element {
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
        aria-label={t("roleForm.aria.close")}
        onClick={onCancel}
      />
      <div
        className="relative z-10 w-full max-w-[1040px]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="role-form-title"
      >
        <RoleForm {...props} />
      </div>
    </div>
  );
}

function RoleForm({
  authStatus,
  form,
  isLoginBusy,
  isSaving,
  selectedRole,
  t,
  onCancel,
  onChange,
  onError,
  onRelogin,
  onSubmit
}: RoleFormProps): JSX.Element {
  const coverInputRef = useRef<HTMLInputElement>(null);
  const hasCoverPreview = Boolean(form.coverImageDataUrl);
  const previewStyle = createRoleCardStyle({
    color: form.coverImageDominantColor,
    hasCoverImage: hasCoverPreview,
    isActive: false
  });

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
    <Surface
      className="flex max-h-[calc(100vh-2rem)] flex-col overflow-hidden text-card-foreground"
      radius="lg"
      variant="modal"
    >
      <CardHeader className="glass-divider flex-row items-start justify-between gap-3 border-b">
        <div className="min-w-0">
          <CardTitle id="role-form-title">
            {form.id ? t("roleForm.title.edit") : t("roleForm.title.new")}
          </CardTitle>
          <CardDescription className="mt-1">
            {form.id ? t("roleForm.description.edit") : t("roleForm.description.new")}
          </CardDescription>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          title={t("roleForm.cancelTitle")}
          onClick={onCancel}
          disabled={isSaving}
        >
          <X size={17} />
        </Button>
      </CardHeader>

      <form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => onSubmit(event)}>
        <div className="grid gap-4 overflow-auto p-4 md:grid-cols-[240px_minmax(0,1fr)] md:items-start md:p-5 xl:grid-cols-[minmax(280px,340px)_minmax(0,1fr)]">
          <div className="grid gap-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between lg:flex-col lg:items-stretch">
              <FieldHeader title={t("roleForm.cover")} description={t("roleForm.coverDescription")} />
              <div className="flex shrink-0 gap-2">
                <Button
                  className="flex-1"
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => coverInputRef.current?.click()}
                  disabled={isSaving}
                >
                  <ImagePlus size={15} />
                  {hasCoverPreview ? t("roleForm.coverReplace") : t("roleForm.coverChoose")}
                </Button>
                {hasCoverPreview ? (
                  <Button type="button" variant="ghost" size="sm" onClick={removeCoverImage} disabled={isSaving}>
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
                className="glass-inset role-cover-empty-preview relative aspect-[4/5] w-full overflow-hidden rounded-lg text-left transition-colors"
                type="button"
                onClick={() => coverInputRef.current?.click()}
                disabled={isSaving}
              >
                <div className="absolute inset-0 grid place-items-center text-center text-muted-foreground">
                  <div className="grid gap-2 px-5">
                    <ImagePlus className="mx-auto" size={24} />
                    <p className="text-xs font-medium">{t("roleForm.coverEmpty")}</p>
                  </div>
                </div>
              </button>
            )}
          </div>

          <div className="grid gap-4">
            <section className="grid gap-3">
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
                  <Select
                    id="role-launch-url"
                    value={form.launchUrl}
                    onChange={(event) => onChange((current) => ({ ...current, launchUrl: event.target.value }))}
                    required
                  >
                    {launchUrlOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {t(option.labelKey)}
                      </option>
                    ))}
                    {launchUrlOptions.some((option) => option.value === form.launchUrl) ? null : (
                      <option value={form.launchUrl}>{t("roleForm.launchUrl.current")}</option>
                    )}
                  </Select>
                </FormField>
              </FormGrid>
            </section>

            <section className="glass-divider grid gap-3 border-t pt-4">
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
            </section>

            <section className="glass-divider grid gap-3 border-t pt-4">
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
            </section>
          </div>
        </div>

        <div className="glass-divider flex flex-col gap-2 border-t p-4 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" className="sm:min-w-[120px]" onClick={onCancel} disabled={isSaving}>
            {t("roleForm.cancel")}
          </Button>
          <Button className="sm:min-w-[160px]" type="submit" disabled={isSaving}>
            {isSaving ? <Loader2 className="spin" size={17} /> : form.id ? <Save size={17} /> : <Check size={17} />}
            {form.id ? t("roleForm.saveChanges") : t("roleForm.createRole")}
          </Button>
        </div>
      </form>
    </Surface>
  );
}

export default RoleModal;
