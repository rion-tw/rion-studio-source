import { execFile } from "node:child_process";
import process from "node:process";

const PAYLOAD_ENVIRONMENT_KEY =
  "RION_STUDIO_ENCODED_POWERSHELL_JSON_PAYLOAD";
const MAX_PAYLOAD_BYTES = 12 * 1024;

const payloadPrelude = String.raw`
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$payloadBase64 = [Environment]::GetEnvironmentVariable(
  "RION_STUDIO_ENCODED_POWERSHELL_JSON_PAYLOAD",
  [System.EnvironmentVariableTarget]::Process
)
if ([String]::IsNullOrWhiteSpace($payloadBase64)) {
  throw "The encoded PowerShell JSON payload is unavailable."
}
try {
  $payloadBytes = [Convert]::FromBase64String($payloadBase64)
  $payloadJson = [Text.Encoding]::UTF8.GetString($payloadBytes)
  $payload = ConvertFrom-Json -InputObject $payloadJson
} catch {
  throw "The encoded PowerShell JSON payload is invalid."
} finally {
  [Environment]::SetEnvironmentVariable(
    "RION_STUDIO_ENCODED_POWERSHELL_JSON_PAYLOAD",
    $null,
    [System.EnvironmentVariableTarget]::Process
  )
}
`;

export function createEncodedPowerShellJsonInvocation(trustedScript, payload) {
  if (
    typeof trustedScript !== "string" || trustedScript.length === 0 ||
    trustedScript.includes("\0")
  ) {
    throw new Error("Encoded PowerShell requires a nonempty trusted script.");
  }
  if (
    !payload || typeof payload !== "object" || Array.isArray(payload) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(payload))
  ) {
    throw new Error("Encoded PowerShell requires a plain JSON payload object.");
  }
  let payloadJson;
  try {
    payloadJson = JSON.stringify(payload);
  } catch (error) {
    throw new Error("Encoded PowerShell could not serialize its JSON payload.", {
      cause: error
    });
  }
  if (typeof payloadJson !== "string") {
    throw new Error("Encoded PowerShell requires a serializable JSON payload.");
  }
  const payloadBytes = Buffer.from(payloadJson, "utf8");
  if (payloadBytes.length === 0 || payloadBytes.length > MAX_PAYLOAD_BYTES) {
    throw new Error("Encoded PowerShell JSON payload exceeds its safe bound.");
  }
  const encodedCommand = Buffer.from(
    `${payloadPrelude}\n${trustedScript}\n`,
    "utf16le"
  ).toString("base64");
  const standardInput = `${payloadPrelude}\n${trustedScript}\n`;
  return Object.freeze({
    arguments: Object.freeze([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      encodedCommand
    ]),
    environment: Object.freeze({
      [PAYLOAD_ENVIRONMENT_KEY]: payloadBytes.toString("base64")
    }),
    standardInput,
    standardInputArguments: Object.freeze([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "-"
    ])
  });
}

function executePowerShellStandardInput(invocation, timeoutMilliseconds) {
  return new Promise((resolve, reject) => {
    const child = execFile("powershell.exe", invocation.standardInputArguments, {
      encoding: "utf8",
      env: {
        ...process.env,
        ...invocation.environment
      },
      timeout: timeoutMilliseconds,
      windowsHide: true
    }, (error, stdout, stderr) => {
      if (error) {
        Object.assign(error, { stderr, stdout });
        reject(error);
        return;
      }
      resolve({ stderr, stdout });
    });
    if (!child.stdin) {
      child.kill();
      reject(new Error("PowerShell standard input is unavailable."));
      return;
    }
    child.stdin.on("error", () => undefined);
    child.stdin.end(invocation.standardInput, "utf8");
  });
}

export async function runEncodedPowerShellJson(
  trustedScript,
  payload,
  options = {}
) {
  const timeoutMilliseconds = options.timeoutMilliseconds;
  if (
    !Number.isSafeInteger(timeoutMilliseconds) ||
    timeoutMilliseconds <= 0 || timeoutMilliseconds > 120_000
  ) {
    throw new Error("Encoded PowerShell requires a bounded positive timeout.");
  }
  const invocation = createEncodedPowerShellJsonInvocation(
    trustedScript,
    payload
  );
  const result = await executePowerShellStandardInput(
    invocation,
    timeoutMilliseconds
  );
  return result.stdout.trim();
}
