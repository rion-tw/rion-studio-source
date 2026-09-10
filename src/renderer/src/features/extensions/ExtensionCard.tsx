import { Puzzle } from "lucide-react";

import type { ExtensionPackageRecord, ExtensionRoleRecord } from "../../../../shared/generated";
import type { AppLanguage } from "../../../../shared/types";
import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";
import { Surface } from "../../components/ui/patterns";
import type { Translator } from "../../i18n";
import { formatExtensionBytes } from "./extensionSize";

interface ExtensionCardProps {
  language: AppLanguage;
  packageRecord: ExtensionPackageRecord;
  runtimeRoles: ExtensionRoleRecord[];
  t: Translator;
  onManage: () => void;
}

export function ExtensionCard({ language, packageRecord, runtimeRoles, t, onManage }: ExtensionCardProps) {
  const hasLoadFailure = runtimeRoles.some((role) =>
    role.extensionIds.includes(packageRecord.id) && role.status === "failed"
  );
  const roleSummary = packageRecord.applyToAllRoles
    ? t("extensions.allRoles")
    : `${packageRecord.enabledRoleIds.length} ${t("extensions.roles")}`;
  const description = packageRecord.description?.trim() || t("extensions.noDescription");
  const size = packageRecord.sizeBytes === undefined
    ? t("extensions.sizeUnavailable")
    : formatExtensionBytes(packageRecord.sizeBytes, language);

  return (
    <li className="min-w-0" data-extension-id={packageRecord.id}>
      <Surface className="flex h-full min-w-0 flex-col gap-3 p-4" variant="strong">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-lg text-muted-foreground">
            {packageRecord.iconDataUrl ? (
              <img
                alt=""
                aria-hidden="true"
                className="size-full object-contain"
                decoding="async"
                draggable={false}
                loading="lazy"
                src={packageRecord.iconDataUrl}
              />
            ) : (
              <Puzzle aria-hidden="true" size={22} />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-heading font-semibold" title={packageRecord.name}>
              {packageRecord.name}
            </h2>
            <p className="mt-0.5 truncate text-caption tabular-nums text-muted-foreground">
              {packageRecord.version} · {roleSummary}
            </p>
          </div>
        </div>

        <p className="line-clamp-2 min-h-10 text-control text-muted-foreground" data-extension-description title={description}>
          {description}
        </p>

        <dl className="grid min-w-0 gap-1.5 rounded-md border border-border/35 bg-background/20 px-2.5 py-2 text-caption">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <dt className="shrink-0 text-muted-foreground">{t("extensions.size")}</dt>
            <dd className="min-w-0 truncate tabular-nums text-foreground" data-extension-size title={size}>{size}</dd>
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <dt className="shrink-0 text-muted-foreground">{t("extensions.id")}</dt>
            <dd className="min-w-0 flex-1 truncate text-right font-mono text-micro text-foreground" data-extension-record-id title={packageRecord.id}>
              {packageRecord.id}
            </dd>
          </div>
        </dl>

        {packageRecord.removed || hasLoadFailure ? (
          <div className="flex flex-wrap gap-1">
            {packageRecord.removed ? <Badge variant="warning">{t("extensions.removalPending")}</Badge> : null}
            {hasLoadFailure ? <Badge variant="destructive">{t("extensions.loadFailed")}</Badge> : null}
          </div>
        ) : null}

        <Button className="mt-auto w-full" variant="outline" onClick={onManage}>
          {t(packageRecord.removed ? "extensions.retryRemoval" : "extensions.manage")}
        </Button>
      </Surface>
    </li>
  );
}
