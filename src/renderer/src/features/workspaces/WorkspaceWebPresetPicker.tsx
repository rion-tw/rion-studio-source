import { Check } from "lucide-react";

import type { JSX } from "react";

import { FieldHeader } from "../../components/ui/patterns";

import type { Translator } from "../../i18n";

import { cn } from "../../lib/utils";

import type { LaunchWorkspaceSlot } from "../../../../shared/types";

import {
  resolveWorkspaceWebPreset,
  workspaceWebPresets,
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
    <section className="workspace-web-preset-section flex min-h-0 flex-col gap-2">
      <FieldHeader
        title={t("workspaces.webPresets")}
        description={t("workspaces.webPresetsDescription")}
      />
      <div
        aria-label={t("workspaces.webPresets")}
        className="workspace-web-preset-grid app-scroll-region grid min-h-0 flex-1 auto-rows-max grid-cols-3 content-start gap-2 overflow-y-auto overscroll-contain pr-1"
        role="group"
      >
        {workspaceWebPresets.map((preset) => {
          const isSelected = selectedPreset?.id === preset.id;

          return (
            <button
              key={preset.id}
              aria-pressed={isSelected}
              className={cn(
                "glass-control group/preset relative aspect-video min-w-0 overflow-hidden rounded-md border-border/55 bg-media-black p-0 text-left shadow-sm transition-[border-color,box-shadow,opacity,transform] hover:-translate-y-0.5 hover:border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 disabled:pointer-events-none disabled:opacity-45",
                isSelected && "border-activity/75 ring-2 ring-activity/20"
              )}
              data-workspace-web-preset={preset.id}
              disabled={disabled}
              type="button"
              onClick={() => onSelect(preset)}
            >
              <img
                alt=""
                className={cn(
                  "absolute inset-0 size-full transition-transform duration-150 group-hover/preset:scale-[1.03]",
                  preset.brandImagePresentation === "cover"
                    ? "object-cover opacity-90"
                    : "object-contain p-4"
                )}
                draggable={false}
                src={preset.brandImageUrl}
              />
              <span className="absolute inset-0 bg-gradient-to-t from-media-black/90 via-media-black/5 to-transparent" />
              <span className="absolute inset-x-2 bottom-1.5 truncate text-caption font-semibold text-on-media">
                {preset.name}
              </span>
              {isSelected ? (
                <span
                  aria-hidden="true"
                  className="glass-popover absolute right-1.5 top-1.5 grid size-6 place-items-center rounded-full border-activity/40 text-activity-foreground shadow-sm"
                >
                  <Check size={13} />
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      <p className="text-caption text-muted-foreground">
        {t("workspaces.webPresetsHint")}
      </p>
    </section>
  );
}
