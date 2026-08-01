import type { LegalDocumentVersions } from "./types";

export const CURRENT_LEGAL_DOCUMENT_VERSIONS = {
  fairUse: "2026-07-26",
  privacy: "2026-08-02",
  terms: "2026-08-02"
} as const satisfies LegalDocumentVersions;

export function getLegalDocumentVersion(
  kind: keyof LegalDocumentVersions | "thirdParty"
): string {
  return kind === "thirdParty" ? "2026-07-26" : CURRENT_LEGAL_DOCUMENT_VERSIONS[kind];
}

export const LEGAL_PROVIDER_NAME = "Rion Studio project";
