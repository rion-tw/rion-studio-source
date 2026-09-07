import { useRef } from "react";
import type { MacroFormState } from "../../app/types";
import type { Game, Role } from "../../../../shared/types";
import type { Translator } from "../../i18n";
import { FormField, SegmentedControl, Surface } from "../../components/ui/patterns";
import { MacroRoleCombobox } from "./MacroRoleCombobox";

export function MacroExecutionFields({ form, games, roles, isSaving, t, onChange }: {
  form: MacroFormState; games: Game[]; roles: Role[]; isSaving: boolean; t: Translator;
  onChange: (updater: (current: MacroFormState) => MacroFormState) => void;
}) {
  const mode = form.executionMode ?? "selected_roles";
  const drafts = useRef<Partial<Record<typeof mode, Pick<MacroFormState, "roleIds" | "shortcutSourceScope">>>>({});
  const selectedSources = useRef<Partial<Record<typeof mode, string[]>>>({});
  const dynamic = mode === "source_role";
  return <Surface className="grid gap-4 p-4" padding="none" variant="inset">
    <FormField label={t("macroForm.roles")}>
      <div className="grid gap-2">
        <SegmentedControl<typeof mode> role="group" disabled={isSaving} aria-label={t("macroForm.roles")} className="w-full grid-cols-2"
          items={[{ value: "source_role", label: t("macroForm.execution.sourceRole") }, { value: "selected_roles", label: t("macroForm.execution.selectedRoles") }]}
          value={mode} onValueChange={(next) => {
            if (isSaving || next === mode) return;
            onChange((current) => {
              drafts.current[mode] = { roleIds: [...current.roleIds], shortcutSourceScope: structuredClone(current.shortcutSourceScope) };
              return { ...current, executionMode: next, ...(drafts.current[next] ?? { roleIds: [], shortcutSourceScope: { type: next === "source_role" ? "all_roles" : "all_execution_roles" } }) };
            });
          }} />
        <p className="text-caption text-muted-foreground">{t(dynamic ? "macroForm.execution.sourceDescription" : "macroForm.rolesDescription")}</p>
        {!dynamic && roles.length === 0 && <p className="text-control text-muted-foreground">{t("macroForm.noRoles")}</p>}
        {!dynamic && roles.length > 0 && <MacroRoleCombobox disabled={isSaving} games={games} roles={roles} t={t} value={form.roleIds}
          onValueChange={(roleIds) => onChange((current) => ({ ...current, roleIds }))} />}
      </div>
    </FormField>
    {(dynamic || form.trigger) && <FormField label={t("macroForm.shortcutScope")}>
      <div className="grid gap-2">
        <SegmentedControl<MacroFormState["shortcutSourceScope"]["type"]> role="group" disabled={isSaving} className="w-full grid-cols-2"
          aria-label={t("macroForm.shortcutScope")} value={form.shortcutSourceScope.type}
          items={[{ value: dynamic ? "all_roles" : "all_execution_roles", label: t(dynamic ? "macroForm.sourceScope.allRoles" : "macroForm.shortcutScope.allExecutionRoles") }, { value: "selected_roles", label: t("macroForm.shortcutScope.selectedRoles") }]}
          onValueChange={(type) => {
            if (isSaving) return;
            onChange((current) => {
              if (current.shortcutSourceScope.type === "selected_roles") selectedSources.current[mode] = [...current.shortcutSourceScope.roleIds];
              return { ...current, shortcutSourceScope: type === "selected_roles" ? { type, roleIds: selectedSources.current[mode] ?? [...current.roleIds] } : { type } };
            });
          }} />
        {form.shortcutSourceScope.type === "selected_roles" && <MacroRoleCombobox
          ariaLabel={t("macroForm.shortcutSourceRoles")} inputId="macro-shortcut-source-role"
          disabled={isSaving} games={games} roles={roles} t={t} value={form.shortcutSourceScope.roleIds}
          onValueChange={(roleIds) => onChange((current) => ({ ...current, shortcutSourceScope: { type: "selected_roles", roleIds } }))} />}
        <p className="text-caption text-muted-foreground">{t(dynamic ? "macroForm.execution.allowedDescription" : "macroForm.shortcutSourceRolesDescription")}</p>
      </div>
    </FormField>}
  </Surface>;
}
