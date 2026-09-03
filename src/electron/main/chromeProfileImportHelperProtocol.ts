import { RionBridgeError } from "../ipc/errors";

export const CHROME_PROFILE_IMPORT_HELPER_MAX_METADATA_BYTES = 1024 * 1024;
export const CHROME_PROFILE_IMPORT_HELPER_MAX_SECRET_BYTES =
  64 * 1024 * 1024 + 32;

const REQUEST_MAGIC = Buffer.from("RCHREQ01", "ascii");
const RESPONSE_MAGIC = Buffer.from("RCHRES01", "ascii");
const REQUEST_HEADER_BYTES = 16;
const RESPONSE_HEADER_BYTES = 20;

export type ChromeProfileImportHelperOutcome =
  | "applied"
  | "failed"
  | "indeterminate";

export interface ChromeProfileImportHelperMessage {
  readonly metadataBytes: Buffer;
  readonly secretBytes: Buffer;
}

function protocolError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function validateLengths(metadataBytes: number, secretBytes: number): void {
  if (
    !Number.isSafeInteger(metadataBytes) ||
    metadataBytes < 1 ||
    metadataBytes > CHROME_PROFILE_IMPORT_HELPER_MAX_METADATA_BYTES ||
    !Number.isSafeInteger(secretBytes) ||
    secretBytes < 0 ||
    secretBytes > CHROME_PROFILE_IMPORT_HELPER_MAX_SECRET_BYTES
  ) {
    throw protocolError(
      "CHROMIUM_PROFILE_IMPORT_HELPER_LIMIT_EXCEEDED",
      "The fresh Chromium helper message exceeds its bounded native limit."
    );
  }
}

export function decodeChromeProfileImportHelperRequest(
  wireBytes: Buffer
): ChromeProfileImportHelperMessage {
  let metadataBytes: Buffer | null = null;
  let secretBytes: Buffer | null = null;
  try {
    if (
      !Buffer.isBuffer(wireBytes) ||
      wireBytes.byteLength < REQUEST_HEADER_BYTES ||
      !wireBytes.subarray(0, 8).equals(REQUEST_MAGIC)
    ) {
      throw protocolError(
        "CHROMIUM_PROFILE_IMPORT_HELPER_PROTOCOL_INVALID",
        "The inherited fresh Chromium helper request is invalid."
      );
    }
    const metadataLength = wireBytes.readUInt32BE(8);
    const secretLength = wireBytes.readUInt32BE(12);
    validateLengths(metadataLength, secretLength);
    if (wireBytes.byteLength !== REQUEST_HEADER_BYTES + metadataLength + secretLength) {
      throw protocolError(
        "CHROMIUM_PROFILE_IMPORT_HELPER_PROTOCOL_INVALID",
        "The inherited fresh Chromium helper request is not canonical."
      );
    }
    const secretOffset = REQUEST_HEADER_BYTES + metadataLength;
    metadataBytes = Buffer.from(wireBytes.subarray(REQUEST_HEADER_BYTES, secretOffset));
    secretBytes = Buffer.from(wireBytes.subarray(secretOffset));
    return Object.freeze({ metadataBytes, secretBytes });
  } catch (error) {
    metadataBytes?.fill(0);
    secretBytes?.fill(0);
    throw error;
  } finally {
    wireBytes.fill(0);
  }
}

export function encodeChromeProfileImportHelperResponse(
  outcome: ChromeProfileImportHelperOutcome,
  metadataBytes: Buffer,
  secretBytes: Buffer
): Buffer {
  validateLengths(metadataBytes.byteLength, secretBytes.byteLength);
  const outcomeCode = outcome === "applied" ? 0 : outcome === "failed" ? 1 : 2;
  const result = Buffer.alloc(
    RESPONSE_HEADER_BYTES + metadataBytes.byteLength + secretBytes.byteLength
  );
  RESPONSE_MAGIC.copy(result, 0);
  result[8] = outcomeCode;
  result.writeUInt32BE(metadataBytes.byteLength, 12);
  result.writeUInt32BE(secretBytes.byteLength, 16);
  metadataBytes.copy(result, RESPONSE_HEADER_BYTES);
  secretBytes.copy(result, RESPONSE_HEADER_BYTES + metadataBytes.byteLength);
  return result;
}

export function encodeChromeProfileImportHelperRequestForTest(
  metadataBytes: Buffer,
  secretBytes: Buffer
): Buffer {
  validateLengths(metadataBytes.byteLength, secretBytes.byteLength);
  const result = Buffer.alloc(
    REQUEST_HEADER_BYTES + metadataBytes.byteLength + secretBytes.byteLength
  );
  REQUEST_MAGIC.copy(result, 0);
  result.writeUInt32BE(metadataBytes.byteLength, 8);
  result.writeUInt32BE(secretBytes.byteLength, 12);
  metadataBytes.copy(result, REQUEST_HEADER_BYTES);
  secretBytes.copy(result, REQUEST_HEADER_BYTES + metadataBytes.byteLength);
  return result;
}
