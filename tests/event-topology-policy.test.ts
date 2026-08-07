import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { scanEventTopologySources } from "../scripts/eventTopologyPolicy.mjs";

const emptyLedger = { schemaVersion: 1, exceptions: [] };

function exception(id: string, paths: string[]) {
  return {
    id,
    paths,
    mechanism: "test mechanism",
    authoritativeEvent: "test event",
    reason: "test reason",
    terminalOutcome: "test terminal outcome",
    cleanup: "test cleanup"
  };
}

describe("event topology source policy", () => {
  it("rejects unclassified production timers and control-flow workarounds", () => {
    const failures = scanEventTopologySources([
      {
        path: "src/renderer/src/example.ts",
        source: [
          "setInterval(refresh, 1000);",
          "setTimeout(refresh, 1000);",
          "await withTimeout(load(), 1000, 'failed');",
          "return Promise.race([load(), deadline]);",
          "const watchdog = startRepair();"
        ].join("\n")
      }
    ], emptyLedger);

    expect(failures).toHaveLength(5);
    expect(failures.join("\n")).toContain("setInterval");
    expect(failures.join("\n")).toContain("setTimeout");
    expect(failures.join("\n")).toContain("withTimeout");
    expect(failures.join("\n")).toContain("Promise.race");
    expect(failures.join("\n")).toContain("polling/watchdog/dirty-check");
  });

  it("allows presentation delay and committed-event coalescing only for one-shot timers", () => {
    const failures = scanEventTopologySources([
      {
        path: "src/renderer/src/example.tsx",
        source: [
          "// event-topology: presentation",
          "window.setTimeout(hideToast, 1000);",
          "// event-topology: coalesce",
          "setTimeout(flushNewestCommittedRevision, 200);"
        ].join("\n")
      }
    ], emptyLedger);

    expect(failures).toEqual([]);
  });

  it("requires a matching exception for recurring and generic timeout mechanisms", () => {
    const failures = scanEventTopologySources([
      {
        path: "src/renderer/src/example.ts",
        source: [
          "// event-topology: coalesce",
          "setInterval(refresh, 1000);",
          "// event-topology: presentation",
          "await withTimeout(load(), 1000, 'failed');"
        ].join("\n")
      }
    ], emptyLedger);

    expect(failures).toHaveLength(2);
    expect(failures.every((failure) => failure.includes("requires an event-topology exception")))
      .toBe(true);
  });

  it("accepts a source-local exception whose ledger path matches", () => {
    const id = "bounded-external-test";
    const path = "src/renderer/src/example.ts";
    const failures = scanEventTopologySources([
      {
        path,
        source: [
          `// event-topology-exception: ${id}`,
          "await withTimeout(load(), 1000, 'failed');"
        ].join("\n")
      }
    ], { schemaVersion: 1, exceptions: [exception(id, [path])] });

    expect(failures).toEqual([]);
  });

  it("rejects unknown, misplaced, and unused exception records", () => {
    const id = "bounded-external-test";
    const failures = scanEventTopologySources([
      {
        path: "src/renderer/src/example.ts",
        source: [
          "// event-topology-exception: unknown-test",
          "setTimeout(expire, 1000);",
          `// event-topology-exception: ${id}`,
          "setTimeout(expireAgain, 1000);"
        ].join("\n")
      }
    ], {
      schemaVersion: 1,
      exceptions: [exception(id, ["src/renderer/src/allowed.ts"])]
    });

    expect(failures.join("\n")).toContain("unknown event-topology exception unknown-test");
    expect(failures.join("\n")).toContain("does not allow this path");
    expect(failures.join("\n")).toContain(`${id} is unused`);
  });
});

describe("event topology architecture contract", () => {
  it("documents event-bound completion as the default and contract version 12", async () => {
    const [agents, policy, runtimeContract] = await Promise.all([
      readFile(new URL("../AGENTS.md", import.meta.url), "utf8"),
      readFile(new URL("../docs/event-topology.md", import.meta.url), "utf8"),
      readFile(new URL("../docs/system-webview-runtime-contract.md", import.meta.url), "utf8")
    ]);

    expect(agents).toContain("Normal correctness is event-bound");
    expect(policy).toContain("`EventBound` is the normal correctness policy");
    expect(policy).toContain("A deadline never means success");
    expect(runtimeContract).toContain("Contract version 12");
    expect(runtimeContract).toContain("Event-bound work never terminalizes because time elapsed");
  });
});
