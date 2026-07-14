import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sign: vi.fn()
}));

vi.mock("@electron/osx-sign", () => ({
  sign: mocks.sign
}));

const { default: signMacAdHoc } = await import("../build/signMacAdHoc.mjs");

describe("signMacAdHoc", () => {
  it("forces ad-hoc signing while preserving electron-builder signing options", async () => {
    const optionsForFile = vi.fn();
    mocks.sign.mockResolvedValue(undefined);

    await signMacAdHoc({
      app: "/tmp/Rion Studio.app",
      identity: undefined,
      identityValidation: true,
      optionsForFile,
      platform: "darwin",
      strictVerify: undefined,
      type: "distribution"
    });

    expect(mocks.sign).toHaveBeenCalledWith({
      app: "/tmp/Rion Studio.app",
      identity: "-",
      identityValidation: false,
      optionsForFile,
      platform: "darwin",
      strictVerify: undefined,
      timestamp: "none",
      type: "distribution"
    });
  });
});
