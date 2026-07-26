import type {
  AcceptLegalDocumentsInput,
  LegalAcceptanceStatus
} from "../../shared/types";
import type { AppCoreClient } from "../core/nativeCore";

interface LegalAcceptanceStoreOptions {
  core: Pick<AppCoreClient, "invoke">;
}

/** Thin Electron-facing client for the Rust-owned legal acceptance domain. */
export class LegalAcceptanceStore {
  constructor(_userDataDir: string, private readonly options: LegalAcceptanceStoreOptions) {}

  getStatus(): Promise<LegalAcceptanceStatus> {
    return this.options.core.invoke({
      type: "legalAcceptanceStatus"
    });
  }

  async isAccepted(): Promise<boolean> {
    return (await this.getStatus()).isAccepted;
  }

  accept(input: AcceptLegalDocumentsInput): Promise<LegalAcceptanceStatus> {
    return this.options.core.invoke({
      type: "legalAcceptanceAccept",
      input
    });
  }
}
