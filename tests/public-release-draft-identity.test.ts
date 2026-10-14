import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const TAG = "v9.1.3";
const RELEASE = { id: 412361815, tag_name: TAG, draft: true, prerelease: false };
const TAG_REF = { ref: `refs/tags/${TAG}`, object: { type: "commit", sha: "a".repeat(40) } };
const WORKFLOW = readFileSync(".github/workflows/publish-public-release.yml", "utf8");
const start = WORKFLOW.indexOf("          resolve_target_release() {");
const end = WORKFLOW.indexOf("          jq -j 'if .body == null", start);
const program = WORKFLOW.slice(start, end).replace(/^ {10}/gmu, "");
const bash = process.platform === "win32"
  ? resolve(execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim(),
    "../../..", "bin/bash.exe")
  : "bash";

type Fixture = {
  listed?: object[];
  pending?: object | null;
  pendingResponse?: object;
  created?: object[];
  fetched?: object;
  tagRef?: object | null;
};

function run(fixture: Fixture = {}) {
  const root = mkdtempSync(join(tmpdir(), "rion-draft-identity-"));
  const trace = join(root, "trace.txt");
  const marker = join(root, "notes.md");
  const notes = "Rion Studio 中文 release\n\nExact checksums follow.\n";
  writeFileSync(marker, notes);
  const literal = (value: unknown) => `'${JSON.stringify(value).replaceAll("'", "'\\''")}'`;
  const stub = `
gh() {
  printf '%s\\n' "$*" >> "$GH_TRACE"
  if [[ "$*" == *"--paginate --slurp"* ]]; then
    printf '%s\\n' ${literal([fixture.listed ?? []])}
  elif [[ "$2" == "graphql" ]]; then
    printf '%s\\n' ${literal(fixture.pendingResponse ?? {
      data: { repository: { release: fixture.pending ?? null } }
    })}
  elif [[ "$*" == *"/git/ref/tags/"* ]]; then
    ${fixture.tagRef === null ? "return 1" : `printf '%s\\n' ${literal(fixture.tagRef ?? TAG_REF)}`}
  elif [[ "$*" == *"--method POST"* ]]; then
    cp "$work_root/create-release-input.json" "$work_root/observed-post.json"
    printf '%s\\n' ${literal(fixture.created ?? [RELEASE])}
  elif [[ "$*" == *"--jq [.]"* ]]; then
    printf '%s\\n' ${literal([fixture.fetched ?? RELEASE])}
  else
    printf '%s\\n' ${literal(fixture.fetched ?? RELEASE)}
  fi
}
`;
  let failure: unknown;
  try {
    execFileSync(bash, ["--noprofile", "--norc", "-e", "-o", "pipefail"], {
      input: `set -euo pipefail\n${stub}\n${program}`,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        TAG,
        PUBLIC_RELEASE_REPOSITORY: "rion-tw/rion-studio",
        GH_TRACE: trace.replaceAll("\\", "/"),
        work_root: root.replaceAll("\\", "/"),
        marker_source: marker.replaceAll("\\", "/")
      },
      windowsHide: true
    });
  } catch (error) {
    failure = error;
  }
  const calls = readFileSync(trace, "utf8").trim().split("\n");
  let post: object | undefined;
  try { post = JSON.parse(readFileSync(join(root, "observed-post.json"), "utf8")); }
  catch { /* No POST was submitted. */ }
  rmSync(root, { recursive: true, force: true });
  return { failure, calls, post, notes };
}

describe("public release draft identity from exact API acknowledgements", () => {
  it("retains the created ID even when the release list never includes the draft", () => {
    const result = run();
    expect(result.failure).toBeUndefined();
    expect(result.calls.filter(call => call.includes("--paginate"))).toHaveLength(1);
    expect(result.calls.filter(call => call.includes("--method POST"))).toHaveLength(1);
    expect(result.calls.at(-1)).toBe(`api repos/rion-tw/rion-studio/releases/${RELEASE.id}`);
    expect(result.post).toEqual({
      tag_name: TAG, name: TAG, body: result.notes,
      draft: true, prerelease: false, make_latest: "false", target_commitish: TAG_REF.object.sha
    });
  });

  it.each([true, false])("reuses an existing exact listed release (draft=%s)", draft => {
    const release = { ...RELEASE, draft };
    const result = run({ listed: [release], fetched: release });
    expect(result.failure).toBeUndefined();
    expect(result.calls).toHaveLength(2);
    expect(result.post).toBeUndefined();
  });

  it("recovers an unlisted pending draft by its exact tag association and ID", () => {
    const result = run({ pending: { databaseId: RELEASE.id, tagName: TAG } });
    expect(result.failure).toBeUndefined();
    expect(result.calls.filter(call => call.includes(`/releases/${RELEASE.id}`))).toHaveLength(2);
    expect(result.post).toBeUndefined();
  });

  it.each([
    { databaseId: RELEASE.id, tagName: "v9.1.2" },
    { databaseId: "invalid", tagName: TAG }
  ])("rejects a mismatched pending association without creating", pending => {
    const result = run({ pending });
    expect(result.failure).toBeDefined();
    expect(result.post).toBeUndefined();
  });

  it.each([{}, { data: { repository: null } }])(
    "rejects an incomplete pending response without creating", pendingResponse => {
      const result = run({ pendingResponse });
      expect(result.failure).toBeDefined();
      expect(result.post).toBeUndefined();
    }
  );

  it("rejects a pending lookup that returns a different release ID", () => {
    const result = run({ pending: { databaseId: RELEASE.id, tagName: TAG },
      fetched: { ...RELEASE, id: RELEASE.id + 1 } });
    expect(result.failure).toBeDefined();
    expect(result.post).toBeUndefined();
  });

  it("rejects duplicate existing targets without any mutation", () => {
    const result = run({ listed: [RELEASE, { ...RELEASE, id: RELEASE.id + 1 }] });
    expect(result.failure).toBeDefined();
    expect(result.calls).toHaveLength(1);
    expect(result.post).toBeUndefined();
  });

  it.each([
    null,
    { ...TAG_REF, ref: "refs/tags/v9.1.2" },
    { ...TAG_REF, object: { type: "tag", sha: TAG_REF.object.sha } },
    { ...TAG_REF, object: { type: "commit", sha: "invalid" } }
  ])("requires the existing exact public marker tag before creating", tagRef => {
    const result = run({ tagRef });
    expect(result.failure).toBeDefined();
    expect(result.post).toBeUndefined();
    expect(result.calls.at(-1)).toContain(`/git/ref/tags/${TAG}`);
  });

  it.each([
    { ...RELEASE, id: "invalid" },
    { ...RELEASE, tag_name: "v9.1.2" },
    { ...RELEASE, draft: false },
    { ...RELEASE, prerelease: true }
  ])("rejects an invalid create acknowledgement before staging", created => {
    const result = run({ created: [created] });
    expect(result.failure).toBeDefined();
    expect(result.calls.at(-1)).toContain("--method POST");
  });
});
