import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/** Hashes to EOF; callers own file identity, size and signature validation. */
export function sha256File(filePath) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(filePath);
    input.on("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolveHash(hash.digest("hex")));
  });
}
