import type { SafeTarGzipExtractionSummary } from "./safeTarGzipExtraction.mjs";

export function restoreElectronUnsignedInputArchive(
  argumentsList: readonly string[]
): Promise<SafeTarGzipExtractionSummary>;
