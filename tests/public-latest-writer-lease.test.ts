import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { describe, expect, it } from "vitest";

const WORKFLOW_DIRECTORY = ".github/workflows";
const PUBLIC_REPOSITORY = "rion-tw/rion-studio";
const PUBLIC_LATEST_WRITER_LEASE = "public-latest-rion-studio";

describe("public latest release writer lease", () => {
  it("serializes every public latest writer without cancelling an active writer", async () => {
    const workflows = await readWorkflows();
    const writers = workflows.filter(({ source }) => isPublicLatestWriter(source));

    expect(writers.map(({ path }) => basename(path)).sort()).toEqual(
      expect.arrayContaining([
        "publish-public-release.yml",
        "restore-public-latest.yml"
      ])
    );

    for (const { path, source } of writers) {
      const concurrency = readTopLevelSection(source, "concurrency");

      expect(concurrency, path).toMatch(
        new RegExp(`^ {2}group: ${PUBLIC_LATEST_WRITER_LEASE}$`, "mu")
      );
      expect(concurrency, path).toMatch(/^ {2}cancel-in-progress: false$/mu);
      expect(concurrency, path).toMatch(/^ {2}queue: max$/mu);
    }
  });
});

async function readWorkflows(): Promise<Array<{ path: string; source: string }>> {
  const entries = await readdir(WORKFLOW_DIRECTORY, { withFileTypes: true });
  const paths = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        (entry.name.endsWith(".yml") || entry.name.endsWith(".yaml"))
    )
    .map((entry) => join(WORKFLOW_DIRECTORY, entry.name));

  return Promise.all(
    paths.map(async (path) => ({
      path,
      source: (await readFile(path, "utf8")).replaceAll("\r\n", "\n")
    }))
  );
}

function isPublicLatestWriter(source: string): boolean {
  if (!source.includes(PUBLIC_REPOSITORY)) {
    return false;
  }

  const editsLatest = /\bgh release edit\b[\s\S]{0,800}?--latest(?![=\w-])/u;
  const writesLatestThroughApi = /\bmake[_-]?latest\b[\s:=]+["']?true\b/iu;

  return editsLatest.test(source) || writesLatestThroughApi.test(source);
}

function readTopLevelSection(source: string, name: string): string {
  const sectionHeader = new RegExp(`^${name}:\\n`, "mu").exec(source);
  if (sectionHeader?.index === undefined) {
    return "";
  }

  const body = source.slice(sectionHeader.index + sectionHeader[0].length);
  const nextTopLevelKey = body.search(/^[-\w]+:/mu);
  return nextTopLevelKey === -1 ? body : body.slice(0, nextTopLevelKey);
}
