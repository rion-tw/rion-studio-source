import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { LegalAcceptanceStore } from "../src/main/legal/LegalAcceptanceStore";
import { CURRENT_LEGAL_DOCUMENT_VERSIONS } from "../src/shared/legal";

describe("LegalAcceptanceStore", () => {
  it("requires acceptance when no record exists", async () => {
    const store = new LegalAcceptanceStore(await createUserDataDir());

    await expect(store.getStatus()).resolves.toEqual({
      currentVersions: CURRENT_LEGAL_DOCUMENT_VERSIONS,
      isAccepted: false
    });
  });

  it("atomically persists the current accepted versions and timestamp", async () => {
    const userDataDir = await createUserDataDir();
    const store = new LegalAcceptanceStore(userDataDir, {
      now: () => new Date("2026-07-14T09:30:00.000Z")
    });

    const status = await store.accept({
      fairUseVersion: CURRENT_LEGAL_DOCUMENT_VERSIONS.fairUse,
      privacyVersion: CURRENT_LEGAL_DOCUMENT_VERSIONS.privacy,
      termsVersion: CURRENT_LEGAL_DOCUMENT_VERSIONS.terms
    });

    expect(status).toMatchObject({
      acceptedAt: "2026-07-14T09:30:00.000Z",
      acceptedFairUseVersion: "2026-07-14",
      acceptedTermsVersion: "2026-07-14",
      acknowledgedPrivacyVersion: "2026-07-14",
      isAccepted: true
    });
    await expect(access(join(userDataDir, "legal-acceptance.json.tmp"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(join(userDataDir, "legal-acceptance.json"), "utf8"))).toMatchObject({
      schemaVersion: 1,
      acceptedTermsVersion: "2026-07-14"
    });
  });

  it("fails closed for corrupt, incomplete, and superseded records", async () => {
    const userDataDir = await createUserDataDir();
    const acceptancePath = join(userDataDir, "legal-acceptance.json");
    await writeFile(acceptancePath, "not-json", "utf8");
    await expect(new LegalAcceptanceStore(userDataDir).isAccepted()).resolves.toBe(false);

    await writeFile(
      acceptancePath,
      JSON.stringify({
        schemaVersion: 1,
        acceptedAt: "2026-07-14T00:00:00.000Z",
        acceptedTermsVersion: "2026-01-01",
        acceptedFairUseVersion: "2026-07-14",
        acknowledgedPrivacyVersion: "2026-07-14"
      }),
      "utf8"
    );
    await expect(new LegalAcceptanceStore(userDataDir).isAccepted()).resolves.toBe(false);
  });

  it("rejects acceptance for stale document versions", async () => {
    const store = new LegalAcceptanceStore(await createUserDataDir());

    await expect(
      store.accept({
        fairUseVersion: CURRENT_LEGAL_DOCUMENT_VERSIONS.fairUse,
        privacyVersion: CURRENT_LEGAL_DOCUMENT_VERSIONS.privacy,
        termsVersion: "old"
      })
    ).rejects.toThrow("Legal document versions are out of date");
  });
});

async function createUserDataDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "rion-legal-test-"));
}
