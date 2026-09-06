import { describe, expect, it } from "vitest";
import { isSupportedStrictSemanticVersion } from "../scripts/releaseVersionPolicy.mjs";

describe("shared release version syntax", () => {
  it.each(["0.0.0", "1.2.3", "31.2.7-rc.0", "1.2.3-alpha-beta.42", "999999999999999999999.0.1"])(
    "accepts canonical versions without coercing numeric identifiers: %s", (value) => {
      expect(isSupportedStrictSemanticVersion(value)).toBe(true);
    }
  );
  it.each(["01.2.3", "1.02.3", "1.2.03", "1.2.3-01", "1.2.3-alpha..1", "1.2.3+build", "v1.2.3", " 1.2.3", "1.2.3\n", null, 123, {}])(
    "rejects ambiguous or unsupported version input: %j", (value) => {
      expect(isSupportedStrictSemanticVersion(value)).toBe(false);
    }
  );
});
