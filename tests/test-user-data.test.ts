import { describe, expect, it } from "vitest";

import { resolveTestUserDataPath } from "../src/main/testing/testUserData";

describe("test userData override", () => {
  it("accepts an absolute path only when explicit test mode is enabled", () => {
    expect(resolveTestUserDataPath({
      RION_STUDIO_TEST_MODE: "1",
      RION_STUDIO_TEST_USER_DATA_DIR: "/private/tmp/rion-test-data"
    })).toBe("/private/tmp/rion-test-data");
  });

  it("rejects accidental production or relative overrides", () => {
    expect(() => resolveTestUserDataPath({
      RION_STUDIO_TEST_USER_DATA_DIR: "/private/tmp/rion-test-data"
    })).toThrow("requires RION_STUDIO_TEST_MODE=1");
    expect(() => resolveTestUserDataPath({
      RION_STUDIO_TEST_MODE: "1",
      RION_STUDIO_TEST_USER_DATA_DIR: "relative-data"
    })).toThrow("must be an absolute path");
  });
});
