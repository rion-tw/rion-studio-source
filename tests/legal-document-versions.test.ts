import { describe, expect, it } from "vitest";

import {
  CURRENT_LEGAL_DOCUMENT_VERSIONS,
  getLegalDocumentVersion
} from "../src/shared/legal";

describe("legal document versions", () => {
  it("reports the current legal document versions", () => {
    expect(CURRENT_LEGAL_DOCUMENT_VERSIONS).toEqual({
      fairUse: "2026-09-13",
      privacy: "2026-09-13",
      terms: "2026-09-13"
    });
    expect(getLegalDocumentVersion("privacy")).toBe("2026-09-13");
    expect(getLegalDocumentVersion("thirdParty")).toBe("2026-09-13");
  });
});
