import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

  it("streams a file-backed entry without requiring a Buffer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rion-zip-stream-"));
    directories.push(directory);
    const source = join(directory, "logs.jsonl");
    const file = join(directory, "diagnostics.zip");
    await writeFile(source, "{\"streamed\":true}\n");

    await writeZip(file, [{ name: "logs/app.jsonl", path: source }]);

    const output = await readFile(file);
    expect(output.includes(Buffer.from("{\"streamed\":true}\n"))).toBe(true);
    expect(output.includes(Buffer.from("logs/app.jsonl"))).toBe(true);
    expect(output.readUInt32LE(output.length - 22)).toBe(0x06054b50);
  });
});
