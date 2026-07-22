import type { Session } from "electron";

import type { Role } from "../../shared/types";

export interface ChromeProfileSessionImporterOptions {
  /** Rust reads SQLite and performs Keychain/DPAPI decryption. */
  readCookies: (browserUserDataDir: string) => Promise<ImportedChromeCookie[]>;
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

/** Applies Rust-decoded Chrome cookies to the Electron-owned session. */
export class ChromeProfileSessionImporter {
  constructor(private readonly options: ChromeProfileSessionImporterOptions) {}

  async importSession(role: Role, browserUserDataDir: string, session: Session): Promise<void> {
    const cookies = await this.options.readCookies(browserUserDataDir);
    for (const cookie of cookies) {
      await setCookieUnlessRejected(session, cookie);
    }
    session.flushStorageData();

    // Keep role selection explicit at the Electron boundary so callers cannot
    // inject a copied profile into a session without an owning role.
    void role;
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
