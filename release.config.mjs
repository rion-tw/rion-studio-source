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
    [
      "@semantic-release/github",
      {
        // The tag is immutable release identity, but a draft prevents a partially
        // finalized private release from becoming visible while assets are checked.
        draftRelease: true
      }
    ]
  ]
};
