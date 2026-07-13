import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { CURRENT_LEGAL_DOCUMENT_VERSIONS } from "../../shared/legal";
import type {
  AcceptLegalDocumentsInput,
  LegalAcceptanceStatus,
  LegalDocumentVersions
} from "../../shared/types";

interface LegalAcceptanceFile {
  acceptedAt: string;
  acceptedFairUseVersion: string;
  acceptedTermsVersion: string;
  acknowledgedPrivacyVersion: string;
  schemaVersion: 1;
}

interface LegalAcceptanceStoreOptions {
  now?: () => Date;
  versions?: LegalDocumentVersions;
}

export class LegalAcceptanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LegalAcceptanceError";
  }
}

export class LegalAcceptanceStore {
  private readonly acceptancePath: string;
  private readonly now: () => Date;
  private readonly versions: LegalDocumentVersions;

  constructor(userDataDir: string, options: LegalAcceptanceStoreOptions = {}) {
    this.acceptancePath = join(userDataDir, "legal-acceptance.json");
    this.now = options.now ?? (() => new Date());
    this.versions = options.versions ?? CURRENT_LEGAL_DOCUMENT_VERSIONS;
  }

  async getStatus(): Promise<LegalAcceptanceStatus> {
    const file = await this.readAcceptanceFile();
    const isAccepted = Boolean(
      file &&
        file.acceptedTermsVersion === this.versions.terms &&
        file.acceptedFairUseVersion === this.versions.fairUse &&
        file.acknowledgedPrivacyVersion === this.versions.privacy
    );

    return {
      currentVersions: { ...this.versions },
      isAccepted,
      ...(file
        ? {
            acceptedAt: file.acceptedAt,
            acceptedFairUseVersion: file.acceptedFairUseVersion,
            acceptedTermsVersion: file.acceptedTermsVersion,
            acknowledgedPrivacyVersion: file.acknowledgedPrivacyVersion
          }
        : {})
    };
  }

  async isAccepted(): Promise<boolean> {
    return (await this.getStatus()).isAccepted;
  }

  async accept(input: AcceptLegalDocumentsInput): Promise<LegalAcceptanceStatus> {
    if (
      input.termsVersion !== this.versions.terms ||
      input.fairUseVersion !== this.versions.fairUse ||
      input.privacyVersion !== this.versions.privacy
    ) {
      throw new LegalAcceptanceError("Legal document versions are out of date.");
    }

    const acceptedAt = this.now().toISOString();
    if (Number.isNaN(Date.parse(acceptedAt))) {
      throw new LegalAcceptanceError("Legal acceptance time is invalid.");
    }

    const file: LegalAcceptanceFile = {
      acceptedAt,
      acceptedFairUseVersion: input.fairUseVersion,
      acceptedTermsVersion: input.termsVersion,
      acknowledgedPrivacyVersion: input.privacyVersion,
      schemaVersion: 1
    };

    await mkdir(dirname(this.acceptancePath), { recursive: true });
    const tmpPath = `${this.acceptancePath}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    await rename(tmpPath, this.acceptancePath);
    return this.getStatus();
  }

  private async readAcceptanceFile(): Promise<LegalAcceptanceFile | null> {
    try {
      const parsed = JSON.parse(await readFile(this.acceptancePath, "utf8")) as unknown;
      return normalizeAcceptanceFile(parsed);
    } catch {
      return null;
    }
  }
}

function normalizeAcceptanceFile(value: unknown): LegalAcceptanceFile | null {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    return null;
  }

  const acceptedAt = readNonEmptyString(value.acceptedAt);
  const acceptedTermsVersion = readNonEmptyString(value.acceptedTermsVersion);
  const acceptedFairUseVersion = readNonEmptyString(value.acceptedFairUseVersion);
  const acknowledgedPrivacyVersion = readNonEmptyString(value.acknowledgedPrivacyVersion);

  if (
    !acceptedAt ||
    Number.isNaN(Date.parse(acceptedAt)) ||
    !acceptedTermsVersion ||
    !acceptedFairUseVersion ||
    !acknowledgedPrivacyVersion
  ) {
    return null;
  }

  return {
    acceptedAt,
    acceptedFairUseVersion,
    acceptedTermsVersion,
    acknowledgedPrivacyVersion,
    schemaVersion: 1
  };
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
