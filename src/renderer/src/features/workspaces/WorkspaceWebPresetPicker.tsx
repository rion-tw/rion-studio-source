import type { JSX } from "react";

import { FormField } from "../../components/ui/patterns";

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectLabel,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "../../components/ui/select";

import type { Translator } from "../../i18n";

import { cn } from "../../lib/utils";

import type { LaunchWorkspaceSlot } from "../../../../shared/types";

import {
  resolveWorkspaceWebPreset,
  workspaceWebPresets,
  workspaceWebPresetGroups,
  workspaceWebPresetName,
  type WorkspaceWebPreset
} from "./workspaceWebPresets";

interface WorkspaceWebPresetPickerProps {
  disabled: boolean;
  onSelect: (preset: WorkspaceWebPreset) => void;
  t: Translator;
  web: NonNullable<LaunchWorkspaceSlot["web"]>;
}

export function WorkspaceWebPresetPicker({
  disabled,
  onSelect,
  t,
  web
}: WorkspaceWebPresetPickerProps): JSX.Element {
  const selectedPreset = resolveWorkspaceWebPreset(web.startUrl);

  return (
    <section className="grid gap-2">
      <FormField
        htmlFor="workspace-web-preset"
        label={t("workspaces.webPresets")}
        description={t("workspaces.webPresetsDescription")}
      >
        <Select
          disabled={disabled}
          value={selectedPreset?.id ?? ""}
          onValueChange={(presetId) => {
            const preset = workspaceWebPresets.find((candidate) => candidate.id === presetId);
            if (preset) onSelect(preset);
          }}
        >
          <SelectTrigger
            id="workspace-web-preset"
            className="w-full"
            data-workspace-web-preset-select
          >
            <SelectValue placeholder={t("workspaces.webPresetsPlaceholder")}>
              {selectedPreset ? <WorkspaceWebPresetOption preset={selectedPreset} t={t} /> : undefined}
            </SelectValue>
          </SelectTrigger>
          <SelectContent position="popper">
            {workspaceWebPresetGroups.map((group) => (
              <SelectGroup key={group.id} data-workspace-web-category={group.id}>
                <SelectLabel>{t(group.labelKey)}</SelectLabel>
                {group.presets.map((preset) => (
                  <SelectItem key={preset.id} data-workspace-web-preset={preset.id} value={preset.id}>
                    <WorkspaceWebPresetOption preset={preset} t={t} />
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
      </FormField>
      <p className="text-caption text-muted-foreground">
        {t("workspaces.webPresetsHint")}
      </p>
    </section>
  );
}

function WorkspaceWebPresetOption({ preset, t }: { preset: WorkspaceWebPreset; t: Translator }): JSX.Element {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="grid size-5 shrink-0 place-items-center overflow-hidden rounded-xs bg-media-black">
        <img
          alt=""
          className={cn(
            "size-full",
            preset.brandImagePresentation === "cover" ? "object-cover" : "object-contain p-0.5"
          )}
          draggable={false}
          src={preset.brandImageUrl}
        />
      </span>
      <span className="min-w-0 truncate">{workspaceWebPresetName(preset, t)}</span>
    </span>
  );
}
