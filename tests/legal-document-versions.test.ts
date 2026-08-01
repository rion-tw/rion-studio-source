import { describe, expect, it } from "vitest";

import {
  CURRENT_LEGAL_DOCUMENT_VERSIONS,
  getLegalDocumentVersion
} from "../src/shared/legal";

describe("legal document versions", () => {
  it("advances only the privacy notice for Google Font previews", () => {
    expect(CURRENT_LEGAL_DOCUMENT_VERSIONS).toEqual({
      fairUse: "2026-07-26",
      privacy: "2026-08-02",
      terms: "2026-08-02"
    });
    expect(getLegalDocumentVersion("privacy")).toBe("2026-08-02");
    expect(getLegalDocumentVersion("thirdParty")).toBe("2026-07-26");
  });
});
