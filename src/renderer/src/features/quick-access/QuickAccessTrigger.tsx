import { Search } from "lucide-react";
import type { JSX } from "react";

import type { Translator } from "../../i18n";

export function QuickAccessTrigger({
  shortcutLabel,
  t,
  onOpen
}: {
  shortcutLabel: string;
  t: Translator;
  onOpen: () => void;
}): JSX.Element {
  return (
    <button
      className="app-no-drag glass-control flex h-[var(--control-height)] w-full items-center gap-2 rounded-sm px-2 text-control font-medium text-sidebar-foreground/72 transition-[background-color,border-color,color,box-shadow] hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/20"
      data-testid="quick-access-trigger"
      type="button"
      onClick={onOpen}
    >
      <Search aria-hidden="true" size={15} />
      <span className="min-w-0 flex-1 truncate text-left">{t("quickAccess.open")}</span>
      <kbd className="rounded-sm border border-border/45 px-1.5 py-0.5 text-micro font-semibold text-sidebar-foreground/55">
        {shortcutLabel}
      </kbd>
    </button>
  );
}
