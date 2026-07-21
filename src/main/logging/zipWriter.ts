import { createReadStream } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";

export interface ZipFile {
  name: string;
  data?: Buffer;
  path?: string;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function updateCrc32(crc: number, data: Buffer): number {
  let next = crc;
  for (const byte of data) next = CRC_TABLE[(next ^ byte) & 0xff]! ^ (next >>> 8);
  return next;
}

/** Writes uncompressed ZIP entries incrementally using data descriptors. */
export async function writeZip(filePath: string, files: ZipFile[]): Promise<void> {
  const output = await open(filePath, "w");
  const centrals: Buffer[] = [];
  let offset = 0;
  try {
    for (const file of files) {
      assertZipFile(file);
      const name = Buffer.from(file.name.replaceAll("\\", "/"));
      const localOffset = offset;
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0808, 6); // UTF-8 and trailing data descriptor.
      local.writeUInt16LE(name.length, 26);
      await writeAll(output, local);
      await writeAll(output, name);
      offset += local.length + name.length;

      let crc = 0xffffffff;
      let size = 0;
      for await (const chunk of readZipFile(file)) {
        crc = updateCrc32(crc, chunk);
        size += chunk.length;
        assertZip32(size, "entry size");
        await writeAll(output, chunk);
        offset += chunk.length;
      }
      crc = (crc ^ 0xffffffff) >>> 0;

      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(size, 8);
      descriptor.writeUInt32LE(size, 12);
      await writeAll(output, descriptor);
      offset += descriptor.length;

      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(20, 4);
      central.writeUInt16LE(20, 6);
      central.writeUInt16LE(0x0808, 8);
      central.writeUInt32LE(crc, 16);
      central.writeUInt32LE(size, 20);
      central.writeUInt32LE(size, 24);
      central.writeUInt16LE(name.length, 28);
      central.writeUInt32LE(localOffset, 42);
      centrals.push(central, name);
    }

    const centralOffset = offset;
    for (const part of centrals) {
      await writeAll(output, part);
      offset += part.length;
    }
    const centralSize = offset - centralOffset;
    assertZip32(centralOffset, "central directory offset");
    assertZip32(centralSize, "central directory size");
    if (files.length > 0xffff) throw new Error("ZIP contains too many entries.");
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(centralOffset, 16);
    await writeAll(output, end);
  } finally {
    await output.close();
  }
}

async function* readZipFile(file: ZipFile): AsyncGenerator<Buffer> {
  if (file.data !== undefined) {
    yield file.data;
    return;
  }
  for await (const chunk of createReadStream(file.path!)) {
    yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  }
}

async function writeAll(output: FileHandle, data: Buffer): Promise<void> {
  let offset = 0;
  while (offset < data.length) {
    const { bytesWritten } = await output.write(data, offset);
    if (bytesWritten <= 0) throw new Error("Unable to make progress while writing ZIP output.");
    offset += bytesWritten;
  }
}

function assertZipFile(file: ZipFile): void {
  if (!file.name || (file.data === undefined) === (file.path === undefined)) {
    throw new Error("Each ZIP entry requires exactly one data or path source.");
  }
}

function assertZip32(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error(`ZIP ${label} exceeds the ZIP32 limit.`);
  }
}
