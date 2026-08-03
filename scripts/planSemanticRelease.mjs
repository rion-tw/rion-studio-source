import { execFileSync } from "node:child_process";
import process from "node:process";

import semanticRelease from "semantic-release";

const sourceSha = requiredSha(process.env.SOURCE_REF ?? git("rev-parse", "HEAD"));
const headSha = requiredSha(git("rev-parse", "HEAD"));
if (headSha !== sourceSha) {
  throw new Error(`SOURCE_REF ${sourceSha} does not match checked out HEAD ${headSha}.`);
}

// The planner must be usable with read-only credentials. Point semantic-release at
// the checked-out repository so its dry-run push authorization check stays local.
// actions/checkout fetches the complete history; this local branch gives the
// release config the same main/tag graph that the publishing job will evaluate.
if (git("branch", "--show-current") !== "main") {
  git("branch", "--force", "main", sourceSha);
}

const result = await semanticRelease(
  {
    ci: false,
    dryRun: true,
    plugins: ["@semantic-release/commit-analyzer"],
    repositoryUrl: "."
  },
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      GITHUB_REF: "refs/heads/main",
      GITHUB_SHA: sourceSha
    },
    stderr: process.stderr,
    stdout: process.stderr
  }
);

const nextRelease = result && "nextRelease" in result ? result.nextRelease : undefined;
const releaseVersion = nextRelease?.version ?? "";
const releaseTag = nextRelease?.gitTag ?? "";
if (releaseVersion && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(releaseVersion)) {
  throw new Error(`semantic-release returned an invalid version: ${releaseVersion}`);
}
if (releaseTag && releaseTag !== `v${releaseVersion}`) {
  throw new Error(`semantic-release returned tag ${releaseTag} for version ${releaseVersion}.`);
}

process.stdout.write(
  `${JSON.stringify({
    has_release: Boolean(releaseVersion),
    release_tag: releaseTag,
    release_version: releaseVersion,
    source_sha: sourceSha
  })}\n`
);

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function requiredSha(value) {
  const sha = value.trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error("SOURCE_REF must be a 40-character lowercase commit SHA.");
  }
  return sha;
}
