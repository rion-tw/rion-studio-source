import { execFile as execFileCallback } from "node:child_process";
import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import type { Session } from "electron";
import { DatabaseSync } from "node:sqlite";

import type { Role } from "../../shared/types";

const execFile = promisify(execFileCallback);
const CHROME_EPOCH_OFFSET_SECONDS = 11_644_473_600;
const DOMAIN_HASH_SCHEMA_VERSION = 24;
const SHA256_LENGTH = 32;

type DecryptedChromeCookieValue = string | Uint8Array;

interface ChromeCookieRow {
  host_key: string;
  name: string;
  value: string;
  path: string;
  expires_utc: number | bigint;
  is_secure: number | bigint;
  is_httponly: number | bigint;
  samesite: number | bigint;
  encrypted_value: Uint8Array | Buffer | string;
}

interface ChromeCookieDatabase {
  cookies: ChromeCookieRow[];
  schemaVersion: number;
}

export interface ChromeProfileSessionImporterOptions {
  platform?: NodeJS.Platform;
  decryptCookie?: (encryptedValue: Uint8Array) => Promise<DecryptedChromeCookieValue>;
  decryptMacCookie?: (encryptedValue: Uint8Array) => Promise<DecryptedChromeCookieValue>;
  decryptWindowsCookie?: (encryptedValue: Uint8Array) => Promise<DecryptedChromeCookieValue>;
  readCookies?: (browserUserDataDir: string) => Promise<ImportedChromeCookie[]>;
}

export interface ImportedChromeCookie {
  domain?: string;
  expirationDate?: number;
  httpOnly: boolean;
  name: string;
  path: string;
  sameSite: "unspecified" | "no_restriction" | "lax" | "strict";
  secure: boolean;
  url: string;
  value: string;
}

/**
 * Imports the parts of a Chrome profile that Electron cannot transparently
 * read, while leaving the copied DOM storage databases in the role's session
 * directory for Chromium to open normally.
 */
export class ChromeProfileSessionImporter {
  private readonly platform: NodeJS.Platform;

  constructor(private readonly options: ChromeProfileSessionImporterOptions = {}) {
    this.platform = options.platform ?? process.platform;
  }

  async importSession(role: Role, browserUserDataDir: string, session: Session): Promise<void> {
    if (this.options.readCookies) {
      const cookies = await this.options.readCookies(browserUserDataDir);
      for (const cookie of cookies) {
        await setCookieUnlessRejected(session, cookie);
      }
      session.flushStorageData();
      void role;
      return;
    }
    const cookiesPath = await firstExistingPath([
      join(browserUserDataDir, "Default", "Network", "Cookies"),
      join(browserUserDataDir, "Default", "Cookies")
    ]);
    if (!(await pathExists(cookiesPath))) {
      return;
    }

    const { cookies, schemaVersion } = this.readCookies(cookiesPath);
    for (const cookie of cookies) {
      const isDomainCookie = cookie.host_key.startsWith(".");
      const host = isDomainCookie ? cookie.host_key.slice(1) : cookie.host_key;
      if (!host || !cookie.name) continue;

      const value = await this.resolveCookieValue(
        cookie.encrypted_value,
        cookie.value,
        cookie.host_key,
        schemaVersion
      );
      const expirationDate = toUnixExpiration(cookie.expires_utc);
      if (expirationDate !== undefined && expirationDate <= Date.now() / 1000) continue;
      const path = cookie.path || "/";
      const secure = Number(cookie.is_secure) === 1;

      await setCookieUnlessRejected(session, {
        url: `${secure ? "https" : "http"}://${host}${path}`,
        name: cookie.name,
        value,
        ...(isDomainCookie ? { domain: cookie.host_key } : {}),
        path,
        secure,
        httpOnly: Number(cookie.is_httponly) === 1,
        sameSite: normalizeSameSite(cookie.samesite),
        ...(expirationDate === undefined ? {} : { expirationDate })
      });
    }

    session.flushStorageData();
    // The role argument is intentionally part of this boundary so callers
    // cannot accidentally inject a profile without having selected a role.
    void role;
  }

  private readCookies(cookiesPath: string): ChromeCookieDatabase {
    // Chrome stores expires_utc as a 17-digit microsecond timestamp. Reading
    // SQLite integers as JS numbers makes node:sqlite reject that value before
    // we can convert it, so keep integer columns as bigint.
    const database = new DatabaseSync(cookiesPath, { readOnly: true, readBigInts: true });
    try {
      const rows = database.prepare(`
        SELECT host_key, name, value, path, expires_utc, is_secure,
               is_httponly, samesite, encrypted_value
        FROM cookies
      `).all() as unknown as ChromeCookieRow[];
      return {
        cookies: rows,
        schemaVersion: readCookieDatabaseVersion(database)
      };
    } finally {
      database.close();
    }
  }

  private async resolveCookieValue(
    encryptedValue: Uint8Array | Buffer | string,
    plainValue: string,
    hostKey: string,
    schemaVersion: number
  ): Promise<string> {
    const bytes = toBytes(encryptedValue);
    if (bytes.length === 0) return plainValue;

    let decryptedValue: DecryptedChromeCookieValue;
    if (this.options.decryptCookie) {
      decryptedValue = await this.options.decryptCookie(bytes);
    } else if (this.platform === "darwin") {
      decryptedValue = await (this.options.decryptMacCookie?.(bytes) ?? decryptMacChromeCookie(bytes));
    } else if (this.platform === "win32") {
      decryptedValue = await (this.options.decryptWindowsCookie?.(bytes) ?? decryptWindowsChromeCookie(bytes));
    } else {
      throw new Error("Chrome cookie decryption is supported only on macOS and Windows.");
    }

    let valueBytes: Buffer = typeof decryptedValue === "string"
      ? Buffer.from(decryptedValue, "utf8")
      : Buffer.from(decryptedValue);
    if (schemaVersion >= DOMAIN_HASH_SCHEMA_VERSION) {
      valueBytes = removeAndVerifyDomainHash(valueBytes, hostKey);
    }

    const value = valueBytes.toString("utf8");
    if (containsDisallowedCookieCharacter(value)) {
      throw new Error("Chrome cookie decryption produced a value with disallowed control characters.");
    }
    return value;
  }
}

async function setCookieUnlessRejected(session: Session, cookie: ImportedChromeCookie): Promise<void> {
  try {
    await session.cookies.set(cookie);
  } catch (error) {
    if (!isDisallowedCookieCharacterError(error)) throw error;
  }
}

function isDisallowedCookieCharacterError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.includes("EXCLUDE_DISALLOWED_CHARACTER")
    || error.message.includes("The cookie contains ASCII control characters");
}

function containsDisallowedCookieCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

function readCookieDatabaseVersion(database: DatabaseSync): number {
  try {
    const row = database.prepare("SELECT value FROM meta WHERE key = 'version'").get() as
      | { value?: number | bigint | string }
      | undefined;
    const version = Number(row?.value);
    return Number.isSafeInteger(version) && version >= 0 ? version : 0;
  } catch {
    return 0;
  }
}

function removeAndVerifyDomainHash(value: Buffer, hostKey: string): Buffer {
  const expectedHash = createHash("sha256").update(hostKey, "utf8").digest();
  if (value.length < SHA256_LENGTH || !value.subarray(0, SHA256_LENGTH).equals(expectedHash)) {
    throw new Error("Chrome cookie domain integrity check failed.");
  }
  return value.subarray(SHA256_LENGTH);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function firstExistingPath(paths: string[]): Promise<string> {
  for (const path of paths) {
    if (await pathExists(path)) return path;
  }
  return paths[0];
}

function toBytes(value: Uint8Array | Buffer | string): Uint8Array {
  if (typeof value === "string") return Buffer.from(value, "binary");
  return new Uint8Array(value);
}

function toUnixExpiration(value: number | bigint): number | undefined {
  const chromeMicroseconds = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isFinite(chromeMicroseconds) || chromeMicroseconds <= 0) return undefined;
  return chromeMicroseconds / 1_000_000 - CHROME_EPOCH_OFFSET_SECONDS;
}

function normalizeSameSite(value: number | bigint): "unspecified" | "no_restriction" | "lax" | "strict" {
  const normalized = Number(value);
  if (normalized === 0) return "no_restriction";
  if (normalized === 2) return "strict";
  if (normalized === 1) return "lax";
  return "unspecified";
}

async function readMacChromeSafeStorageKey(): Promise<Buffer> {
  const result = await execFile("security", ["find-generic-password", "-w", "-s", "Chrome Safe Storage"]);
  const password = result.stdout.trim();
  if (!password) throw new Error("Chrome Safe Storage key is unavailable.");
  return pbkdf2Sync(Buffer.from(password), Buffer.from("saltysalt"), 1003, 16, "sha1");
}

async function decryptMacChromeCookie(encryptedValue: Uint8Array): Promise<Buffer> {
  const bytes = Buffer.from(encryptedValue);
  if (bytes.length < 4) throw new Error("Chrome cookie ciphertext is invalid.");
  const key = await readMacChromeSafeStorageKey();
  return decryptMacChromeCookiePayload(bytes, key);
}

export function decryptMacChromeCookiePayload(encryptedValue: Uint8Array, key: Uint8Array): Buffer {
  const bytes = Buffer.from(encryptedValue);
  if (bytes.length < 4) throw new Error("Chrome cookie ciphertext is invalid.");
  const ciphertext = bytes.subarray(3);

  try {
    // Chromium's AES-CBC implementation uses PKCS padding. Leaving padding
    // enabled prevents its padding bytes (ASCII control characters) from
    // being passed to Electron as part of the cookie value.
    const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted;
  } catch {
    // Older Chrome databases can contain the legacy zero-padded form.
    const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
    decipher.setAutoPadding(false);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    let end = decrypted.length;
    while (end > 0 && decrypted[end - 1] === 0) end -= 1;
    return decrypted.subarray(0, end);
  }
}

async function decryptWindowsChromeCookie(encryptedValue: Uint8Array): Promise<Buffer> {
  const payload = Buffer.from(encryptedValue);
  const encoded = payload.subarray(payload.subarray(0, 3).toString("ascii").startsWith("v") ? 3 : 0)
    .toString("base64");
  const script = [
    "Add-Type -AssemblyName System.Security;",
    "$b=[Convert]::FromBase64String($args[0]);",
    "$u=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);",
    "[Convert]::ToBase64String($u)"
  ].join(" ");
  const result = await execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script, encoded]);
  const decoded = result.stdout.trim();
  if (!decoded) throw new Error("Windows DPAPI returned an empty Chrome cookie.");
  return Buffer.from(decoded, "base64");
}
