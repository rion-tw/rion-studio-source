import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
const matrices = [...workflow.matchAll(/include: \$\{\{ fromJSON\(github.event_name == 'workflow_dispatch' && inputs.platform_scope == 'macos' && '(\[[^']+\])' \|\| github.event_name == 'workflow_dispatch' && inputs.platform_scope == 'windows' && '(\[[^']+\])' \|\| '(\[[^']+\])'\) \}\}/gu)];

describe("manual desktop CI scope", () => {
  it.each([
    ["workflow_dispatch", "macos", ["macos-latest"]],
    ["workflow_dispatch", "windows", ["windows-latest"]],
    ["workflow_dispatch", "all", ["macos-latest", "windows-latest"]],
    ["push", "macos", ["macos-latest", "windows-latest"]],
    ["push", "windows", ["macos-latest", "windows-latest"]],
    ["pull_request", "macos", ["macos-latest", "windows-latest"]],
    ["pull_request", "windows", ["macos-latest", "windows-latest"]],
    ["workflow_call", "macos", ["macos-latest", "windows-latest"]],
    ["workflow_call", "windows", ["macos-latest", "windows-latest"]]
  ])("selects the complete native/package/E2E matrix for %s / %s", (event, scope, expected) => {
    expect(matrices).toHaveLength(3);
    for (const match of matrices) {
      const index = event === "workflow_dispatch"
        ? scope === "macos" ? 1 : scope === "windows" ? 2 : 3
        : 3;
      const selected = match[index]!;
      expect((JSON.parse(selected) as { os: string }[]).map(row => row.os)).toEqual(expected);
    }
  });

  it("defaults to both platforms and never admits diagnostic CI as release evidence", () => {
    const dispatch = workflow.split("  workflow_dispatch:")[1]!.split("  workflow_call:")[0]!;
    expect(dispatch).toContain("default: all");
    expect(dispatch).toContain("type: choice");
    expect(dispatch).toContain("- windows");
    expect(workflow.split("  workflow_call:")[1]!.split("permissions:")[0]).not.toContain("platform_scope");
    expect(workflow).toContain("-${{ inputs.platform_scope || 'all' }}");
    const release = readFileSync(".github/workflows/release.yml", "utf8");
    expect(release).toContain("github.event.workflow_run.event == 'push'");
  });
});
