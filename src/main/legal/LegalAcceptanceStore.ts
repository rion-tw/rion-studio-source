import { CURRENT_LEGAL_DOCUMENT_VERSIONS } from "../../shared/legal";
import type {
  AcceptLegalDocumentsInput,
  LegalAcceptanceStatus,
  LegalDocumentVersions
} from "../../shared/types";
import type { AppCoreClient } from "../core/nativeCore";

interface LegalAcceptanceStoreOptions {
  core: Pick<AppCoreClient, "invoke">;
  versions?: LegalDocumentVersions;
}

/** Thin Electron-facing client for the Rust-owned legal acceptance domain. */
export class LegalAcceptanceStore {
  private readonly versions: LegalDocumentVersions;

  constructor(_userDataDir: string, private readonly options: LegalAcceptanceStoreOptions) {
    this.versions = options.versions ?? CURRENT_LEGAL_DOCUMENT_VERSIONS;
  }

  getStatus(): Promise<LegalAcceptanceStatus> {
    return this.options.core.invoke({
      type: "legalAcceptanceStatus",
      versions: this.versions
    });
  }

  async isAccepted(): Promise<boolean> {
    return (await this.getStatus()).isAccepted;
  }

  accept(input: AcceptLegalDocumentsInput): Promise<LegalAcceptanceStatus> {
    return this.options.core.invoke({
      type: "legalAcceptanceAccept",
      versions: this.versions,
      input
    });
  }
}
