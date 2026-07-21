import { createCipheriv, createHash } from "node:crypto";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { Session } from "electron";
import { describe, expect, it, vi } from "vitest";

import {
  ChromeProfileSessionImporter,
  decryptMacChromeCookiePayload
} from "../src/main/browser/ChromeProfileSessionImporter";

describe("ChromeProfileSessionImporter", () => {
  it.each([
    ["darwin", "Cookies"],
    ["darwin", join("Network", "Cookies")],
    ["win32", "Cookies"],
    ["win32", join("Network", "Cookies")]
  ] as const)("reads the Chrome cookie database on %s from Default/%s", async (platform, relativePath) => {
    const root = await mkdtemp(join(tmpdir(), "rion-chrome-session-"));
    const cookiesPath = join(root, "Default", relativePath);
    await mkdir(join(cookiesPath, ".."), { recursive: true });
    const database = new DatabaseSync(cookiesPath);
    database.exec(`
      CREATE TABLE meta (
        key TEXT NOT NULL UNIQUE PRIMARY KEY,
        value INTEGER
      );
      INSERT INTO meta (key, value) VALUES ('version', 24);
      CREATE TABLE cookies (
        host_key TEXT NOT NULL,
        name TEXT NOT NULL,
        value TEXT NOT NULL,
        path TEXT NOT NULL,
        expires_utc INTEGER NOT NULL,
        is_secure INTEGER NOT NULL,
        is_httponly INTEGER NOT NULL,
        samesite INTEGER NOT NULL,
        encrypted_value BLOB NOT NULL
      )
    `);
    database.prepare(`
      INSERT INTO cookies
        (host_key, name, value, path, expires_utc, is_secure, is_httponly, samesite, encrypted_value)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ".example.test",
      "session",
      "",
      "/game",
      13430861709618063n,
      1,
      1,
      2,
      Buffer.from("encrypted")
    );
    database.close();

    const setCookie = vi.fn().mockResolvedValue(undefined);
    const flushStorageData = vi.fn();
    const session = {
      cookies: { set: setCookie },
      flushStorageData
    } as unknown as Session;
    const domainHash = createHash("sha256").update(".example.test").digest();
    const decryptMacCookie = vi.fn(async (value: Uint8Array) => Buffer.concat([
      domainHash,
      Buffer.from(`mac:${Buffer.from(value).toString("utf8")}`)
    ]));
    const decryptWindowsCookie = vi.fn(async (value: Uint8Array) => Buffer.concat([
      domainHash,
      Buffer.from(`windows:${Buffer.from(value).toString("utf8")}`)
    ]));
    const importer = new ChromeProfileSessionImporter({
      decryptMacCookie,
      decryptWindowsCookie,
      platform
    });

    await importer.importSession({ id: "role-1" } as never, root, session);

    expect(setCookie).toHaveBeenCalledWith({
      domain: ".example.test",
      httpOnly: true,
      name: "session",
      path: "/game",
      sameSite: "strict",
      secure: true,
      url: "https://example.test/game",
      value: platform === "darwin" ? "mac:encrypted" : "windows:encrypted",
      expirationDate: expect.any(Number)
    });
    const decryptor = platform === "darwin" ? decryptMacCookie : decryptWindowsCookie;
    expect(decryptor).toHaveBeenCalledWith(expect.any(Uint8Array));
    expect(Buffer.from(decryptor.mock.calls[0][0])).toEqual(Buffer.from("encrypted"));
    expect(flushStorageData).toHaveBeenCalledOnce();
  });

  it("does not require a cookie database when DOM storage was copied only", async () => {
    const root = await mkdtemp(join(tmpdir(), "rion-chrome-session-"));
    const session = {
      cookies: { set: vi.fn() },
      flushStorageData: vi.fn()
    } as unknown as Session;
    const importer = new ChromeProfileSessionImporter({ platform: "darwin" });

    await expect(importer.importSession({ id: "role-1" } as never, root, session)).resolves.toBeUndefined();
    expect(session.cookies.set).not.toHaveBeenCalled();
    expect(session.flushStorageData).not.toHaveBeenCalled();
  });

  it.each(["darwin", "win32"] as const)(
    "preserves host-only semantics for prefixed cookies on %s",
    async (platform) => {
      const root = await mkdtemp(join(tmpdir(), "rion-chrome-session-"));
      const cookiesPath = join(root, "Default", "Cookies");
      await mkdir(join(cookiesPath, ".."), { recursive: true });
      const database = new DatabaseSync(cookiesPath);
      database.exec(`
        CREATE TABLE cookies (
          host_key TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL,
          path TEXT NOT NULL, expires_utc INTEGER NOT NULL, is_secure INTEGER NOT NULL,
          is_httponly INTEGER NOT NULL, samesite INTEGER NOT NULL, encrypted_value BLOB NOT NULL
        );
      `);
      const insertCookie = database.prepare(`
        INSERT INTO cookies
          (host_key, name, value, path, expires_utc, is_secure, is_httponly, samesite, encrypted_value)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insertCookie.run(
        "host.example.test",
        "__Host-session",
        "host-value",
        "/",
        0,
        1,
        1,
        2,
        Buffer.alloc(0)
      );
      insertCookie.run(
        ".example.test",
        "__Secure-session",
        "secure-value",
        "/game",
        0,
        1,
        1,
        2,
        Buffer.alloc(0)
      );
      database.close();

      const setCookie = vi.fn().mockResolvedValue(undefined);
      const session = {
        cookies: { set: setCookie },
        flushStorageData: vi.fn()
      } as unknown as Session;
      const importer = new ChromeProfileSessionImporter({ platform });

      await importer.importSession({ id: "role-1" } as never, root, session);

      expect(setCookie).toHaveBeenCalledWith({
        httpOnly: true,
        name: "__Host-session",
        path: "/",
        sameSite: "strict",
        secure: true,
        url: "https://host.example.test/",
        value: "host-value"
      });
      expect(setCookie).toHaveBeenCalledWith({
        domain: ".example.test",
        httpOnly: true,
        name: "__Secure-session",
        path: "/game",
        sameSite: "strict",
        secure: true,
        url: "https://example.test/game",
        value: "secure-value"
      });
      expect(setCookie).toHaveBeenCalledTimes(2);
    }
  );

  it("removes Chromium AES-CBC padding before injecting macOS cookies", () => {
    const key = Buffer.alloc(16, 0x11);
    const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
    const encrypted = Buffer.concat([
      Buffer.from("v10"),
      cipher.update(Buffer.from("session-value")),
      cipher.final()
    ]);

    expect(decryptMacChromeCookiePayload(encrypted, key)).toEqual(Buffer.from("session-value"));
  });

  it("rejects a schema-v24 cookie whose encrypted domain hash does not match", async () => {
    const root = await mkdtemp(join(tmpdir(), "rion-chrome-session-"));
    const cookiesPath = join(root, "Default", "Cookies");
    await mkdir(join(cookiesPath, ".."), { recursive: true });
    const database = new DatabaseSync(cookiesPath);
    database.exec(`
      CREATE TABLE meta (key TEXT NOT NULL UNIQUE PRIMARY KEY, value INTEGER);
      INSERT INTO meta (key, value) VALUES ('version', 24);
      CREATE TABLE cookies (
        host_key TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL,
        path TEXT NOT NULL, expires_utc INTEGER NOT NULL, is_secure INTEGER NOT NULL,
        is_httponly INTEGER NOT NULL, samesite INTEGER NOT NULL, encrypted_value BLOB NOT NULL
      );
    `);
    database.prepare(`
      INSERT INTO cookies
        (host_key, name, value, path, expires_utc, is_secure, is_httponly, samesite, encrypted_value)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(".example.test", "session", "", "/", 0, 1, 1, 0, Buffer.from("encrypted"));
    database.close();

    const session = {
      cookies: { set: vi.fn() },
      flushStorageData: vi.fn()
    } as unknown as Session;
    const importer = new ChromeProfileSessionImporter({
      decryptCookie: async () => Buffer.concat([
        createHash("sha256").update(".wrong.test").digest(),
        Buffer.from("session-value")
      ]),
      platform: "darwin"
    });

    await expect(importer.importSession({ id: "role-1" } as never, root, session))
      .rejects.toThrow("Chrome cookie domain integrity check failed.");
    expect(session.cookies.set).not.toHaveBeenCalled();
  });
});
