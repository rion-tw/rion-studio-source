import { describe, expect, it, vi } from "vitest";

import { LegalAcceptanceStore } from "../src/main/legal/LegalAcceptanceStore";
import { CURRENT_LEGAL_DOCUMENT_VERSIONS } from "../src/shared/legal";

describe("LegalAcceptanceStore", () => {
  it("reads the Rust-owned acceptance status", async () => {
    const invoke = vi.fn(async () => ({
      currentVersions: CURRENT_LEGAL_DOCUMENT_VERSIONS,
      isAccepted: false
    }));
    const store = new LegalAcceptanceStore("/unused", { core: { invoke } as never });

    await expect(store.getStatus()).resolves.toEqual({
      currentVersions: CURRENT_LEGAL_DOCUMENT_VERSIONS,
      isAccepted: false
    });
    expect(invoke).toHaveBeenCalledWith({
      type: "legalAcceptanceStatus"
    });
  });

  it("delegates version validation, timestamping and persistence to Rust", async () => {
    const accepted = {
      acceptedAt: "2026-07-14T09:30:00.000Z",
      acceptedFairUseVersion: "2026-07-14",
      acceptedTermsVersion: "2026-07-14",
      acknowledgedPrivacyVersion: "2026-07-14",
      currentVersions: CURRENT_LEGAL_DOCUMENT_VERSIONS,
      isAccepted: true
    };
    const invoke = vi.fn(async () => accepted);
    const store = new LegalAcceptanceStore("/unused", { core: { invoke } as never });
    const input = {
      fairUseVersion: CURRENT_LEGAL_DOCUMENT_VERSIONS.fairUse,
      privacyVersion: CURRENT_LEGAL_DOCUMENT_VERSIONS.privacy,
      termsVersion: CURRENT_LEGAL_DOCUMENT_VERSIONS.terms
    };

    await expect(store.accept(input)).resolves.toEqual(accepted);
    expect(invoke).toHaveBeenCalledWith({
      type: "legalAcceptanceAccept",
      input
    });
  });

  it("preserves stable Rust validation errors", async () => {
    const error = Object.assign(new Error("Legal document versions are out of date."), {
      code: "LEGAL_VERSIONS_OUTDATED"
    });
    const store = new LegalAcceptanceStore("/unused", {
      core: { invoke: vi.fn(async () => { throw error; }) } as never
    });

    await expect(store.accept({
      fairUseVersion: CURRENT_LEGAL_DOCUMENT_VERSIONS.fairUse,
      privacyVersion: CURRENT_LEGAL_DOCUMENT_VERSIONS.privacy,
      termsVersion: "old"
    })).rejects.toMatchObject({ code: "LEGAL_VERSIONS_OUTDATED" });
  });
});
