/** Read only SignedMessage.type (1), its License (2), and platform status (10).
 * Field definitions: https://github.com/castlabs/wv-vmp-lab/blob/main/index.js
 * Never returns any other license field; malformed/absent data stays unknown.
 */
export function widevinePlatformStatus(data) {
  try {
    const bytes = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
    if (!bytes.length || bytes.length > 1024 * 1024) return null;
    const field = (message, wanted, expectedWire) => {
      let position = 0;
      const integer = () => {
        let value = 0;
        for (let shift = 0; shift <= 49; shift += 7) {
          if (position >= message.length) throw new Error("truncated");
          const byte = message[position++];
          value += (byte & 127) * 2 ** shift;
          if (!Number.isSafeInteger(value)) throw new Error("overflow");
          if ((byte & 128) === 0) return value;
        }
        throw new Error("oversized");
      };
      while (position < message.length) {
        const tag = integer();
        const wire = tag % 8;
        const id = Math.floor(tag / 8);
        if (!id) throw new Error("invalid-tag");
        let value;
        if (wire === 0) value = integer();
        else {
          const size = wire === 2 ? integer() : wire === 1 ? 8 : wire === 5 ? 4 : -1;
          if (size < 0 || position + size > message.length) throw new Error("invalid-length");
          value = message.subarray(position, position + size);
          position += size;
        }
        if (id === wanted) return wire === expectedWire ? value : null;
      }
      return null;
    };
    if (field(bytes, 1, 0) !== 2) return null;
    const license = field(bytes, 2, 2);
    if (!license) return null;
    const status = field(license, 10, 0);
    return ["PLATFORM_UNVERIFIED", "PLATFORM_TAMPERED", "PLATFORM_SOFTWARE_VERIFIED",
      "PLATFORM_HARDWARE_VERIFIED", "PLATFORM_NO_VERIFICATION", "PLATFORM_SECURE_STORAGE_SOFTWARE_VERIFIED"][status] ?? null;
  } catch { return null; }
}
