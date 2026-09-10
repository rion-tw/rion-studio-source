import type { AppLanguage } from "../../../../shared/types";

export function formatExtensionBytes(bytes: number, language: AppLanguage): string {
  if (!Number.isSafeInteger(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${new Intl.NumberFormat(language).format(bytes)} B`;
  if (bytes < 1024 ** 2) {
    return `${formatSizeValue(bytes / 1024, language)} KB`;
  }
  return `${formatSizeValue(bytes / 1024 ** 2, language)} MB`;
}

function formatSizeValue(value: number, language: AppLanguage): string {
  return new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(value);
}
