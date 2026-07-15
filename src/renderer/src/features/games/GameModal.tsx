import { Check, ImagePlus, RotateCcw, Save, Trash2 } from "lucide-react";
import { type ChangeEvent, type FormEvent, type JSX, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";

import { createGameFormState, createNewGameForm, areEditorFormsEqual } from "../../app/editorFormState";
import { getGameIconUrl } from "../../app/gamePresentation";
import type { GameFormState } from "../../app/types";
import { EditorNotFound, EditorPage } from "../../components/EditorPage";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { FieldHeader, FormField, FormGrid, Surface } from "../../components/ui/patterns";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { useUnsavedChangesGuard } from "../../hooks/useUnsavedChangesGuard";
import type { Translator } from "../../i18n";
import type { Game, InheritableBrowserLaunchMode, LaunchPreset, RoleDefaults } from "../../../../shared/types";

interface GameEditorRouteProps {
  games: Game[];
  isSaving: boolean;
  roleDefaults: RoleDefaults;
  t: Translator;
  onError: (error: unknown | null) => void;
  onReset: (game: Game) => Promise<Game | undefined>;
  onSave: (form: GameFormState) => Promise<Game | undefined>;
}

function GameEditorRoute(props: GameEditorRouteProps): JSX.Element {
  const { id } = useParams();
  const navigate = useNavigate();
  const game = id ? props.games.find((item) => item.id === id) : undefined;
  if (id && !game) {
    return <EditorNotFound title={props.t("editor.notFound.title")} description={props.t("games.notFound")} actionLabel={props.t("games.back")} onAction={() => navigate("/games", { replace: true })} />;
  }
  const initialForm = game ? createGameFormState(game, props.roleDefaults) : createNewGameForm(props.roleDefaults);
  return <GameEditor key={id ?? "new"} {...props} game={game} initialForm={initialForm} />;
}

function GameEditor({ games: _games, game, initialForm, isSaving, roleDefaults, t, onError, onReset, onSave }: GameEditorRouteProps & { game?: Game; initialForm: GameFormState }): JSX.Element {
  const navigate = useNavigate();
  const initialRef = useRef(initialForm);
  const [form, setForm] = useState(initialForm);
  const guard = useUnsavedChangesGuard(!areEditorFormsEqual(initialRef.current, form), useMemo(() => ({
    title: t("confirm.unsaved.title"), description: t("confirm.unsaved.description"), cancelLabel: t("confirm.unsaved.continue"), confirmLabel: t("confirm.unsaved.discard"), tone: "destructive" as const
  }), [t]), isSaving);
  const canSubmit = Boolean(form.name.trim() && /^https?:\/\//.test(form.defaultLaunchUrl));

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const saved = await onSave(form);
    if (saved) { guard(); navigate(`/games/${saved.id}`, { replace: true }); }
  }

  async function resetBuiltin(): Promise<void> {
    if (!game) return;
    const saved = await onReset(game);
    if (!saved) return;
    const resetForm = createGameFormState(saved, roleDefaults);
    initialRef.current = resetForm;
    setForm(resetForm);
  }

  return (
    <EditorPage
      backActionLabel={t("editor.back")} backLabel={t("games.back")} canSubmit={canSubmit}
      description={form.id ? t("games.form.editDescription") : t("games.form.newDescription")}
      isSaving={isSaving} onCancel={() => navigate("/games", { replace: true })} onSubmit={(event) => void submit(event)}
      onTitleChange={(name) => form.source === "custom" && setForm((current) => ({ ...current, name }))}
      saveIcon={form.id ? <Save size={16} /> : <Check size={16} />} saveLabel={form.id ? t("games.form.save") : t("games.form.create")}
      title={form.name} titleAriaLabel={t("games.form.name")} titlePlaceholder={t("games.form.namePlaceholder")}
      titleDisabled={form.source === "builtin"}
      contentClassName="min-[1100px]:grid-cols-[minmax(0,1fr)_260px] min-[1100px]:items-start"
    >
      <div className="grid gap-4">
        {form.source === "builtin" ? <Surface className="flex items-center justify-between gap-3 p-4" variant="inset"><p className="text-xs text-muted-foreground">{t("games.form.builtinLocked")}</p><Button type="button" variant="outline" onClick={() => void resetBuiltin()}><RotateCcw size={15} />{t("games.reset.action")}</Button></Surface> : null}
        <Surface className="grid gap-4 p-4" variant="inset">
          <FieldHeader title={t("games.form.urls")} description={t("games.form.urlsDescription")} />
          <FormField htmlFor="game-launch-url" label={t("games.form.defaultLaunchUrl")}><Input id="game-launch-url" type="url" maxLength={2048} required value={form.defaultLaunchUrl} onChange={(e) => setForm({ ...form, defaultLaunchUrl: e.target.value })} /></FormField>
          <FormField htmlFor="game-login-url" label={t("games.form.loginUrl")} description={t("games.form.loginUrlDescription")}><Input id="game-login-url" type="url" maxLength={2048} value={form.loginUrl} onChange={(e) => setForm({ ...form, loginUrl: e.target.value })} /></FormField>
        </Surface>
        <Surface className="grid gap-4 p-4" variant="inset">
          <FormField label={t("games.form.roleDefaults")} description={t("games.form.roleDefaultsDescription")}>
            <Select value={form.usesGlobalRoleDefaults ? "global" : "custom"} onValueChange={(value) => setForm({ ...form, usesGlobalRoleDefaults: value === "global" })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="global">{t("games.form.inheritGlobal")}</SelectItem><SelectItem value="custom">{t("games.form.customDefaults")}</SelectItem></SelectContent></Select>
          </FormField>
          {!form.usesGlobalRoleDefaults ? <FormGrid columns={3}>
            <FormField label={t("roleForm.width")}><Input type="number" min={640} max={7680} value={form.windowWidth} onChange={(e) => setForm({ ...form, windowWidth: Number(e.target.value) })} /></FormField>
            <FormField label={t("roleForm.height")}><Input type="number" min={640} max={7680} value={form.windowHeight} onChange={(e) => setForm({ ...form, windowHeight: Number(e.target.value) })} /></FormField>
            <FormField label={t("roleForm.launchPreset")}><Select value={form.launchPreset} onValueChange={(value) => setForm({ ...form, launchPreset: value as LaunchPreset })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="performance">{t("preset.performance")}</SelectItem><SelectItem value="balanced">{t("preset.balanced")}</SelectItem></SelectContent></Select></FormField>
          </FormGrid> : null}
          <FormField label={t("games.form.launchMode")}><Select value={form.browserLaunchMode} onValueChange={(value) => setForm({ ...form, browserLaunchMode: value as InheritableBrowserLaunchMode })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="inherit">{t("games.mode.inherit")}</SelectItem><SelectItem value="auto">{t("games.mode.auto")}</SelectItem><SelectItem value="embedded">{t("games.mode.embedded")}</SelectItem><SelectItem value="external">{t("games.mode.external")}</SelectItem></SelectContent></Select></FormField>
        </Surface>
      </div>
      <GameIconEditor form={form} game={game} isSaving={isSaving} t={t} onChange={setForm} onError={onError} />
    </EditorPage>
  );
}

function GameIconEditor({ form, game, isSaving, t, onChange, onError }: { form: GameFormState; game?: Game; isSaving: boolean; t: Translator; onChange: (form: GameFormState) => void; onError: (error: unknown | null) => void }): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const iconUrl = form.iconImageDataUrl ?? getGameIconUrl(game);
  async function change(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
    try { onChange({ ...form, iconImageDataUrl: await createSquareImage(file) }); onError(null); } catch (error) { onError(error); }
  }
  return <Surface className="grid gap-3 p-4" variant="inset"><FieldHeader title={t("games.form.icon")} description={form.source === "builtin" ? t("games.form.iconBuiltin") : t("games.form.iconDescription")} /><div className="mx-auto grid aspect-square w-full max-w-52 place-items-center overflow-hidden rounded-xl bg-muted">{iconUrl ? <img className="size-full object-cover" src={iconUrl} alt="" /> : <ImagePlus size={30} />}</div>{form.source === "custom" ? <><input ref={inputRef} className="sr-only" type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={isSaving} onChange={(event) => void change(event)} /><div className="flex gap-2"><Button className="flex-1" type="button" variant="outline" onClick={() => inputRef.current?.click()}><ImagePlus size={15} />{t("games.form.chooseIcon")}</Button>{form.iconImageDataUrl ? <Button type="button" variant="ghost" onClick={() => onChange({ ...form, iconImageDataUrl: undefined })}><Trash2 size={15} /></Button> : null}</div></> : null}</Surface>;
}

async function createSquareImage(file: File): Promise<string> {
  if (!file.type.startsWith("image/") || file.size > 1_500_000) throw new Error("Game icon must be an image up to 1.5 MB.");
  const source = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error("Unable to process game icon.")); image.src = source; });
    const canvas = document.createElement("canvas"); canvas.width = 512; canvas.height = 512;
    const context = canvas.getContext("2d"); if (!context) throw new Error("Unable to process game icon.");
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, 512, 512);
    return canvas.toDataURL("image/webp", 0.9);
  } finally { URL.revokeObjectURL(source); }
}

export default GameEditorRoute;
