import { describe, expect, it } from "vitest";
import { runEncodedPowerShellJson } from "../scripts/encodedPowerShell.mjs";
import { WINDOWS_PACKAGED_MAIN_WINDOW_HANDLERS } from "../scripts/packagedElectronBlackBox.mjs";

const homeButton = { name: "Home", type: "Button" };
const homeHeading = { name: "Home", type: "Text" };
const fixtureScript = String.raw`
function Rion-Windows([uint32]$processId) {
  return @($payload.windows | Where-Object { $_.processId -eq $processId })
}
function Rion-DescendantByName($window, [string]$name) {
  return @($window.controls | Where-Object { $_.name -eq $name })
}
function Rion-ButtonByName($window, [string]$name) {
  return @($window.controls | Where-Object { $_.name -eq $name -and $_.type -eq 'Button' })
}
`;

describe.runIf(process.platform === "win32")("native PowerShell packaged main-window selection", () => {
  it.each([
    { name: "no matching control", windows: [{ processId: 42, id: "empty", controls: [] }], expected: [] },
    { name: "one Home button and same-name heading", windows: [
      { processId: 42, id: "main", controls: [homeButton, homeHeading] },
      { processId: 43, id: "other-process", controls: [homeButton] }
    ], expected: ["main"] },
    { name: "ambiguous windows remain multiple candidates", windows: [
      { processId: 42, id: "first", controls: [homeButton] },
      { processId: 42, id: "second", controls: [homeButton] }
    ], expected: ["first", "second"] },
    { name: "ambiguous Home buttons do not identify the main window", windows: [
      { processId: 42, id: "ambiguous", controls: [homeButton, homeButton] }
    ], expected: [] }
  ])("$name", async ({ windows, expected }) => {
    // Only the UIA enumeration boundary is a fixture. The production selector
    // runs in real Windows PowerShell StrictMode; no native input is submitted.
    const result = await runEncodedPowerShellJson(
      `${fixtureScript}\n${WINDOWS_PACKAGED_MAIN_WINDOW_HANDLERS}\n` +
        'ConvertTo-Json -Compress -InputObject @(Rion-MainWindows 42 | ForEach-Object { $_.id })',
      { windows }, { timeoutMilliseconds: 8000 }
    );
    expect(JSON.parse(result)).toEqual(expected);
  });
});
