import type { LegalDocumentVersions } from "./types";

export const CURRENT_LEGAL_RELEASE = "2026-07-14";

export const CURRENT_LEGAL_DOCUMENT_VERSIONS = {
  fairUse: CURRENT_LEGAL_RELEASE,
  privacy: CURRENT_LEGAL_RELEASE,
  terms: CURRENT_LEGAL_RELEASE
} as const satisfies LegalDocumentVersions;

export const LEGAL_PROVIDER_NAME = "Rion Studio project";
