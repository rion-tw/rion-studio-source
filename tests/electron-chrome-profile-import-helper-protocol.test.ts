import { describe, expect, it } from "vitest";

import {
  decodeChromeProfileImportHelperRequest,
  encodeChromeProfileImportHelperRequestForTest,
  encodeChromeProfileImportHelperResponse
} from "../src/electron/main/chromeProfileImportHelperProtocol";

describe("fresh Chrome profile import helper pipe protocol", () => {
  it("decodes exact bounded request frames and overwrites the wire buffer", () => {
    const metadata = Buffer.from('{"kind":"apply"}');
    const secret = Buffer.from("secret-session-inventory");
    const wire = encodeChromeProfileImportHelperRequestForTest(metadata, secret);
    const decoded = decodeChromeProfileImportHelperRequest(wire);

    expect(decoded.metadataBytes).toEqual(metadata);
    expect(decoded.secretBytes).toEqual(secret);
    expect([...wire]).toEqual(new Array(wire.byteLength).fill(0));
    decoded.secretBytes.fill(0);
  });

  it("rejects trailing bytes, invalid lengths, and unknown framing", () => {
    const trailing = Buffer.concat([
      encodeChromeProfileImportHelperRequestForTest(Buffer.from("{}"), Buffer.alloc(0)),
      Buffer.from([0])
    ]);
    expect(() => decodeChromeProfileImportHelperRequest(trailing)).toThrowError(
      expect.objectContaining({ code: "CHROMIUM_PROFILE_IMPORT_HELPER_PROTOCOL_INVALID" })
    );

    const invalid = Buffer.alloc(16);
    invalid.write("RCHREQ01", "ascii");
    invalid.writeUInt32BE(1024 * 1024 + 1, 8);
    expect(() => decodeChromeProfileImportHelperRequest(invalid)).toThrowError(
      expect.objectContaining({ code: "CHROMIUM_PROFILE_IMPORT_HELPER_LIMIT_EXCEEDED" })
    );
  });

  it("encodes canonical terminal outcome frames without stringifying secrets", () => {
    const metadata = Buffer.from('{"stableErrorCode":"PIPE_UNKNOWN"}');
    const response = encodeChromeProfileImportHelperResponse(
      "indeterminate",
      metadata,
      Buffer.from([0, 255, 1, 254])
    );
    expect(response.subarray(0, 8).toString("ascii")).toBe("RCHRES01");
    expect(response[8]).toBe(2);
    expect(response.readUInt32BE(12)).toBe(metadata.byteLength);
    expect(response.readUInt32BE(16)).toBe(4);
    response.fill(0);
  });
});
