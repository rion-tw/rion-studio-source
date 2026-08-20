import {
  AppWindow,
  Command,
  Gamepad2,
  House,
  Keyboard,
  LayoutDashboard,
  MoreHorizontal,
  PanelsTopLeft,
  Pin,
  PinOff,
  Plus,
  Save,
  Search,
  Settings,
  Users
} from "lucide-react";
import { type JSX, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "../../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "../../components/ui/dropdown-menu";
import { Surface } from "../../components/ui/patterns";
import type { Translator } from "../../i18n";
import { cn } from "../../lib/utils";
import type {
  EmbeddedRuntimeState,
  GameWindow,
  QuickAccessItemRef,
  RuntimeLaunchDestination
} from "../../../../shared/types";
import {
  createRuntimeLaunchDestinationModel,
  type RuntimeLaunchSource
} from "../game-windows/runtimeLaunchDestinationModel";
import {
  filterQuickAccessItems,
  type QuickAccessItem
} from "./quickAccessModel";
import type { QuickAccessCloseReason } from "./useQuickAccessPresentation";

interface QuickAccessPaletteProps {
  catalog: readonly QuickAccessItem[];
  gameWindows: readonly GameWindow[];
  open: boolean;
  runtime: EmbeddedRuntimeState;
  shortcutLabel: string;
  t: Translator;
  onExecute: (
    item: QuickAccessItem,
    destination?: RuntimeLaunchDestination
  ) => Promise<boolean>;
  onClose: (reason: QuickAccessCloseReason) => void;
  onDidClose: () => void;
  onSetPinned: (item: QuickAccessItemRef, pinned: boolean) => Promise<boolean>;
  restoreDomFocusOnClose: boolean;
}

const GROUP_LABEL_KEYS = {
  pages: "quickAccess.group.pages",
  pinned: "quickAccess.group.pinned",
  recent: "quickAccess.group.recent",
  results: "quickAccess.group.results"
} as const;

export function QuickAccessPalette({
  catalog,
  gameWindows,
  open,
  runtime,
  shortcutLabel,
  t,
  onClose,
  onDidClose,
  onExecute,
  onSetPinned,
  restoreDomFocusOnClose
}: QuickAccessPaletteProps): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isExecuting, setIsExecuting] = useState(false);
  const items = useMemo(() => filterQuickAccessItems(catalog, query), [catalog, query]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      restoreFocusRef.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
      dialog.showModal();
      inputRef.current?.focus();
      wasOpenRef.current = true;
      return;
    }

    if (!open && dialog.open) {
      dialog.close();
    }
    if (!open && wasOpenRef.current) {
      wasOpenRef.current = false;
      setQuery("");
      setSelectedIndex(0);
      setIsExecuting(false);
      if (restoreDomFocusOnClose) restoreFocusRef.current?.focus();
      restoreFocusRef.current = null;
      onDidClose();
    }
  }, [onDidClose, open, restoreDomFocusOnClose]);

  useEffect(() => {
    setSelectedIndex((current) => Math.min(current, Math.max(0, items.length - 1)));
  }, [items.length]);

  async function execute(
    item: QuickAccessItem,
    destination?: RuntimeLaunchDestination
  ): Promise<void> {
    if (item.disabled || isExecuting) return;
    setIsExecuting(true);
    const succeeded = await onExecute(item, destination);
    if (succeeded) {
      onClose("complete");
    } else {
      setIsExecuting(false);
      inputRef.current?.focus();
    }
  }

  function moveSelection(delta: number): void {
    if (items.length === 0) return;
    setSelectedIndex((current) => (current + delta + items.length) % items.length);
  }

  return (
    <dialog
      ref={dialogRef}
      aria-label={t("quickAccess.title")}
      className="app-dialog m-auto w-[min(680px,calc(100vw-2rem))] max-w-none border-0 bg-transparent p-0 text-foreground"
      data-testid="quick-access-palette"
      onCancel={(event) => {
        event.preventDefault();
        onClose("cancel");
      }}
    >
      <Surface className="overflow-hidden" radius="lg" variant="modal">
        <div className="flex items-center gap-2 border-b border-border/60 px-4">
          <Search aria-hidden="true" className="shrink-0 text-muted-foreground" size={18} />
          <input
            ref={inputRef}
            aria-controls="quick-access-results"
            aria-activedescendant={items[selectedIndex] ? quickAccessOptionId(items[selectedIndex]) : undefined}
            aria-autocomplete="list"
            className="h-14 min-w-0 flex-1 bg-transparent text-body font-medium text-foreground outline-none placeholder:text-muted-foreground"
            placeholder={t("quickAccess.placeholder")}
            role="combobox"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "ArrowDown") {
                event.preventDefault();
                moveSelection(1);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                moveSelection(-1);
              } else if (event.key === "Enter" && items[selectedIndex]) {
                event.preventDefault();
                void execute(items[selectedIndex]);
              } else if (event.key === "Escape") {
                event.preventDefault();
                onClose("cancel");
              }
            }}
          />
          <kbd className="rounded-sm border border-border/60 bg-muted/50 px-1.5 py-0.5 text-micro font-semibold text-muted-foreground">
            {shortcutLabel}
          </kbd>
        </div>

        <div
          id="quick-access-results"
          className="max-h-[min(520px,calc(100vh-10rem))] overflow-y-auto p-2"
          role="listbox"
        >
          {items.length === 0 ? (
            <div className="grid min-h-32 place-items-center px-4 text-center text-body text-muted-foreground">
              {t("quickAccess.empty")}
            </div>
          ) : items.map((item, index) => {
            const previousGroup = items[index - 1]?.group;
            return (
              <div key={item.key}>
                {item.group !== previousGroup ? (
                  <p className="px-2 pb-1 pt-3 text-caption font-semibold uppercase text-muted-foreground first:pt-1">
                    {t(GROUP_LABEL_KEYS[item.group])}
                  </p>
                ) : null}
                <QuickAccessResultRow
                  gameWindows={gameWindows}
                  isExecuting={isExecuting}
                  item={item}
                  portalContainer={dialogRef.current}
                  runtime={runtime}
                  selected={index === selectedIndex}
                  t={t}
                  onExecute={(destination) => void execute(item, destination)}
                  onPointerEnter={() => setSelectedIndex(index)}
                  onSetPinned={(pinned) => {
                    if (item.kind !== "route") void onSetPinned(item.ref, pinned);
                  }}
                />
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-between border-t border-border/60 px-4 py-2 text-caption text-muted-foreground">
          <span>{t("quickAccess.hint.navigate")}</span>
          <span>{t("quickAccess.hint.close")}</span>
        </div>
      </Surface>
    </dialog>
  );
}

function QuickAccessResultRow({
  gameWindows,
  isExecuting,
  item,
  portalContainer,
  runtime,
  selected,
  t,
  onExecute,
  onPointerEnter,
  onSetPinned
}: {
  gameWindows: readonly GameWindow[];
  isExecuting: boolean;
  item: QuickAccessItem;
  portalContainer: HTMLElement | null;
  runtime: EmbeddedRuntimeState;
  selected: boolean;
  t: Translator;
  onExecute: (destination?: RuntimeLaunchDestination) => void;
  onPointerEnter: () => void;
  onSetPinned: (pinned: boolean) => void;
}): JSX.Element {
  const canChooseDestination = item.kind === "role" || item.kind === "workspace";
  return (
    <div
      className={cn(
        "group flex min-h-12 items-center gap-1 rounded-sm border border-transparent px-1 transition-colors",
        selected && "border-border/45 bg-accent/50"
      )}
      onPointerEnter={onPointerEnter}
    >
      <button
        id={quickAccessOptionId(item)}
        aria-selected={selected}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-sm px-2 py-2 text-left outline-none disabled:opacity-45"
        disabled={item.disabled || isExecuting}
        role="option"
        type="button"
        onClick={() => onExecute()}
      >
        <span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted/60 text-muted-foreground">
          <QuickAccessItemIcon item={item} />
        </span>
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="truncate text-control font-semibold text-foreground">{item.label}</span>
          <span className="truncate text-caption text-muted-foreground">{item.subtitle}</span>
        </span>
        {item.active ? (
          <span className="shrink-0 rounded-full bg-activity/15 px-2 py-0.5 text-micro font-semibold text-activity">
            {t("quickAccess.active")}
          </span>
        ) : null}
      </button>

      {item.kind !== "route" ? (
        <Button
          aria-label={t(item.pinned ? "quickAccess.unpin" : "quickAccess.pin").replace("{name}", item.label)}
          disabled={isExecuting}
          size="icon"
          title={t(item.pinned ? "quickAccess.unpin" : "quickAccess.pin").replace("{name}", item.label)}
          type="button"
          variant="ghost"
          onClick={() => onSetPinned(!item.pinned)}
        >
          {item.pinned ? <PinOff size={14} /> : <Pin size={14} />}
        </Button>
      ) : null}

      {canChooseDestination ? (
        <QuickAccessDestinationMenu
          disabled={item.disabled || isExecuting}
          gameWindows={gameWindows}
          portalContainer={portalContainer}
          runtime={runtime}
          source={{ type: item.kind, id: item.ref.id }}
          t={t}
          onSelect={onExecute}
        />
      ) : null}
    </div>
  );
}

function QuickAccessDestinationMenu({
  disabled,
  gameWindows,
  portalContainer,
  runtime,
  source,
  t,
  onSelect
}: {
  disabled: boolean;
  gameWindows: readonly GameWindow[];
  portalContainer: HTMLElement | null;
  runtime: EmbeddedRuntimeState;
  source: RuntimeLaunchSource;
  t: Translator;
  onSelect: (destination: RuntimeLaunchDestination) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const model = createRuntimeLaunchDestinationModel(gameWindows, runtime, source, t);
  return (
    <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={t("launchDestination.openIn")}
          data-testid={`quick-access-destination-${source.type}-${source.id}`}
          disabled={disabled || Boolean(model.sourceOwnerWindowId)}
          size="icon"
          title={model.sourceOwnerWindowId
            ? t("quickAccess.destinationOwned")
            : t("launchDestination.openIn")}
          type="button"
          variant="ghost"
          onClick={() => {
            if (!open) setOpen(true);
          }}
        >
          <MoreHorizontal size={14} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-64" portalContainer={portalContainer}>
        <DropdownMenuItem
          className="gap-2"
          data-testid="quick-access-destination-option-new-window"
          onSelect={() => onSelect({ kind: "new-window" })}
        >
          <Plus size={14} />
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
                data-testid={option.destination.kind === "game-window"
                  ? `quick-access-destination-option-window-${option.destination.windowId}`
                  : undefined}
                disabled={option.disabled}
                onSelect={() => onSelect(option.destination)}
              >
                <AppWindow size={14} />
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
                data-testid={option.destination.kind === "game-window"
                  ? `quick-access-destination-option-window-${option.destination.windowId}`
                  : undefined}
                disabled={option.disabled}
                onSelect={() => onSelect(option.destination)}
              >
                <Save size={14} />
                <DestinationText detail={option.detail} label={option.label} />
              </DropdownMenuItem>
            ))}
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
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

function quickAccessOptionId(item: QuickAccessItem): string {
  return `quick-access-option-${item.key.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function QuickAccessItemIcon({ item }: { item: QuickAccessItem }): JSX.Element {
  if (item.kind === "role") return <Users aria-hidden="true" size={16} />;
  if (item.kind === "workspace") return <LayoutDashboard aria-hidden="true" size={16} />;
  if (item.kind === "gameWindow") return <PanelsTopLeft aria-hidden="true" size={16} />;
  if (item.kind === "macro") return <Keyboard aria-hidden="true" size={16} />;
  if (item.routeId === "dashboard") return <House aria-hidden="true" size={16} />;
  if (item.routeId === "games") return <Gamepad2 aria-hidden="true" size={16} />;
  if (item.routeId === "roles") return <Users aria-hidden="true" size={16} />;
  if (item.routeId === "workspaces") return <LayoutDashboard aria-hidden="true" size={16} />;
  if (item.routeId === "gameWindows") return <PanelsTopLeft aria-hidden="true" size={16} />;
  if (item.routeId === "macros") return <Keyboard aria-hidden="true" size={16} />;
  if (item.routeId === "settings") return <Settings aria-hidden="true" size={16} />;
  return <Command aria-hidden="true" size={16} />;
}
