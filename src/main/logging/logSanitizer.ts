import { homedir, tmpdir } from "node:os";

import type { LogErrorDetails } from "../../shared/types";

const SENSITIVE_KEY = /(authorization|cookie|password|passwd|secret|session|token|api[-_]?key)/i;
const MAX_DEPTH = 5;
const MAX_KEYS = 40;
const MAX_STRING = 4_000;

function replacePaths(value: string, userDataPath?: string): string {
  const replacements = [
    [userDataPath, "<USER_DATA>"],
    [homedir(), "<HOME>"],
    [tmpdir(), "<TEMP>"]
  ] as const;
  let next = value;
  for (const [path, replacement] of replacements) {
    if (path) next = next.split(path).join(replacement);
  }
  return next;
}

export function sanitizeText(value: string, userDataPath?: string): string {
  // eslint-disable-next-line no-control-regex
  let text = replacePaths(value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ""), userDataPath);
  text = text.replace(/([?&](?:token|access_token|auth|key|secret|session)=)[^&#\s]*/gi, "$1<REDACTED>");
  try {
    const url = new URL(text);
    if (url.username || url.password || url.search || url.hash) {
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      text = url.toString();
    }
  } catch {
    // Most log messages are not URLs.
  }
  return text.length > MAX_STRING ? `${text.slice(0, MAX_STRING)}…` : text;
}

export function sanitizeValue(
  value: unknown,
  userDataPath?: string,
  depth = 0,
  seen = new WeakSet<object>()
): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return sanitizeText(value, userDataPath);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return undefined;
  if (depth >= MAX_DEPTH) return "<MAX_DEPTH>";
  if (value instanceof Error) return sanitizeError(value, userDataPath, depth, seen);
  if (typeof value !== "object") return sanitizeText(String(value), userDataPath);
  if (seen.has(value)) return "<CIRCULAR>";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.slice(0, MAX_KEYS).map((item) => sanitizeValue(item, userDataPath, depth + 1, seen));
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, MAX_KEYS)) {
    output[key] = SENSITIVE_KEY.test(key)
      ? "<REDACTED>"
      : sanitizeValue(item, userDataPath, depth + 1, seen);
  }
  return output;
}

export function sanitizeError(
  error: Error,
  userDataPath?: string,
  depth = 0,
  seen = new WeakSet<object>()
): LogErrorDetails {
  const result: LogErrorDetails = {
    name: sanitizeText(error.name || "Error", userDataPath),
    message: sanitizeText(error.message, userDataPath)
  };
  if (error.stack) result.stack = sanitizeText(error.stack, userDataPath);
  if (error.cause instanceof Error && depth < MAX_DEPTH && !seen.has(error.cause)) {
    seen.add(error.cause);
    result.cause = sanitizeError(error.cause, userDataPath, depth + 1, seen);
  }
  return result;
}
