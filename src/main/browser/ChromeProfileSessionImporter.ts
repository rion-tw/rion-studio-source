import { execFile as execFileCallback } from "node:child_process";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import type { Session } from "electron";
import { DatabaseSync } from "node:sqlite";

import type { Role } from "../../shared/types";

const execFile = promisify(execFileCallback);
const CHROME_EPOCH_OFFSET_SECONDS = 11_644_473_600;

interface ChromeCookieRow {
  host_key: string;
  name: string;
  value: string;
  path: string;
  expires_utc: number | bigint;
  is_secure: number;
  is_httponly: number;
  samesite: number;
  encrypted_value: Uint8Array | Buffer | string;
}

export interface ChromeProfileSessionImporterOptions {
  platform?: NodeJS.Platform;
  decryptCookie?: (encryptedValue: Uint8Array) => Promise<string>;
  decryptMacCookie?: (encryptedValue: Uint8Array) => Promise<string>;
  decryptWindowsCookie?: (encryptedValue: Uint8Array) => Promise<string>;
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
    const cookiesPath = await firstExistingPath([
      join(browserUserDataDir, "Default", "Network", "Cookies"),
      join(browserUserDataDir, "Default", "Cookies")
    ]);
    if (!(await pathExists(cookiesPath))) {
      return;
    }

    const cookies = this.readCookies(cookiesPath);
    for (const cookie of cookies) {
      const host = cookie.host_key.startsWith(".") ? cookie.host_key.slice(1) : cookie.host_key;
      if (!host || !cookie.name) continue;

      const value = await this.resolveCookieValue(cookie.encrypted_value, cookie.value);
      const expirationDate = toUnixExpiration(cookie.expires_utc);
      if (expirationDate !== undefined && expirationDate <= Date.now() / 1000) continue;

      await session.cookies.set({
        url: `${cookie.is_secure ? "https" : "http"}://${host}${cookie.path || "/"}`,
        name: cookie.name,
        value,
        domain: cookie.host_key,
        path: cookie.path || "/",
        secure: cookie.is_secure === 1,
        httpOnly: cookie.is_httponly === 1,
        sameSite: normalizeSameSite(cookie.samesite),
        ...(expirationDate === undefined ? {} : { expirationDate })
      });
    }

    session.flushStorageData();
    // The role argument is intentionally part of this boundary so callers
    // cannot accidentally inject a profile without having selected a role.
    void role;
  }

  private readCookies(cookiesPath: string): ChromeCookieRow[] {
    const database = new DatabaseSync(cookiesPath, { readOnly: true });
    try {
      const rows = database.prepare(`
        SELECT host_key, name, value, path, expires_utc, is_secure,
               is_httponly, samesite, encrypted_value
        FROM cookies
      `).all() as unknown as ChromeCookieRow[];
      return rows;
    } finally {
      database.close();
    }
  }

  private async resolveCookieValue(encryptedValue: Uint8Array | Buffer | string, plainValue: string): Promise<string> {
    const bytes = toBytes(encryptedValue);
    if (bytes.length === 0) return plainValue;
    if (this.options.decryptCookie) return this.options.decryptCookie(bytes);

    if (this.platform === "darwin") {
      return this.options.decryptMacCookie?.(bytes) ?? decryptMacChromeCookie(bytes);
    }
    if (this.platform === "win32") {
      return this.options.decryptWindowsCookie?.(bytes) ?? decryptWindowsChromeCookie(bytes);
    }
    throw new Error("Chrome cookie decryption is supported only on macOS and Windows.");
  }
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

function normalizeSameSite(value: number): "unspecified" | "no_restriction" | "lax" | "strict" {
  if (value === 0) return "no_restriction";
  if (value === 2) return "strict";
  if (value === 1) return "lax";
  return "unspecified";
}

async function readMacChromeSafeStorageKey(): Promise<Buffer> {
  const result = await execFile("security", ["find-generic-password", "-w", "-s", "Chrome Safe Storage"]);
  const password = result.stdout.trim();
  if (!password) throw new Error("Chrome Safe Storage key is unavailable.");
  return pbkdf2Sync(Buffer.from(password), Buffer.from("saltysalt"), 1003, 16, "sha1");
}

async function decryptMacChromeCookie(encryptedValue: Uint8Array): Promise<string> {
  const bytes = Buffer.from(encryptedValue);
  if (bytes.length < 4) throw new Error("Chrome cookie ciphertext is invalid.");
  const key = await readMacChromeSafeStorageKey();
  const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([decipher.update(bytes.subarray(3)), decipher.final()]);
  return decrypted.toString("utf8").replace(/\0+$/g, "");
}

async function decryptWindowsChromeCookie(encryptedValue: Uint8Array): Promise<string> {
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
  return Buffer.from(decoded, "base64").toString("utf8");
}
