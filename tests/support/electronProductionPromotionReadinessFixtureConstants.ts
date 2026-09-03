import { createHash } from "node:crypto";

export const SOURCE_SHA = "a".repeat(40);
export const TAURI_SOURCE_SHA = "b".repeat(40);
export const PRIOR_ELECTRON_SOURCE_SHA = "c".repeat(40);
export const VERSION = "8.6.0";
export const PRIOR_ELECTRON_VERSION = "8.5.0";
export const TAURI_VERSION = "8.4.2";
export const TAURI_RELEASE_TAG = `v${TAURI_VERSION}`;
export const TAURI_LINEAGE_RUN_ID = "303";
export const TAURI_LINEAGE_RUN_ATTEMPT = 1;
export const PROVISIONAL_PUBLICATION_RUN_ID = "404";
export const PROVISIONAL_PUBLICATION_RUN_ATTEMPT = 1;
export const CANDIDATE_CONTROL_SHA = "d".repeat(40);
export const PRIOR_CANDIDATE_CONTROL_SHA = "e".repeat(40);
export const EVIDENCE_CONTROL_SHA = "f".repeat(40);
export const PROVISIONAL_PUBLICATION_CONTROL_SHA = "1".repeat(40);
export const TAURI_LINEAGE_CONTROL_SHA = "2".repeat(40);
export const READINESS_CONTROL_SHA = "3".repeat(40);
export const TAURI_TRANSITION = "tauri-v22-to-electron-v23";
export const ELECTRON_TRANSITION = "electron-v23-to-electron-v23";
export const DARWIN = "darwin-aarch64";
export const WINDOWS = "windows-x86_64";
export const TAURI_FETCH_ENDPOINT =
  "https://github.com/rion-tw/rion-studio/releases/latest/download/latest.json";
export const SCREENSHOT_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);
export const TAURI_FINAL_ENDPOINT =
  "https://release-assets.githubusercontent.com/github-production-release-asset/123/latest.json?token=fixture";
export const PUBLISHED_AT = "2026-09-01T00:00:00Z";
export const UPDATER_BASE_URL = "https://updates.example.test/rion/v23";
export const PUBLIC_KEY = "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
export const SIGNATURE = [
  "untrusted comment: signature from minisign secret key",
  "RUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=",
  "trusted comment: timestamp:1633700835\tfile:test\tprehashed",
  "wLMDjy9FLAuxZ3q4NlEvkgtyhrr0gtTu6KC4KBJdITbbOeAi1zBIYo0v4iTgt8jJpIidRJnp94ABQkJAgAooBQ==",
  ""
].join("\n");
export const CHALLENGE_ID = "10000000-0000-4000-8000-000000000001";
export const CHALLENGE_SHA256 = createHash("sha256")
  .update("fresh-promotion-challenge")
  .digest("hex");

export type AttachmentName =
  | "data-preservation-observation.json"
  | "endpoint-observation.json"
  | "native-host-observation.json"
  | "product-terminal-receipt.json"
  | "source-event-stream.jsonl"
  | "source-install-journal.json"
  | "source-release-snapshot.json"
  | "target-terminal-record.json";

export type MutableEvidenceInput = {
  evidenceDirectory: string;
  evidenceReceiptSha256: Record<string, Record<string, string>>;
};

export const SOURCE_EVENTS = [
  ["source-updater-invoked", "checking", "2026-09-01T00:10:00Z"],
  ["target-manifest-observed", "checking", "2026-09-01T00:12:00Z"],
  ["target-artifact-verified", "downloaded", "2026-09-01T00:15:00Z"],
  ["source-install-accepted", "accepted", "2026-09-01T00:18:00Z"],
  ["source-install-prepared", "installing", "2026-09-01T00:19:00Z"],
  ["source-drain-started", "draining", "2026-09-01T00:20:00Z"],
  ["source-handoff", null, "2026-09-01T00:22:00Z"],
  ["target-first-boot", null, "2026-09-01T00:25:00Z"],
  ["target-terminal", "applied", "2026-09-01T00:30:00Z"]
] as const;

export interface CandidateReceiptFixture {
  assets: Record<string, string>;
  platforms: Record<
    typeof DARWIN | typeof WINDOWS,
    {
      artifact: {
        fileName: string;
        sha256: string;
        signatureFileName: string;
        signatureSha256: string;
      };
      blackBox: { executable: { sha256: string } };
    }
  >;
  publicKeySha256: string;
  updaterEndpoint: string;
}
