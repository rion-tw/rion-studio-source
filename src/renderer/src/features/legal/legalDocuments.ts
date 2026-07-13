import fairUseEn from "../../../../../docs/legal/fair-use.en.md?raw";
import fairUseJa from "../../../../../docs/legal/fair-use.ja.md?raw";
import fairUseZhCn from "../../../../../docs/legal/fair-use.zh-CN.md?raw";
import fairUseZhTw from "../../../../../docs/legal/fair-use.zh-TW.md?raw";
import privacyEn from "../../../../../docs/legal/privacy.en.md?raw";
import privacyJa from "../../../../../docs/legal/privacy.ja.md?raw";
import privacyZhCn from "../../../../../docs/legal/privacy.zh-CN.md?raw";
import privacyZhTw from "../../../../../docs/legal/privacy.zh-TW.md?raw";
import termsEn from "../../../../../docs/legal/terms.en.md?raw";
import termsJa from "../../../../../docs/legal/terms.ja.md?raw";
import termsZhCn from "../../../../../docs/legal/terms.zh-CN.md?raw";
import termsZhTw from "../../../../../docs/legal/terms.zh-TW.md?raw";
import thirdPartyNotices from "../../../../../docs/legal/THIRD_PARTY_NOTICES.md?raw";

import type { Language } from "../../i18n";

export type LegalDocumentKind = "terms" | "privacy" | "fairUse" | "thirdParty";

const localizedDocuments: Record<Exclude<LegalDocumentKind, "thirdParty">, Record<Language, string>> = {
  fairUse: {
    en: fairUseEn,
    ja: fairUseJa,
    "zh-CN": fairUseZhCn,
    "zh-TW": fairUseZhTw
  },
  privacy: {
    en: privacyEn,
    ja: privacyJa,
    "zh-CN": privacyZhCn,
    "zh-TW": privacyZhTw
  },
  terms: {
    en: termsEn,
    ja: termsJa,
    "zh-CN": termsZhCn,
    "zh-TW": termsZhTw
  }
};

export function getLegalDocument(kind: LegalDocumentKind, language: Language): string {
  return kind === "thirdParty" ? thirdPartyNotices : localizedDocuments[kind][language];
}
