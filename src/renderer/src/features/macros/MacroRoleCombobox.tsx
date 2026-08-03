import { Fragment, type JSX, useMemo, useRef } from "react";

import { DEFAULT_ROLE_COVER_COLOR, roleCoverPlaceholderUrl } from "../../app/roleCoverPlaceholder";
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxValue
} from "../../components/ui/combobox";
import type { Translator } from "../../i18n";
import type { Game, Role } from "../../../../shared/types";

interface MacroRoleComboboxProps {
  disabled?: boolean;
  games: Game[];
  roles: Role[];
  t: Translator;
  value: string[];
  onValueChange: (roleIds: string[]) => void;
}

interface RoleOption {
  label: string;
  role?: Role;
  value: string;
}

interface RoleOptionGroup {
  items: RoleOption[];
  label: string;
  value: string;
}

export function MacroRoleCombobox({
  disabled = false,
  games,
  roles,
  t,
  value,
  onValueChange
}: MacroRoleComboboxProps): JSX.Element {
  const anchor = useRef<HTMLDivElement | null>(null);
  const { groups, selectedOptions } = useMemo(
    () => createRoleOptionState(games, roles, value, t),
    [games, roles, t, value]
  );

  function handleValueChange(nextOptions: RoleOption[]): void {
    onValueChange([...new Set(nextOptions.map((option) => option.value))]);
  }

  return (
    <Combobox
      autoHighlight
      disabled={disabled}
      isItemEqualToValue={(option, selected) => option.value === selected.value}
      itemToStringLabel={(option: RoleOption) => option.label}
      items={groups}
      multiple
      value={selectedOptions}
      onValueChange={handleValueChange}
    >
      <ComboboxChips ref={anchor}>
        <ComboboxValue>
          {(selected: RoleOption[]) => (
            <Fragment>
              {selected.map((option) => (
                <ComboboxChip
                  key={option.value}
                  removeLabel={t("macroForm.removeRole").replace("{name}", option.label)}
                >
                  {option.label}
                </ComboboxChip>
              ))}
              <ComboboxChipsInput
                id="macro-role"
                aria-label={t("macroForm.roles")}
                autoComplete="off"
                disabled={disabled}
                placeholder={selected.length === 0 ? t("macroForm.rolesPlaceholder") : undefined}
              />
            </Fragment>
          )}
        </ComboboxValue>
      </ComboboxChips>
      <ComboboxContent anchor={anchor}>
        <ComboboxEmpty>{t("macroForm.noRoleMatches")}</ComboboxEmpty>
        <ComboboxList>
          {(group: RoleOptionGroup) => (
            <ComboboxGroup key={group.value} items={group.items}>
              <ComboboxLabel>{group.label}</ComboboxLabel>
              <ComboboxCollection>
                {(option: RoleOption) => (
                  <ComboboxItem key={option.value} value={option}>
                    {option.role ? <RoleOptionCover role={option.role} /> : null}
                    <span className="min-w-0 flex-1 truncate font-medium">{option.label}</span>
                  </ComboboxItem>
                )}
              </ComboboxCollection>
            </ComboboxGroup>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

function RoleOptionCover({ role }: { role: Role }): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="size-7 shrink-0 rounded-xs bg-cover bg-center ring-1 ring-inset ring-border/60"
      style={{
        backgroundColor: role.coverImageDominantColor ?? DEFAULT_ROLE_COVER_COLOR,
        backgroundImage: `url("${role.coverImageDataUrl ?? roleCoverPlaceholderUrl}")`
      }}
    />
  );
}

function createRoleOptionState(
  games: Game[],
  roles: Role[],
  selectedRoleIds: string[],
  t: Translator
): { groups: RoleOptionGroup[]; selectedOptions: RoleOption[] } {
  const gameIds = new Set(games.map((game) => game.id));
  const optionById = new Map<string, RoleOption>(
    roles.map((role) => [role.id, { label: role.name, role, value: role.id } satisfies RoleOption])
  );
  const groups: RoleOptionGroup[] = games.flatMap((game) => {
    const items = roles
      .filter((role) => role.gameId === game.id)
      .map((role) => optionById.get(role.id) as RoleOption);
    return items.length > 0
      ? [{ items, label: game.name, value: `game:${game.id}` }]
      : [];
  });
  const unknownGameOptions = roles
    .filter((role) => !gameIds.has(role.gameId))
    .map((role) => optionById.get(role.id) as RoleOption);
  if (unknownGameOptions.length > 0) {
    groups.push({
      items: unknownGameOptions,
      label: t("macroForm.unknownGame"),
      value: "unknown-game"
    });
  }

  const missingOptions = selectedRoleIds.flatMap((roleId) => {
    if (optionById.has(roleId)) {
      return [];
    }
    const option = { label: t("macros.unknownRole"), value: roleId } satisfies RoleOption;
    optionById.set(roleId, option);
    return [option];
  });
  if (missingOptions.length > 0) {
    groups.push({
      items: missingOptions,
      label: t("macroForm.unavailableRoles"),
      value: "unavailable-roles"
    });
  }

  return {
    groups,
    selectedOptions: selectedRoleIds.flatMap((roleId) => {
      const option = optionById.get(roleId);
      return option ? [option] : [];
    })
  };
}
