import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import { createEncodedPowerShellJsonInvocation } from
  "../scripts/encodedPowerShell.mjs";

describe("encoded PowerShell JSON transport", () => {
  it("keeps caller-controlled names and paths out of command text", () => {
    const payload = {
      buttonName: "Click `$([Environment]::Exit(73)) {ENTER}",
      outputPath:
        "C:\\evidence\\$([IO.File]::WriteAllText('owned','1'))`-shot.png",
      processId: 42_001,
      roleName: "Role `$([Environment]::Exit(91)) (alpha)"
    };

    const invocation = createEncodedPowerShellJsonInvocation(
      "Write-Output ([string]$payload.roleName)",
      payload
    );

    expect(invocation.arguments.slice(0, -1)).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand"
    ]);
    const encodedCommand = invocation.arguments.at(-1);
    expect(encodedCommand).toBeTypeOf("string");
    const command = Buffer.from(encodedCommand!, "base64").toString("utf16le");
    expect(command).toContain("ConvertFrom-Json");
    expect(command).toContain("$payload.roleName");
    expect(command).not.toContain(payload.buttonName);
    expect(command).not.toContain(payload.outputPath);
    expect(command).not.toContain(payload.roleName);
    expect(invocation.arguments.join(" ")).not.toContain("Environment]::Exit");

    const payloadValues = Object.values(invocation.environment);
    expect(payloadValues).toHaveLength(1);
    expect(JSON.parse(
      Buffer.from(payloadValues[0], "base64").toString("utf8")
    )).toEqual(payload);
    expect(Object.isFrozen(invocation)).toBe(true);
    expect(Object.isFrozen(invocation.arguments)).toBe(true);
    expect(Object.isFrozen(invocation.environment)).toBe(true);
  });

  it("round-trips Unicode JSON without adding trailing command arguments", () => {
    const payload = {
      outputPath: "C:\\證據\\角色 ` $() 截圖.png",
      roleName: "角色—Chromium 🧭"
    };
    const invocation = createEncodedPowerShellJsonInvocation(
      "Write-Output ([string]$payload.outputPath)",
      payload
    );

    expect(invocation.arguments).toHaveLength(5);
    const [encodedPayload] = Object.values(invocation.environment);
    expect(JSON.parse(Buffer.from(encodedPayload, "base64").toString("utf8")))
      .toEqual(payload);
  });

  it("rejects non-plain and oversized payloads", () => {
    expect(() => createEncodedPowerShellJsonInvocation(
      "exit 0",
      [] as unknown as Readonly<Record<string, unknown>>
    ))
      .toThrow("plain JSON payload");
    expect(() => createEncodedPowerShellJsonInvocation(
      "exit 0",
      new Date() as unknown as Readonly<Record<string, unknown>>
    ))
      .toThrow("plain JSON payload");
    expect(() => createEncodedPowerShellJsonInvocation("exit 0", {
      value: "x".repeat(13 * 1024)
    })).toThrow("safe bound");
  });
});
