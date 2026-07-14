import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const projectPath =
  "native/windows/window-frame-helper/RionWindowFrameHelper.vcxproj";

describe("Windows window frame helper project", () => {
  it("embeds its application manifest through one MSBuild input", async () => {
    const project = await readFile(projectPath, "utf8");

    expect(
      project.match(/<Manifest Include="window-frame-helper\.manifest"\s*\/>/gu)
    ).toHaveLength(1);
    expect(project).not.toContain("<ResourceCompile");
    expect(project).not.toContain("<GenerateManifest>false</GenerateManifest>");
  });
});
