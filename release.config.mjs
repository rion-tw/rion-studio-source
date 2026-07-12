export default {
  branches: ["main"],
  tagFormat: "v${version}",
  plugins: [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    [
      "@semantic-release/exec",
      {
        successCmd: "echo release_version=${nextRelease.version} >> $GITHUB_OUTPUT"
      }
    ],
    "@semantic-release/github"
  ]
};
