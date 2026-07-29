import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const approvedActions = new Map([
  ["Swatinem/rust-cache", "e18b497796c12c097a38f9edb9d0641fb99eee32"],
  ["actions/checkout", "3d3c42e5aac5ba805825da76410c181273ba90b1"],
  ["actions/create-github-app-token", "bcd2ba49218906704ab6c1aa796996da409d3eb1"],
  ["actions/download-artifact", "3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c"],
  ["actions/setup-node", "249970729cb0ef3589644e2896645e5dc5ba9c38"],
  ["actions/upload-artifact", "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a"],
  ["pnpm/action-setup", "0ebf47130e4866e96fce0953f49152a61190b271"]
]);

describe("GitHub Actions supply chain", () => {
  it("pins every external action to an approved full commit SHA", async () => {
    const workflowDirectory = ".github/workflows";
    const workflowNames = (await readdir(workflowDirectory))
      .filter((name) => name.endsWith(".yml"))
      .sort();
    const references: Array<{ file: string; reference: string }> = [];

    for (const name of workflowNames) {
      const source = await readFile(join(workflowDirectory, name), "utf8");
      for (const line of source.split(/\r?\n/)) {
        const match = /^\s*uses:\s*([^\s#]+)/.exec(line);
        if (match?.[1] && !match[1].startsWith("./")) {
          references.push({ file: name, reference: match[1] });
        }
      }
    }

    expect(references.length).toBeGreaterThan(0);
    for (const { file, reference } of references) {
      const match = /^([^@]+)@([0-9a-f]{40})$/.exec(reference);
      expect(match, `${file}: ${reference} must use a full commit SHA`).not.toBeNull();
      const [, action, sha] = match ?? [];
      expect(approvedActions.get(action ?? ""), `${file}: ${action} is not approved`).toBe(sha);
    }
  });
});
