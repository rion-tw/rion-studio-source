// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";

import { cleanup, render, screen } from "@testing-library/react";
import { Gamepad2 } from "lucide-react";
import { afterEach, describe, expect, it } from "vitest";

import { Badge } from "../src/renderer/src/components/ui/badge";
import { NavItem } from "../src/renderer/src/components/ui/patterns";

const rendererPath = (...segments: string[]): string =>
  path.join(process.cwd(), "src", "renderer", ...segments);

afterEach(cleanup);

describe("renderer visual foundation", () => {
  it("uses system-font tabular lining figures throughout the renderer and boot fallback", () => {
    const styles = readFileSync(rendererPath("src", "styles.css"), "utf8");
    const bootDocument = readFileSync(rendererPath("index.html"), "utf8");
    const runtimeTabs = readFileSync(rendererPath("runtime-tabs.html"), "utf8");

    expect(styles).toContain("font-variant-numeric: lining-nums tabular-nums");
    expect(styles).toContain("font-variant-numeric: inherit");
    expect(bootDocument).toContain("font-variant-numeric: lining-nums tabular-nums");
    expect(runtimeTabs).toContain("font-variant-numeric: lining-nums tabular-nums");
    expect(styles).not.toContain("@font-face");
  });

  it("keeps count primitives compact without adding nested backdrop filters", () => {
    render(
      <>
        <Badge variant="secondary">12/48</Badge>
        <NavItem icon={Gamepad2} label="Games" count={120} />
      </>
    );

    const badge = screen.getByText("12/48");
    const count = screen.getByText("120");

    expect(badge.className).toContain("ui-badge");
    expect(badge.className).toContain("overflow-hidden");
    expect(badge.className).not.toContain("backdrop-blur");
    expect(count.className).toContain("count-pill");
    expect(count.className).not.toContain("backdrop-blur");
  });

  it("bases page grids on available content width and fills the dashboard with four stats", () => {
    const styles = readFileSync(rendererPath("src", "styles.css"), "utf8");
    const dashboard = readFileSync(
      rendererPath("src", "features", "dashboard", "DashboardRoute.tsx"),
      "utf8"
    );

    expect(styles).toContain("container-name: app-content");
    expect(styles).toContain("container-type: inline-size");
    expect(styles).toMatch(
      /@container app-content \(min-width: 760px\)[\s\S]*?\.dashboard-stats-grid \{[\s\S]*?repeat\(4, minmax\(0, 1fr\)\)/
    );
    expect(styles).toMatch(
      /@container app-content \(min-width: 920px\)[\s\S]*?\.dashboard-panels-grid \{[\s\S]*?repeat\(3, minmax\(0, 1fr\)\)/
    );
    expect(dashboard).toContain('className="dashboard-stats-grid gap-2.5"');
    expect(dashboard).toContain('className="dashboard-panels-grid items-start gap-4"');
    expect(dashboard).not.toContain("grid-cols-5");
  });

  it("reserves backdrop blur for top-level glass surfaces", () => {
    const styles = readFileSync(rendererPath("src", "styles.css"), "utf8");

    expect(styles).toContain(
      ".glass-panel,\n  .glass-panel-strong,\n  .glass-modal,\n  .glass-popover {\n    -webkit-backdrop-filter: blur(22px) saturate(1.08);"
    );
    expect(styles).toContain(
      ".glass-control,\n  .glass-control-selected,\n  .glass-inset {\n    -webkit-backdrop-filter: none;"
    );
  });
});
