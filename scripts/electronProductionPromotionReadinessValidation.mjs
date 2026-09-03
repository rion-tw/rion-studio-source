import {
  assertEqual,
  assertExactKeys
} from "./electronUpdaterCompatibilityReceiptIo.mjs";

export function assertExactRecord(actual, expected, label) {
  assertExactKeys(actual, Object.keys(expected), label);
  for (const [key, value] of Object.entries(expected)) {
    assertEqual(actual[key], value, `${label} ${key}`);
  }
}

export function requiredSemanticVersion(value, label) {
  const normalized = requiredString(value, label);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(normalized)) {
    throw new Error(`The ${label} must be a semantic version without a leading v.`);
  }
  return normalized;
}

export function requiredReleaseTag(value) {
  const tag = requiredString(value, "Tauri v22 release tag");
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(tag)) {
    throw new Error("The Tauri v22 release tag must be an exact semantic v-tag.");
  }
  return tag;
}

export function requiredHttpsUpdaterEndpoint(value, label) {
  const normalized = requiredString(value, label);
  let url;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error(`The ${label} must be one exact HTTPS latest.json URL.`);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.endsWith("/latest.json") ||
    url.href !== normalized
  ) {
    throw new Error(`The ${label} must be one exact HTTPS latest.json URL.`);
  }
  return normalized;
}

export function requiredUuid(value, label) {
  const normalized = requiredString(value, label);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(normalized)) {
    throw new Error(`The ${label} must be a lowercase RFC 9562 UUID.`);
  }
  return normalized;
}

export function requiredSourceInstallAttemptId(value, label, transition) {
  const normalized = requiredString(value, label);
  if (transition === "tauri-v22-to-electron-v23") {
    const match = /^update-install-([1-9]\d*)$/u.exec(normalized);
    if (!match || BigInt(match[1]) > 18_446_744_073_709_551_615n) {
      throw new Error(`The ${label} must be an exact Tauri v22 update-install sequence.`);
    }
    return normalized;
  }
  if (transition === "electron-v23-to-electron-v23") {
    const prefix = "update-install-";
    if (!normalized.startsWith(prefix)) {
      throw new Error(`The ${label} must be an exact Electron v23 update-install UUID.`);
    }
    requiredUuid(normalized.slice(prefix.length), label);
    return normalized;
  }
  throw new Error(`The ${label} transition is unsupported.`);
}

export function requiredRunId(value, label) {
  if (typeof value !== "string" || !/^[1-9]\d*$/u.test(value)) {
    throw new Error(`The ${label} must be a positive decimal GitHub run ID.`);
  }
  return value;
}

export function requiredRfc3339(value, label) {
  const normalized = requiredString(value, label);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/u.exec(normalized);
  if (!match) {
    throw new Error(`The ${label} must be RFC 3339.`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = Number(match[8] ?? 0);
  const offsetMinute = Number(match[9] ?? 0);
  const monthLengths = [31, isGregorianLeapYear(year) ? 29 : 28, 31, 30, 31, 30,
    31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > monthLengths[month - 1] ||
      hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) {
    throw new Error(`The ${label} is not a valid timestamp.`);
  }
  const parsed = Date.parse(normalized);
  if (Number.isNaN(parsed)) throw new Error(`The ${label} is not a valid timestamp.`);
  return parsed;
}

function isGregorianLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`The ${label} must be a positive safe integer.`);
  }
}

export function assertNonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`The ${label} must be a nonnegative safe integer.`);
  }
}

export function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`The ${label} is required.`);
  }
  return value;
}
