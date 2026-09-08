import { describe, expect, it } from "vitest";
import { runEncodedPowerShellJson } from "../scripts/encodedPowerShell.mjs";

describe.runIf(process.platform === "win32")("native Windows PowerShell script terminality", () => {
  it("stops after the original exception even when a later statement would succeed", async () => {
    const result = await runEncodedPowerShellJson(
      'throw "primary-native-failure"\nWrite-Output "must-not-run"',
      {}, { timeoutMilliseconds: 8000 }
    ).then(output => ({ succeeded: true, output }), error => ({ succeeded: false, error }));
    expect(result.succeeded).toBe(false);
    if ("error" in result) {
      expect(result.error.code).toBe(1);
      expect(result.error.stderr).toContain("primary-native-failure");
      expect(result.error.stdout).not.toContain("must-not-run");
    }
  });

  it("runs finally but never continues past a failed native action", async () => {
    const result = await runEncodedPowerShellJson(
      'try { throw "primary-action-failure" } finally { Write-Output "cleanup-ran" }\nWrite-Output "must-not-run"',
      {}, { timeoutMilliseconds: 8000 }
    ).then(output => ({ succeeded: true, output }), error => ({ succeeded: false, error }));
    expect(result.succeeded).toBe(false);
    if ("error" in result) {
      expect(result.error.stderr).toContain("primary-action-failure");
      expect(result.error.stdout).toContain("cleanup-ran");
      expect(result.error.stdout).not.toContain("must-not-run");
    }
  });

  it("executes complete multiline declarations and preserves literal payload data", async () => {
    const output = await runEncodedPowerShellJson(String.raw`
function Read-FixtureValue {
  param($value)
  return $value
}
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::WriteLine((Read-FixtureValue $payload.value))
`, { value: "literal $([Environment]::Exit(99)) 文字" }, { timeoutMilliseconds: 8000 });
    expect(output).toBe("literal $([Environment]::Exit(99)) 文字");
  });
});
