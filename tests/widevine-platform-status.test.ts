import { expect, it } from "vitest";
import { widevinePlatformStatus } from "../scripts/widevinePlatformStatus.mjs";

it("reads only the VMP status from a license response, including sliced views", () => {
  const data = new Uint8Array([99, 8, 2, 18, 5, 10, 1, 99, 80, 2, 99]);
  expect(widevinePlatformStatus(data.subarray(1, -1))).toBe("PLATFORM_SOFTWARE_VERIFIED");
  expect(widevinePlatformStatus(new Uint8Array([8, 2, 18, 2, 80, 1]).buffer)).toBe("PLATFORM_TAMPERED");
  expect(widevinePlatformStatus(new Uint8Array([8, 2, 18, 2, 80, 0]))).toBe("PLATFORM_UNVERIFIED");
});

it.each([
  [], [8, 5, 18, 2, 80, 2], [8, 2], [8, 2, 18, 2, 80, 99],
  [8, 2, 18, 2, 80], [8, 2, 18, 2, 80, 128], [8, 2, 18, 2, 83, 2],
  [8, 2, 18, 2, 0, 2], [8, 2, 18, 2, 82, 0], [8, 2, 18, 2, 8, 2]
])("never treats missing or malformed VMP fields as verified: %j", (...bytes) => {
  expect(widevinePlatformStatus(new Uint8Array(bytes))).toBeNull();
});
