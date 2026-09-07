import { useState } from "react";
import type { ExtensionRoleRecord } from "../../../../shared/generated";
import type { Role } from "../../../../shared/types";
import { SearchField } from "../../components/SearchField";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { SegmentedControl, StatusCallout } from "../../components/ui/patterns";
import type { Translator } from "../../i18n";

interface Props {
  roles: Role[];
  runtimeRoles: ExtensionRoleRecord[];
  extensionId: string;
  selectedIds: string[];
  allRoles: boolean;
  busy: boolean;
  onSelectedIds: (ids: string[]) => void;
  onAllRoles: (value: boolean) => void;
  t: Translator;
}

export function ExtensionRolePicker({ roles, runtimeRoles, extensionId, selectedIds, allRoles, busy, onSelectedIds, onAllRoles, t }: Props) {
  const [query, setQuery] = useState("");
  const visible = roles.filter(role => role.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const selected = new Set(selectedIds);
  return <section className="grid gap-3" aria-label={t("extensions.scope")}>
    <h3 className="text-heading font-semibold">{t("extensions.scope")}</h3>
    <fieldset disabled={busy} className="min-w-0">
      <SegmentedControl className="grid-cols-2" value={allRoles ? "all" : "selected"}
        onValueChange={value => onAllRoles(value === "all")}
        items={[{ value: "selected", label: t("extensions.selectedRoles") }, { value: "all", label: t("extensions.allRoles") }]} />
    </fieldset>
    {allRoles && <StatusCallout>{t("extensions.allRolesDescription")}</StatusCallout>}
    {roles.length > 0 ? <>
      <SearchField value={query} onChange={setQuery} placeholder={t("extensions.searchRoles")} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-caption text-muted-foreground">{t("extensions.selectedCount").replace("{selected}", String(allRoles ? roles.length : roles.filter(role => selected.has(role.id)).length)).replace("{total}", String(roles.length))}</p>
        {!allRoles && <div className="flex gap-2">
          <Button variant="ghost" disabled={busy} onClick={() => onSelectedIds(roles.map(role => role.id))}>{t("extensions.selectCurrentRoles")}</Button>
          <Button variant="ghost" disabled={busy || selectedIds.length === 0} onClick={() => onSelectedIds([])}>{t("extensions.clearSelection")}</Button>
        </div>}
      </div>
      <ul className="divide-y divide-border rounded-md border border-border">
        {visible.map(role => {
          const runtime = runtimeRoles.find(record => record.roleId === role.id);
          const enabled = allRoles || selected.has(role.id);
          const included = !!runtime?.extensionIds.includes(extensionId);
          const pending = !!runtime && enabled !== included;
          const status = included && runtime?.status === "failed" ? "extensions.loadFailed"
            : pending ? "extensions.pending" : included && runtime?.status === "loaded" ? "extensions.loaded"
            : included && runtime?.status === "loading" ? "extensions.loading" : null;
          return <li key={role.id}>
            <label className="flex items-center gap-3 px-3 py-2 text-control">
              <Checkbox aria-label={role.name} checked={enabled} disabled={busy || allRoles}
                onCheckedChange={checked => onSelectedIds(checked === true ? [...new Set([...selectedIds, role.id])] : selectedIds.filter(id => id !== role.id))} />
              <span className="min-w-0 flex-1 break-words">{role.name}</span>
              <span className="flex shrink-0 flex-col items-end text-caption text-muted-foreground">
                <span>{t(enabled ? "extensions.enabled" : "extensions.disabled")}</span>
                {status && <span className={status === "extensions.loadFailed" ? "text-destructive" : undefined}>{t(status)}</span>}
              </span>
            </label>
          </li>;
        })}
      </ul>
      {visible.length === 0 && <p className="text-control text-muted-foreground">{t("extensions.noRolesMatch")}</p>}
    </> : <p className="text-control text-muted-foreground">{t("extensions.noRoles")}</p>}
    <p className="text-caption text-muted-foreground">{t("extensions.nextLaunch")}</p>
  </section>;
}
