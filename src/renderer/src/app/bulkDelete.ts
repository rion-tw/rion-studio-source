import type { BulkDeleteResult, BulkDeleteSkipReason } from "../../../shared/types";
import type { Translator } from "../i18n";

const reasonOrder: BulkDeleteSkipReason[] = ["protected", "in_use", "not_found", "busy", "failed"];

export function formatBulkDeleteResult(result: BulkDeleteResult, t: Translator): string {
  const deleted = result.deletedIds.length;
  const skipped = result.skipped.length;
  const summary = t("bulkDelete.result.summary")
    .replace("{deleted}", String(deleted))
    .replace("{skipped}", String(skipped));
  if (skipped === 0) {
    return summary;
  }

  const reasonCounts = new Map<BulkDeleteSkipReason, number>();
  result.skipped.forEach((item) => {
    reasonCounts.set(item.reason, (reasonCounts.get(item.reason) ?? 0) + 1);
  });
  const reasons = reasonOrder.flatMap((reason) => {
    const count = reasonCounts.get(reason);
    return count
      ? [t(`bulkDelete.reason.${reason}` as const).replace("{count}", String(count))]
      : [];
  });
  return `${summary} ${reasons.join(t("bulkDelete.reasonSeparator"))}`;
}
