import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { writeZip } from "../src/main/logging/zipWriter";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("writeZip", () => {
  it("writes a standard ZIP central directory with UTF-8 file names", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rion-zip-"));
    directories.push(directory);
    const file = join(directory, "diagnostics.zip");
    await writeZip(file, [
      { name: "diagnostics.json", data: Buffer.from("{}") },
      { name: "logs/app.jsonl", data: Buffer.from("{\"ok\":true}\n") }
    ]);
    const output = await readFile(file);
    expect(output.readUInt32LE(0)).toBe(0x04034b50);
    expect(output.includes(Buffer.from("diagnostics.json"))).toBe(true);
    expect(output.includes(Buffer.from("logs/app.jsonl"))).toBe(true);
    expect(output.readUInt32LE(output.length - 22)).toBe(0x06054b50);
  });
});
