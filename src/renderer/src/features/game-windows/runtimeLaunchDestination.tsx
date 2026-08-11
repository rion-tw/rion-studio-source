import { AppWindow, Plus, Save } from "lucide-react";
import type { JSX } from "react";

import {
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger
} from "../../components/ui/context-menu";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from "../../components/ui/dropdown-menu";
import type { Translator } from "../../i18n";
import type {
  EmbeddedRuntimeState,
  GameWindow,
  RuntimeLaunchDestination
} from "../../../../shared/types";
import {
  createRuntimeLaunchDestinationModel,
  type RuntimeLaunchSource
} from "./runtimeLaunchDestinationModel";

interface RuntimeLaunchDestinationMenuProps {
  disabled?: boolean;
  gameWindows: readonly GameWindow[];
  onSelect: (destination: RuntimeLaunchDestination) => void;
  runtime: EmbeddedRuntimeState;
  source: RuntimeLaunchSource;
  t: Translator;
}

export function RuntimeLaunchDestinationDropdownSubmenu({
  disabled = false,
  gameWindows,
  onSelect,
  runtime,
  source,
  t
}: RuntimeLaunchDestinationMenuProps): JSX.Element {
  const model = createRuntimeLaunchDestinationModel(gameWindows, runtime, source, t);
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={disabled || Boolean(model.sourceOwnerWindowId)}>
        <AppWindow size={14} />
        <span>{t("launchDestination.openIn")}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="min-w-64">
        <DropdownMenuItem
          className="gap-2"
          onSelect={() => onSelect({ kind: "new-window" })}
        >
          <Plus className="shrink-0" size={14} />
          <DestinationText
            detail={t("launchDestination.newWindow.detail")}
            label={t("launchDestination.newWindow")}
          />
        </DropdownMenuItem>
        {model.live.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{t("launchDestination.liveWindows")}</DropdownMenuLabel>
            {model.live.map((option) => (
              <DropdownMenuItem
                key={option.id}
                className="gap-2"
                disabled={option.disabled}
                onSelect={() => onSelect(option.destination)}
              >
                <AppWindow className="shrink-0" size={14} />
                <DestinationText detail={option.detail} label={option.label} />
              </DropdownMenuItem>
            ))}
          </>
        ) : null}
        {model.saved.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{t("launchDestination.savedWindows")}</DropdownMenuLabel>
            {model.saved.map((option) => (
              <DropdownMenuItem
                key={option.id}
                className="gap-2"
                disabled={option.disabled}
                onSelect={() => onSelect(option.destination)}
              >
                <Save className="shrink-0" size={14} />
                <DestinationText detail={option.detail} label={option.label} />
              </DropdownMenuItem>
            ))}
          </>
        ) : null}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

export function RuntimeLaunchDestinationContextSubmenu({
  disabled = false,
  gameWindows,
  onSelect,
  runtime,
  source,
  t
}: RuntimeLaunchDestinationMenuProps): JSX.Element {
  const model = createRuntimeLaunchDestinationModel(gameWindows, runtime, source, t);
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger disabled={disabled || Boolean(model.sourceOwnerWindowId)}>
        <AppWindow size={14} />
        <span>{t("launchDestination.openIn")}</span>
      </ContextMenuSubTrigger>
      <ContextMenuSubContent className="min-w-64">
        <ContextMenuItem
          className="gap-2"
          onSelect={() => onSelect({ kind: "new-window" })}
        >
          <Plus className="shrink-0" size={14} />
          <DestinationText
            detail={t("launchDestination.newWindow.detail")}
            label={t("launchDestination.newWindow")}
          />
        </ContextMenuItem>
        {model.live.length > 0 ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuLabel>{t("launchDestination.liveWindows")}</ContextMenuLabel>
            {model.live.map((option) => (
              <ContextMenuItem
                key={option.id}
                className="gap-2"
                disabled={option.disabled}
                onSelect={() => onSelect(option.destination)}
              >
                <AppWindow className="shrink-0" size={14} />
                <DestinationText detail={option.detail} label={option.label} />
              </ContextMenuItem>
            ))}
          </>
        ) : null}
        {model.saved.length > 0 ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuLabel>{t("launchDestination.savedWindows")}</ContextMenuLabel>
            {model.saved.map((option) => (
              <ContextMenuItem
                key={option.id}
                className="gap-2"
                disabled={option.disabled}
                onSelect={() => onSelect(option.destination)}
              >
                <Save className="shrink-0" size={14} />
                <DestinationText detail={option.detail} label={option.label} />
              </ContextMenuItem>
            ))}
          </>
        ) : null}
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}

function DestinationText({ detail, label }: { detail: string; label: string }): JSX.Element {
  return (
    <span className="grid min-w-0 flex-1 gap-0.5">
      <span className="truncate font-medium">{label}</span>
      <span className="truncate text-micro text-muted-foreground">{detail}</span>
    </span>
  );
}
