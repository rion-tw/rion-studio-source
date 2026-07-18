import { describe, expect, it } from "vitest";

import { sanitizeError, sanitizeText, sanitizeValue } from "../src/main/logging/logSanitizer";

describe("log sanitizer", () => {
  it("redacts sensitive fields, URL credentials, query values and local paths", () => {
    const value = sanitizeValue({
      authorization: "Bearer private",
      nested: { token: "abc", url: "https://user:pass@example.com/play?token=abc#secret" },
      path: "/users/test/Rion/logs/file"
    }, "/users/test/Rion");

    expect(value).toEqual({
      authorization: "<REDACTED>",
      nested: { token: "<REDACTED>", url: "https://example.com/play" },
      path: "<USER_DATA>/logs/file"
    });
  });

  it("handles cycles, long strings and error causes", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(sanitizeValue(cyclic)).toEqual({ self: "<CIRCULAR>" });

    const cause = new Error("token failure in /app/data");
    const error = new Error("outer", { cause });
    const sanitized = sanitizeError(error, "/app/data");
    expect(sanitized.cause?.message).toBe("token failure in <USER_DATA>");
    expect(sanitizeText("x".repeat(5_000))).toHaveLength(4_001);
  });
});
