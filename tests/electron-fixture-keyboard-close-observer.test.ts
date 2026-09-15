import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChromiumRoleSurfaceRegistry } from "../src/electron/main/chromiumRoleSurfaceRegistry";
import { installFixtureKeyboardCloseObserver } from "../src/electron/e2e/fixtureKeyboardCloseObserver";

describe("E2E original document readback before close", () => {
  const prototype = ChromiumRoleSurfaceRegistry.prototype;
  const originalCreate = prototype.create, originalClose = prototype.closeRole;
  let directory: string;
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "rion-consumer-")); });
  afterEach(() => {
    prototype.create = originalCreate;
    prototype.closeRole = originalClose;
    rmSync(directory, { recursive: true, force: true });
  });
  function setup() {
    const calls: string[] = [];
    prototype.create = vi.fn(async input => ({ roleId: input.roleId, generation: input.generation,
      parentId: 1, url: input.url }));
    const close = vi.fn(async () => { calls.push("close"); return true; });
    prototype.closeRole = close;
    installFixtureKeyboardCloseObserver(directory, "http://127.0.0.1:41739");
    const subject = Object.create(prototype) as ChromiumRoleSurfaceRegistry;
    const readback = vi.fn(async () => {
      calls.push("readback");
      return { fixtureRoleId: "chromium-cleanup-tab", documentToken: "token", events: [], dropped: 0 };
    });
    const frame = { url: "http://127.0.0.1:41739/role/chromium-cleanup-tab", executeJavaScript: readback };
    const identity = { roleId: "role", generation: 1, frameToken: "frame", documentInstanceId: "document", frame };
    subject.currentTrustedInputFrame = vi.fn(() => identity);
    const input = { roleId: "role", generation: 1, tabId: "tab", url: frame.url } as Parameters<typeof subject.create>[0];
    const artifact = () => JSON.parse(readFileSync(join(directory, "electron-fixture-keyboard-terminal.json"), "utf8"));
    return { subject, input, readback, identity, calls, artifact, close };
  }
  it("reads once before close and shares duplicate close observation", async () => {
    const subject = setup();
    await subject.subject.create(subject.input);
    const first = subject.subject.closeRole("role", 1);
    const second = subject.subject.closeRole("role", 1);
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(subject.calls).toEqual(["readback", "close", "close"]);
    expect(subject.artifact()).toMatchObject([{ status: "captured", generation: 1, documentInstanceId: "document" }]);
  });
  it("records a replaced document as missing evidence while preserving native close", async () => {
    const subject = setup();
    await subject.subject.create(subject.input);
    vi.mocked(subject.subject.currentTrustedInputFrame)
      .mockReturnValueOnce(subject.identity)
      .mockReturnValueOnce({ ...subject.identity, documentInstanceId: "new-document" });
    await expect(subject.subject.closeRole("role", 1)).resolves.toBe(true);
    expect(subject.artifact()).toMatchObject([{ status: "failed", error: expect.stringContaining("replaced") }]);
    expect(subject.close).toHaveBeenCalledOnce();
  });
  it("does not inspect another generation or an external origin", async () => {
    const subject = setup();
    await subject.subject.create({ ...subject.input, url: "https://external.test/role/chromium-cleanup-tab" });
    await subject.subject.closeRole("role", 1);
    await subject.subject.create(subject.input);
    await subject.subject.closeRole("role", 2);
    expect(subject.readback).not.toHaveBeenCalled();
  });
  it("never changes a native close failure into success", async () => {
    const subject = setup();
    await subject.subject.create(subject.input);
    const failure = new Error("detach failed");
    subject.close.mockRejectedValueOnce(failure);
    await expect(subject.subject.closeRole("role", 1)).rejects.toBe(failure);
  });
});
