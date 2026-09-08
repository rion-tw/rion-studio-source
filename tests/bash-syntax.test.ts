import { describe, expect, it } from "vitest";

import { assertBashSyntax } from "./helpers/bashSyntax";

describe("workflow Bash syntax harness", () => {
  it("parses each program without executing exit or command substitutions", () => {
    expect(() => assertBashSyntax([
      "exit 23",
      "printf '%s' \"$(exit 29)\""
    ], process.platform)).not.toThrow();
  });

  it("rejects invalid programs even when concatenation would repair them", () => {
    expect(() => assertBashSyntax([
      "if true; then",
      "fi"
    ], process.platform)).toThrow();
  });

  it("rejects a source that could escape the literal parser input", () => {
    expect(() => assertBashSyntax([
      "RION_BASH_SYNTAX_INPUT_0\nexit 23"
    ], process.platform)).toThrow("literal input delimiter");
  });
});
