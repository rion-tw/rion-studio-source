// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";

import { cleanup, render, screen } from "@testing-library/react";
import { Gamepad2 } from "lucide-react";
import { afterEach, describe, expect, it } from "vitest";

import { Badge } from "../src/renderer/src/components/ui/badge";
import { Button } from "../src/renderer/src/components/ui/button";
import { NavItem } from "../src/renderer/src/components/ui/patterns";
import { QuickAccessTrigger } from "../src/renderer/src/features/quick-access/QuickAccessTrigger";
import en from "../src/renderer/src/i18n/en.json";
import type { Translator } from "../src/renderer/src/i18n";
import { readSourceTreeSync } from "./helpers/readSourceTree";

const rendererPath = (...segments: string[]): string =>
  path.join(process.cwd(), "src", "renderer", ...segments);
const t: Translator = (key) => en[key] ?? key;

afterEach(cleanup);

describe("renderer visual foundation", () => {
  it("uses system-font tabular lining figures throughout the renderer and boot fallback", () => {
    const styles = readSourceTreeSync(rendererPath("src", "styles.css"), "utf8");
    const bootDocument = readFileSync(rendererPath("index.html"), "utf8");
    const runtimeTabs = readFileSync(rendererPath("runtime-tabs.html"), "utf8");
    const bootStyles = readFileSync(rendererPath("src", "boot.css"), "utf8");
    const runtimeTabStyles = readFileSync(rendererPath("runtime-tabs.css"), "utf8");
    const tokens = readFileSync(path.join(process.cwd(), "src", "shared", "designTokens.css"), "utf8");

    expect(styles).toContain("font-variant-numeric: lining-nums tabular-nums");
    expect(styles).toContain("font-variant-numeric: inherit");
    expect(bootDocument).toContain('href="/src/boot.css"');
    expect(runtimeTabs).toContain('href="/runtime-tabs.css"');
    expect(bootStyles).toContain("font-variant-numeric: lining-nums tabular-nums");
    expect(runtimeTabStyles).toContain("font-variant-numeric: lining-nums tabular-nums");
    expect(runtimeTabStyles).toMatch(/\.tab \{[\s\S]*?transition: opacity 90ms ease-out;/);
    expect(runtimeTabStyles).toMatch(
      /\.tab\.runtime-tab-sort-ghost \{[\s\S]*?visibility: hidden;[\s\S]*?opacity: 0;/
    );
    expect(runtimeTabStyles).toMatch(
      /\.tab\.runtime-tab-sort-fallback \{[\s\S]*?opacity: 1;/
    );
    expect(runtimeTabStyles).toMatch(
      /\.window-drag-surface \{[\s\S]*?-webkit-app-region: drag;/
    );
    expect(runtimeTabStyles).toMatch(
      /body\[data-window-fullscreen="true"\] \.window-drag-surface \{[\s\S]*?-webkit-app-region: no-drag;/
    );
    expect(tokens).toContain('--font-ui: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif');
    expect(styles).not.toContain("@font-face");
  });

  it("keeps count primitives compact without adding nested backdrop filters", () => {
    render(
      <>
        <Badge variant="secondary">12/48</Badge>
        <Button variant="secondary">Launch</Button>
        <NavItem icon={Gamepad2} label="Games" count={120} />
      </>
    );

    const badge = screen.getByText("12/48");
    const button = screen.getByRole("button", { name: "Launch" });
    const navItem = screen.getByRole("button", { name: "Games120" });
    const count = screen.getByText("120");

    expect(badge.className).toContain("ui-badge");
    expect(badge.className).toContain("overflow-hidden");
    expect(badge.className).toContain("text-caption");
    expect(badge.className).not.toContain("backdrop-blur");
    expect(button.className).toContain("text-control");
    expect(navItem.className).toContain("text-control");
    expect(count.className).toContain("count-pill");
    expect(count.className).toContain("text-micro");
    expect(count.className).not.toContain("backdrop-blur");
  });

  it("uses the neutral glass control for Quick Access in sidebars", () => {
    render(<QuickAccessTrigger shortcutLabel="Ctrl+K" t={t} onOpen={() => undefined} />);

    const trigger = screen.getByRole("button", { name: /Quick Open/ });
    const shortcut = screen.getByText("Ctrl+K");

    expect(trigger.className).toContain("app-no-drag");
    expect(trigger.className).toContain("glass-control");
    expect(trigger.className).not.toContain("bg-sidebar-accent/25");
    expect(trigger.className).not.toContain("hover:bg-sidebar-accent/50");
    expect(shortcut.className).toContain("border-border/45");
    expect(shortcut.className).not.toContain("sidebar-border");
  });

  it("keeps on-media launch controls on the dedicated liquid-glass surface", () => {
    const styles = readSourceTreeSync(rendererPath("src", "styles.css"), "utf8");
    render(<Button variant="media">Launch</Button>);

    const launch = screen.getByRole("button", { name: "Launch" });
    expect(launch.className).toContain("role-cover-control");
    expect(launch.className).not.toContain("glass-control");
    expect(styles).toMatch(/\.role-cover-control \{[\s\S]*?linear-gradient\([\s\S]*?var\(--on-media-control\)/);
    expect(styles).toMatch(/\.role-cover-control \{[\s\S]*?backdrop-filter: blur\(var\(--blur-on-media\)\)/);
  });

  it("bases page grids on available content width and fills the dashboard with four stats", () => {
    const styles = readSourceTreeSync(rendererPath("src", "styles.css"), "utf8");
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

  it("reserves Windows caption controls only from the top drag region", () => {
    const styles = readSourceTreeSync(rendererPath("src", "styles.css"), "utf8");

    expect(styles).toContain(
      ':root[data-platform="windows"] .app-content-window-drag-region {\n    right: 138px;\n  }'
    );
    expect(styles).not.toContain(':root[data-platform="windows"] .app-page-header');
    expect(styles).not.toContain(':root[data-platform="windows"] .app-editor-header');
    expect(styles).not.toContain(':root[data-platform="windows"] .liquid-app-shell > header');
    expect(styles).toContain(".app-drag {\n    -webkit-app-region: drag;");
    expect(styles).toContain(
      ':root[data-window-fullscreen="true"] .app-drag {\n    -webkit-app-region: no-drag;'
    );
    expect(styles).toContain(
      ':root[data-window-fullscreen="true"] .app-content-window-drag-region {\n    pointer-events: none;'
    );
  });

  it("fills the Windows caption control group with themed material after page scrolling", () => {
    const bootStyles = readFileSync(rendererPath("src", "boot.css"), "utf8");
    const tokens = readFileSync(path.join(process.cwd(), "src", "shared", "designTokens.css"), "utf8");

    expect(bootStyles).toMatch(
      /:root\[data-platform="windows"\]\[data-window-fullscreen="false"\]\[data-window-controls-scrolled="true"\] \.windows-window-controls \{[\s\S]*?background: hsl\(var\(--windows-caption-scrolled-background\)\);/
    );
    expect(bootStyles).toMatch(
      /data-window-controls-scrolled="true"[\s\S]*?backdrop-filter: blur\(var\(--blur-surface\)\) saturate\(1\.08\);/
    );
    expect(tokens.match(/--windows-caption-scrolled-background:/g)).toHaveLength(2);
  });

  it("reserves backdrop blur for top-level glass surfaces", () => {
    const styles = readSourceTreeSync(rendererPath("src", "styles.css"), "utf8");

    expect(styles).toContain(
      ".glass-panel,\n  .glass-panel-strong,\n  .glass-modal,\n  .glass-popover {\n    -webkit-backdrop-filter: blur(var(--blur-surface)) saturate(1.08);"
    );
    expect(styles).toContain(
      ".glass-control,\n  .glass-control-selected,\n  .glass-inset {\n    -webkit-backdrop-filter: none;"
    );
  });

  it("gives inset editor surfaces a subtle edge against the page material", () => {
    const styles = readSourceTreeSync(rendererPath("src", "styles.css"), "utf8");

    expect(styles).toMatch(
      /\.glass-inset \{[\s\S]*?inset 0 0 4px hsl\(var\(--glass-inner-shadow\)\),\s*0 1px 2px hsl\(var\(--glass-shadow\)\);/
    );
    expect(styles).toMatch(
      /:root\[data-theme="dark"\] \.glass-inset \{[\s\S]*?inset 0 0 6px hsl\(var\(--glass-inner-shadow\)\),\s*0 1px 2px hsl\(var\(--glass-shadow\)\);/
    );
  });

  it("uses selected fills instead of activity-colored outlines for shared controls", () => {
    const styles = readSourceTreeSync(rendererPath("src", "styles.css"), "utf8");
    const patterns = readFileSync(rendererPath("src", "components", "ui", "patterns.tsx"), "utf8");

    expect(styles).not.toContain("--glass-control-ring-selected");
    expect(styles).toMatch(
      /\.glass-control-selected \{[\s\S]*?box-shadow: inset 0 1px 0 hsl\(var\(--glass-highlight-muted\)\);/
    );
    expect(styles).toMatch(
      /\.nav-item-active \{[\s\S]*?box-shadow: inset 0 1px 0 hsl\(var\(--glass-highlight-muted\)\);/
    );
    expect(styles).toContain(".segmented-item-active {\n    border-color: hsl(var(--border) / 0.42);");
    expect(styles).toContain(':root[data-theme="dark"] .segmented-item-active {\n    border-color: hsl(var(--glass-border));');
    expect(styles).not.toMatch(/\.glass-control\.macro-role-card-selected[\s\S]*?border-color: hsl\(var\(--activity\)\)/);
    expect(patterns).toContain('? "glass-control-selected segmented-item-active text-foreground"');
    expect(patterns).toContain('? "nav-item-active text-foreground"');
  });
});
