import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  signAsync: vi.fn()
}));

vi.mock("@electron/osx-sign", () => ({
  signAsync: mocks.signAsync
}));

const { default: signMacAdHoc } = await import("../build/signMacAdHoc.mjs");

describe("signMacAdHoc", () => {
  it("forces ad-hoc signing while preserving electron-builder signing options", async () => {
    const optionsForFile = vi.fn();
    mocks.signAsync.mockResolvedValue(undefined);

    await signMacAdHoc({
      app: "/tmp/Rion Studio.app",
      identity: undefined,
      identityValidation: true,
      optionsForFile,
      platform: "darwin",
      strictVerify: undefined,
      type: "distribution"
    });

    expect(mocks.signAsync).toHaveBeenCalledWith({
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
